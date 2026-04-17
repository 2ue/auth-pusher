import type { ChannelConfig } from '../../../shared/types/channel.js';
import * as channelStore from '../persistence/channel.store.js';
import * as accountStore from '../persistence/account.store.js';
import * as tagStore from '../persistence/tag.store.js';
import * as batchStore from '../persistence/batch.store.js';
import { defaultRegistry } from '../pushers/index.js';

/** 同步标签前缀 */
const SYNC_TAG_PREFIX = 'sync:';
/** 远端已删除标签前缀 */
const DELETED_TAG_PREFIX = 'deleted:';
/** 已转移到目标渠道标签前缀 */
const TRANSFERRED_TAG_PREFIX = 'transferred:';

/** 从渠道配置提取连接信息（供外部复用） */
export function extractConnection(channel: ChannelConfig) {
  const cfg = channel.pusherConfig;
  return {
    baseUrl: String(cfg.base_url ?? '').replace(/\/+$/, ''),
    token: String(cfg.token ?? cfg.admin_key ?? ''),
    authMode: String(cfg.auth_mode ?? 'admin_api_key'),
  };
}

/**
 * 从渠道同步账号到本地号池
 *
 * 策略：
 * 1. 按 email 合并（upsert），新增或更新 token
 * 2. 本地有 sync:渠道名 标签但远端已无 → 加 deleted:渠道名 标签
 * 3. 远端重新出现 → 移除 deleted:渠道名 标签
 */
export async function syncFromChannel(channelId: string): Promise<{
  added: number; updated: number; deleted: number; total: number;
}> {
  const channel = channelStore.findChannel(channelId);
  if (!channel) throw new Error('渠道不存在');

  const pusher = defaultRegistry.get(channel.pusherType);
  if (!pusher.canSync()) {
    throw new Error(`渠道类型 ${channel.pusherType} 不支持同步`);
  }

  const syncTag = `${SYNC_TAG_PREFIX}${channel.name}`;
  const deletedTag = `${DELETED_TAG_PREFIX}${channel.name}`;
  const transferredTag = `${TRANSFERRED_TAG_PREFIX}${channel.name}`;

  // 1. 从远端拉取账号
  const remoteAccounts = await pusher.syncAccounts(channel.pusherConfig);
  const remoteEmails = new Set(remoteAccounts.map((a) => a.email.toLowerCase()));

  // 2. 打上来源标签，移除可能存在的 deleted 标签
  for (const acc of remoteAccounts) {
    acc.sourceType = 'remote';
    acc.source = syncTag;
    acc.tags = [...new Set([...(acc.tags ?? []), syncTag])];
    // 远端重新出现后，清理历史状态标签
    acc.tags = acc.tags.filter((t) => t !== deletedTag && t !== transferredTag);
    acc.lastProbe = acc.lastProbe ?? null;
  }

  // 3. Upsert 远端账号到本地
  const result = accountStore.upsertBatch(remoteAccounts);

  // 3.5 创建导入批次
  const batch = batchStore.create({
    source: syncTag,
    sourceType: 'remote',
    channelId,
    totalCount: remoteAccounts.length,
    addedCount: result.added,
    updatedCount: result.updated,
    skippedCount: 0,
  });
  const syncedIds = remoteAccounts
    .map((a) => accountStore.findByEmail(a.email))
    .filter(Boolean)
    .map((a) => a!.id);
  batchStore.setAccountsBatchId(syncedIds, batch.id);

  // 4. 检测本地中"远端已删除"的账号（含已软删除的，以避免 save 丢失）
  const allLocal = accountStore.loadAll(true);
  let deletedCount = 0;
  let changed = false;

  for (const local of allLocal) {
    const tags = local.tags ?? [];
    const belongsToChannel = tags.includes(syncTag);
    if (!belongsToChannel) continue;

    if (!remoteEmails.has(local.email.toLowerCase())) {
      // 远端已删除：加 deleted 标签 + 软删除
      if (!tags.includes(deletedTag)) {
        local.tags = [...tags, deletedTag];
        deletedCount++;
        changed = true;
        accountStore.softDelete(local.id, 'sync_removed');
      }
    } else {
      // 远端存在：移除 deleted / transferred 标签，恢复软删除
      if (tags.includes(deletedTag) || tags.includes(transferredTag)) {
        local.tags = tags.filter((t) => t !== deletedTag && t !== transferredTag);
        changed = true;
        if (local.deletedAt) accountStore.restore(local.id);
      }
    }
  }

  if (changed) accountStore.save(allLocal);

  // 自动收集标签
  tagStore.addAutoCollected([syncTag]);

  return {
    added: result.added,
    updated: result.updated,
    deleted: deletedCount,
    total: remoteAccounts.length,
  };
}

/** 检查渠道是否支持同步 */
export function isSyncable(pusherType: string): boolean {
  if (!defaultRegistry.has(pusherType)) return false;
  return defaultRegistry.get(pusherType).canSync();
}

/** 获取远端账号列表 */
export async function fetchRemoteAccounts(channelId: string) {
  const channel = channelStore.findChannel(channelId);
  if (!channel) throw new Error('渠道不存在');
  const pusher = defaultRegistry.get(channel.pusherType);
  if (!pusher.canFetchRemote()) {
    throw new Error(`渠道类型 ${channel.pusherType} 不支持查看远端账号`);
  }
  return pusher.fetchRemoteAccounts(channel.pusherConfig);
}

/** 检查渠道是否支持查看远端账号 */
export function canFetchRemote(pusherType: string): boolean {
  if (!defaultRegistry.has(pusherType)) return false;
  return defaultRegistry.get(pusherType).canFetchRemote();
}
