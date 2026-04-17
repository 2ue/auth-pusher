/**
 * 账号转移服务
 * 将账号从源渠道推送到目标渠道，可选从源渠道远端删除，本地软删除
 */
import type { Response } from 'express';
import * as accountStore from '../persistence/account.store.js';
import * as channelStore from '../persistence/channel.store.js';
import { defaultRegistry } from '../pushers/index.js';
import { executeRequest } from '../core/request-executor.js';

interface TransferItemResult {
  email: string;
  status: 'pushed' | 'deleted' | 'skipped' | 'push_failed' | 'delete_failed';
  error?: string;
}

function sendSSE(res: Response, data: unknown) {
  try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* connection closed */ }
}

export async function executeTransfer(input: {
  accountIds: string[];
  sourceChannelId: string;
  targetChannelId: string;
}, res: Response) {
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const sourceChannel = channelStore.findChannel(input.sourceChannelId);
  const targetChannel = channelStore.findChannel(input.targetChannelId);
  if (!sourceChannel || !targetChannel) {
    sendSSE(res, { type: 'error', error: '渠道不存在' });
    res.end();
    return;
  }

  const sourcePusher = defaultRegistry.get(sourceChannel.pusherType);
  const targetPusher = defaultRegistry.get(targetChannel.pusherType);

  // Load accounts (include soft-deleted so we can transfer them)
  const allAccounts = accountStore.loadAll(true);
  const accounts = allAccounts.filter(a => input.accountIds.includes(a.id));

  // Get target remote emails for dedup
  let targetRemoteEmails = new Set<string>();
  try {
    if (targetPusher.canFetchRemote()) {
      const remoteAccounts = await targetPusher.fetchRemoteAccounts(targetChannel.pusherConfig);
      targetRemoteEmails = new Set(remoteAccounts.map(a => a.email.toLowerCase()));
    }
  } catch { /* ignore fetch errors, proceed without dedup */ }

  // Get source remote accounts for ID mapping (needed for delete)
  let sourceRemoteMap = new Map<string, string>(); // email -> remote ID
  try {
    if (sourcePusher.canFetchRemote()) {
      const sourceRemote = await sourcePusher.fetchRemoteAccounts(sourceChannel.pusherConfig);
      for (const r of sourceRemote) {
        sourceRemoteMap.set(r.email.toLowerCase(), r.remoteId ?? '');
      }
    }
  } catch { /* ignore */ }

  const total = accounts.length;
  let pushed = 0, deleted = 0, skipped = 0, failed = 0;
  const results: TransferItemResult[] = [];

  sendSSE(res, { type: 'transfer_start', total, sourceChannel: sourceChannel.name, targetChannel: targetChannel.name });

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    const email = account.email.toLowerCase();

    // Step 1: Check if already exists in target
    if (targetRemoteEmails.has(email)) {
      skipped++;
      const item: TransferItemResult = { email: account.email, status: 'skipped', error: '目标号池已存在' };
      results.push(item);
      sendSSE(res, { type: 'item_result', ...item, processed: i + 1, total });
      continue;
    }

    // Step 2: Push to target channel
    try {
      const mappedItem = {
        index: i,
        identifier: account.email,
        fields: {
          email: account.email,
          access_token: account.accessToken,
          refresh_token: account.refreshToken,
          id_token: account.idToken,
          account_id: account.accountId,
          organization_id: account.organizationId,
          plan_type: account.planType,
        },
        valid: true,
        validationErrors: [] as string[],
      };

      const pushRequest = targetPusher.buildRequest(mappedItem, targetChannel.pusherConfig);
      const execResult = await executeRequest(pushRequest);
      const evaluation = targetPusher.evaluateResponse(execResult.statusCode, execResult.body);

      if (!evaluation.ok) {
        failed++;
        const item: TransferItemResult = { email: account.email, status: 'push_failed', error: evaluation.error || `HTTP ${execResult.statusCode}` };
        results.push(item);
        sendSSE(res, { type: 'item_result', ...item, processed: i + 1, total });
        continue;
      }

      pushed++;
      targetRemoteEmails.add(email); // prevent duplicates in same batch

      // Step 3: Delete from source remote
      const remoteId = sourceRemoteMap.get(email) || '';
      if (remoteId && sourcePusher.canDelete()) {
        try {
          const delResult = await sourcePusher.deleteAccount(sourceChannel.pusherConfig, remoteId);
          if (delResult.ok) deleted++;
        } catch { /* ignore delete error */ }
      }

      // Step 4: Local soft delete + tag
      accountStore.softDelete(account.id, 'transfer');
      const tags = [...new Set([...(account.tags || []), `transferred:${targetChannel.name}`])];
      accountStore.updateTags(account.id, tags);

      const item: TransferItemResult = { email: account.email, status: 'pushed' };
      results.push(item);
      sendSSE(res, { type: 'item_result', ...item, processed: i + 1, total });

    } catch (err) {
      failed++;
      const item: TransferItemResult = { email: account.email, status: 'push_failed', error: (err as Error).message };
      results.push(item);
      sendSSE(res, { type: 'item_result', ...item, processed: i + 1, total });
    }

    // Small delay between items
    if (i < accounts.length - 1) await new Promise(r => setTimeout(r, 200));
  }

  sendSSE(res, { type: 'transfer_complete', total, pushed, deleted, skipped, failed });
  res.end();
}
