import type { Response } from 'express';
import type { PushTask, PushTaskItem, PushProgressEvent } from '../../../shared/types/task.js';
import type { MappedDataItem, FieldMapping } from '../../../shared/types/data.js';
import type { ChannelConfig } from '../../../shared/types/channel.js';
import type { Account, AccountQuery } from '../../../shared/types/account.js';
import { nanoid } from 'nanoid';
import { defaultRegistry } from '../pushers/index.js';
import { executeRequest } from '../core/request-executor.js';
import { applyFieldMapping } from '../adapters/field-mapper.js';
import { parseFileContent, detectFileType } from '../adapters/data-parser.js';
import * as taskStore from '../persistence/task.store.js';
import * as channelStore from '../persistence/channel.store.js';
import * as accountStore from '../persistence/account.store.js';
import * as settingsStore from '../persistence/settings.store.js';
import * as fileStore from '../persistence/file.store.js';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../persistence/json-store.js';
import { sendWebhook } from './webhook.service.js';

/** SSE 连接池 */
const sseClients = new Map<string, Set<Response>>();

function sendSSE(taskId: string, event: PushProgressEvent) {
  const clients = sseClients.get(taskId);
  if (!clients) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try { res.write(data); } catch { clients.delete(res); }
  }
}

export function subscribeToTask(taskId: string, res: Response) {
  if (!sseClients.has(taskId)) sseClients.set(taskId, new Set());
  sseClients.get(taskId)!.add(res);
  res.on('close', () => {
    sseClients.get(taskId)?.delete(res);
    if (sseClients.get(taskId)?.size === 0) sseClients.delete(taskId);
  });
}

export interface ExecutePushInput {
  /** 单渠道或多渠道 */
  channelIds: string[];
  /** 数据来源: file 或 pool */
  dataSource: 'file' | 'pool';
  /** file 模式下的 fileId 和映射 */
  fileId?: string;
  /** file 模式下的批次ID（用于关联文件记录） */
  batchId?: string;
  fieldMapping?: FieldMapping;
  /** pool 模式下的筛选条件 */
  accountFilter?: AccountQuery;
  /** pool 模式下指定账号 ID 列表 */
  accountIds?: string[];
  /** 运行时覆盖渠道配置 */
  configOverrides?: Record<string, unknown>;
}

/** 执行推送，支持多渠道，返回所有 taskId */
export async function executePush(input: ExecutePushInput): Promise<{ taskIds: string[] }> {
  const channelIds = input.channelIds;
  if (!channelIds || channelIds.length === 0) throw new Error('至少选择一个渠道');

  // 解析数据项
  const items = resolveDataItems(input);
  if (items.length === 0) throw new Error('没有有效的数据项');

  const taskIds: string[] = [];

  for (const channelId of channelIds) {
    const channel = channelStore.findChannel(channelId);
    if (!channel) throw new Error(`渠道不存在: ${channelId}`);

    const mergedConfig: ChannelConfig = input.configOverrides
      ? { ...channel, pusherConfig: { ...channel.pusherConfig, ...input.configOverrides } }
      : channel;

    const pusher = defaultRegistry.get(mergedConfig.pusherType);

    // 对 pool 模式的数据构建 MappedDataItem
    const mappedItems: MappedDataItem[] = input.dataSource === 'pool'
      ? items.map((item, i) => ({
          index: i,
          identifier: String(item.fields.email ?? `#${i}`),
          fields: item.fields,
          valid: true,
          validationErrors: [],
        }))
      : applyFieldMapping(
          items.map((it, i) => ({ index: i, fields: it.fields })),
          input.fieldMapping ?? {},
          pusher.schema.requiredDataFields,
        );

    const validItems = mappedItems.filter((i) => i.valid);
    const invalidItems = mappedItems.filter((i) => !i.valid);

    const task: PushTask = {
      id: nanoid(12),
      channelId: channel.id,
      channelName: channel.name,
      pusherType: channel.pusherType,
      status: 'running',
      totalItems: mappedItems.length,
      successCount: 0,
      failedCount: invalidItems.length,
      createdAt: new Date().toISOString(),
      items: mappedItems.map((item) => ({
        index: item.index,
        identifier: item.identifier,
        status: item.valid ? 'pending' as const : 'skipped' as const,
        pushResult: item.valid ? undefined : {
          ok: false, statusCode: 0, externalId: '', error: item.validationErrors.join('; '),
          durationMs: 0, responseBody: {},
        },
      })),
    };

    taskStore.saveTask(task);
    taskIds.push(task.id);

    // 关联文件记录（按批次）
    if (input.dataSource === 'file' && input.batchId) {
      fileStore.addTaskAssociation(input.batchId, task.id);
    }

    // 异步执行
    executePushAsync(task, validItems, mergedConfig, input.dataSource === 'pool').catch(() => {
      task.status = 'failed';
      task.completedAt = new Date().toISOString();
      taskStore.saveTask(task);
      sendSSE(task.id, {
        type: 'task_error', taskId: task.id,
        summary: { total: task.totalItems, success: task.successCount, failed: task.failedCount },
      });
    });
  }

  return { taskIds };
}

/** 解析数据项 */
function resolveDataItems(input: ExecutePushInput): { fields: Record<string, unknown> }[] {
  if (input.dataSource === 'pool') {
    let accounts: Account[];
    if (input.accountIds && input.accountIds.length > 0) {
      const all = accountStore.loadAll();
      const idSet = new Set(input.accountIds);
      accounts = all.filter((a) => idSet.has(a.id));
    } else {
      accounts = accountStore.query(input.accountFilter ?? {});
    }
    return accounts.map((a) => ({
      fields: {
        email: a.email,
        access_token: a.accessToken,
        refresh_token: a.refreshToken,
        id_token: a.idToken,
        account_id: a.accountId,
        organization_id: a.organizationId,
        plan_type: a.planType,
      },
    }));
  }

  // file 模式
  if (!input.fileId) throw new Error('缺少 fileId');
  const filePath = path.join(getDataDir(), 'uploads', input.fileId);
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${input.fileId}`);
  const content = fs.readFileSync(filePath, 'utf-8');
  const fileType = detectFileType(input.fileId);
  const { records } = parseFileContent(content, fileType);
  return records.map((r) => ({ fields: r.fields }));
}

async function executePushAsync(
  task: PushTask,
  items: MappedDataItem[],
  channel: ChannelConfig,
  isPoolMode: boolean,
) {
  const pusher = defaultRegistry.get(channel.pusherType);
  const settings = settingsStore.load();

  // 渠道级覆盖优先于全局设置
  const delayMs = channel.pushIntervalMs ?? settings.pushIntervalMs;
  const concurrency = Math.max(1, channel.pushConcurrency ?? settings.pushConcurrency);

  const semaphore = createSemaphore(concurrency);

  const promises = items.map((item) =>
    semaphore.acquire().then(async (release) => {
      try {
        await pushSingleItem(task, item, channel, pusher, isPoolMode);
      } finally {
        taskStore.saveTask(task);
        if (delayMs > 0) await sleep(delayMs);
        release();
      }
    }),
  );

  await Promise.all(promises);

  task.status = 'completed';
  task.completedAt = new Date().toISOString();
  taskStore.saveTask(task);

  sendSSE(task.id, {
    type: 'task_complete', taskId: task.id,
    summary: { total: task.totalItems, success: task.successCount, failed: task.failedCount },
  });

  // Webhook 通知
  void sendWebhook({
    event: task.failedCount > 0 && task.successCount === 0 ? 'task_failed' : 'task_complete',
    taskId: task.id,
    channelName: task.channelName,
    pusherType: task.pusherType,
    total: task.totalItems,
    success: task.successCount,
    failed: task.failedCount,
    completedAt: task.completedAt!,
  });
}

async function pushSingleItem(
  task: PushTask,
  item: MappedDataItem,
  channel: ChannelConfig,
  pusher: ReturnType<typeof defaultRegistry.get>,
  isPoolMode: boolean,
) {
  const taskItem = task.items.find((t) => t.index === item.index)!;
  taskItem.status = 'pushing';

  sendSSE(task.id, {
    type: 'item_start', taskId: task.id,
    itemIndex: item.index, identifier: item.identifier,
  });

  try {
    const request = pusher.buildRequest(item, channel.pusherConfig);
    const result = await executeRequest(request);
    const evaluation = pusher.evaluateResponse(result.statusCode, result.body);

    taskItem.status = evaluation.ok ? 'success' : 'failed';
    taskItem.pushResult = {
      ok: evaluation.ok, statusCode: result.statusCode,
      externalId: evaluation.externalId, error: evaluation.error,
      durationMs: result.durationMs, responseBody: result.body,
    };

    if (evaluation.ok) task.successCount++;
    else task.failedCount++;

    // pool 模式下记录推送历史到账号
    if (isPoolMode) {
      accountStore.recordPushResult(item.identifier, {
        channelId: channel.id, channelName: channel.name,
        taskId: task.id, status: evaluation.ok ? 'success' : 'failed',
      });
    }
  } catch (err) {
    taskItem.status = 'failed';
    taskItem.pushResult = {
      ok: false, statusCode: 0, externalId: '',
      error: err instanceof Error ? err.message : String(err),
      durationMs: 0, responseBody: {},
    };
    task.failedCount++;
  }

  sendSSE(task.id, {
    type: 'item_complete', taskId: task.id,
    itemIndex: item.index, identifier: item.identifier,
    result: taskItem.pushResult,
  });
}

/** 简易信号量（无需外部依赖） */
function createSemaphore(max: number) {
  let current = 0;
  const queue: Array<() => void> = [];
  return {
    acquire(): Promise<() => void> {
      return new Promise((resolve) => {
        const tryAcquire = () => {
          if (current < max) {
            current++;
            resolve(() => {
              current--;
              if (queue.length > 0) queue.shift()!();
            });
          } else {
            queue.push(tryAcquire);
          }
        };
        tryAcquire();
      });
    },
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
