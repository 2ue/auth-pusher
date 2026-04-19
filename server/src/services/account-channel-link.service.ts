import type { Account } from '../../../shared/types/account.js';
import type { ChannelConfig } from '../../../shared/types/channel.js';
import * as accountStore from '../persistence/account.store.js';
import * as batchStore from '../persistence/batch.store.js';
import * as channelStore from '../persistence/channel.store.js';

const SYNC_TAG_PREFIX = 'sync:';
const DELETED_TAG_PREFIX = 'deleted:';

interface NormalizeOptions {
  channelId?: string;
  previousName?: string;
}

export function hydrateAccountChannelLinks(): number {
  return normalizeAccountChannelLinks({});
}

export function syncAccountChannelLinksForChannel(channelId: string, previousName?: string): number {
  return normalizeAccountChannelLinks({ channelId, previousName });
}

function normalizeAccountChannelLinks(options: NormalizeOptions): number {
  const channels = channelStore.loadChannels();
  if (channels.length === 0) return 0;

  const channelsById = new Map(channels.map((channel) => [channel.id, channel]));
  const channelsByName = new Map(channels.map((channel) => [channel.name, channel]));
  const batchChannelIds = new Map(
    batchStore.findAll()
      .filter((batch) => batch.channelId)
      .map((batch) => [batch.id, batch.channelId]),
  );

  const accounts = accountStore.loadAll(true);
  let changedCount = 0;

  for (const account of accounts) {
    const updated = normalizeAccount(account, channelsById, channelsByName, batchChannelIds, options);
    if (!updated) continue;

    Object.assign(account, updated);
    changedCount += 1;
  }

  if (changedCount > 0) accountStore.save(accounts);
  return changedCount;
}

function normalizeAccount(
  account: Account,
  channelsById: Map<string, ChannelConfig>,
  channelsByName: Map<string, ChannelConfig>,
  batchChannelIds: Map<string, string>,
  options: NormalizeOptions,
): Partial<Account> | null {
  const scopedChannel = options.channelId ? channelsById.get(options.channelId) : undefined;
  const batchChannelId = account.batchId ? batchChannelIds.get(account.batchId) : undefined;

  let sourceChannelId = resolveSourceChannelId(account, channelsById, channelsByName, batchChannelId);

  if (scopedChannel) {
    const matchesScopedChannel =
      sourceChannelId === scopedChannel.id
      || batchChannelId === scopedChannel.id
      || matchesChannelName(account, scopedChannel.name)
      || (options.previousName ? matchesChannelName(account, options.previousName) : false);

    if (!matchesScopedChannel) return null;
    sourceChannelId = scopedChannel.id;
  }

  if (!sourceChannelId) return null;

  const channel = channelsById.get(sourceChannelId);
  if (!channel) return null;

  const hasSyncTag = hasSystemTag(account.tags, SYNC_TAG_PREFIX);
  const hasDeletedTag = hasSystemTag(account.tags, DELETED_TAG_PREFIX);
  const shouldMarkAsSynced =
    account.sourceType === 'remote'
    || Boolean(account.sourceChannelId)
    || Boolean(batchChannelId)
    || hasSyncTag
    || matchesSourcePrefix(account.source, SYNC_TAG_PREFIX);

  const preservedTags = (account.tags ?? []).filter(
    (tag) => !tag.startsWith(SYNC_TAG_PREFIX) && !tag.startsWith(DELETED_TAG_PREFIX),
  );
  const nextTags = [...preservedTags];

  if (shouldMarkAsSynced) nextTags.unshift(`${SYNC_TAG_PREFIX}${channel.name}`);
  if (hasDeletedTag || (account.deleteReason === 'sync_removed' && !!account.deletedAt)) {
    nextTags.push(`${DELETED_TAG_PREFIX}${channel.name}`);
  }

  const normalizedTags = [...new Set(nextTags)];
  const nextSource = shouldMarkAsSynced ? `${SYNC_TAG_PREFIX}${channel.name}` : account.source;

  const updates: Partial<Account> = {};

  if ((account.sourceChannelId ?? '') !== channel.id) updates.sourceChannelId = channel.id;
  if (nextSource !== account.source) updates.source = nextSource;
  if (!areStringArraysEqual(account.tags ?? [], normalizedTags)) updates.tags = normalizedTags;

  return Object.keys(updates).length > 0 ? updates : null;
}

function resolveSourceChannelId(
  account: Account,
  channelsById: Map<string, ChannelConfig>,
  channelsByName: Map<string, ChannelConfig>,
  batchChannelId?: string,
): string | undefined {
  if (account.sourceChannelId && channelsById.has(account.sourceChannelId)) return account.sourceChannelId;
  if (batchChannelId && channelsById.has(batchChannelId)) return batchChannelId;

  const matchedByTag = (account.tags ?? [])
    .find((tag) => tag.startsWith(SYNC_TAG_PREFIX))
    ?.slice(SYNC_TAG_PREFIX.length);
  if (matchedByTag) return channelsByName.get(matchedByTag)?.id;

  if (matchesSourcePrefix(account.source, SYNC_TAG_PREFIX)) {
    return channelsByName.get(account.source.slice(SYNC_TAG_PREFIX.length))?.id;
  }

  return undefined;
}

function matchesChannelName(account: Account, channelName: string): boolean {
  return (account.tags ?? []).some((tag) => tag === `${SYNC_TAG_PREFIX}${channelName}` || tag === `${DELETED_TAG_PREFIX}${channelName}`)
    || account.source === `${SYNC_TAG_PREFIX}${channelName}`;
}

function hasSystemTag(tags: string[] | undefined, prefix: string): boolean {
  return (tags ?? []).some((tag) => tag.startsWith(prefix));
}

function matchesSourcePrefix(source: string | undefined, prefix: string): boolean {
  return String(source ?? '').startsWith(prefix);
}

function areStringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}
