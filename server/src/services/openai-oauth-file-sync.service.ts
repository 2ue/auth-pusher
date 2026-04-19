import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { Account } from '../../../shared/types/account.js';
import type { ChannelConfig } from '../../../shared/types/channel.js';
import type { RemoteAccountFull } from '../core/base-pusher.js';
import * as accountStore from '../persistence/account.store.js';
import * as channelStore from '../persistence/channel.store.js';
import * as fileStateStore from '../persistence/openai-oauth-file-state.store.js';
import { defaultRegistry } from '../pushers/index.js';
import {
  getOpenAiOAuthOutputDir,
  type OpenAiOAuthCapturedJson,
  type OpenAiOAuthSavedFile,
} from './openai-oauth-capture.service.js';
import {
  decodeIdTokenEmail,
  decodeIdTokenOrg,
  decodeJwtPayload,
  decodeOpenAiJwt,
  resolvePlanTypeFromTokens,
} from '../utils/jwt.js';

const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

export type OpenAiOAuthJsonFormat = 'auth-pusher' | 'team-auto';
export type OpenAiOAuthMatchStatus =
  | 'matched'
  | 'unmatched'
  | 'ambiguous'
  | 'unsupported_channel'
  | 'remote_missing'
  | 'channel_error'
  | 'parse_error';

export type OpenAiOAuthSyncStatus =
  | 'parse_error'
  | 'pending_match'
  | 'ready'
  | 'synced'
  | 'unmatched'
  | 'ambiguous'
  | 'remote_missing'
  | 'unsupported_channel'
  | 'channel_error';

export interface NormalizedOpenAiOAuthJson {
  format: OpenAiOAuthJsonFormat;
  email: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  organizationId: string;
  planType: string;
  clientId: string;
  userId: string;
  expiredAt: string;
  raw: Record<string, unknown>;
}

export interface ManagedOpenAiOAuthFile extends OpenAiOAuthSavedFile {
  format?: OpenAiOAuthJsonFormat;
  planType?: string;
  parseOk: boolean;
  parseError?: string;
  localAccountId?: string;
  matchedChannelId?: string;
  matchedChannelName?: string;
  matchedRemoteId?: string;
  matchStatus?: OpenAiOAuthMatchStatus;
  matchError?: string;
  syncStatus: OpenAiOAuthSyncStatus;
  canRemoteUpdate: boolean;
  lastMatchedAt?: string;
  lastRemoteUpdatedAt?: string;
  lastRemoteUpdateStatus?: string;
  lastRemoteUpdateError?: string;
}

export interface OpenAiOAuthManagedFilesResult {
  directory: string;
  files: ManagedOpenAiOAuthFile[];
}

export interface OpenAiOAuthImportFilesResult {
  imported: number;
  failed: number;
  files: Array<{
    originalName: string;
    status: 'imported' | 'failed';
    email?: string;
    path?: string;
    error?: string;
  }>;
}

export interface OpenAiOAuthMatchResult {
  matched: number;
  unmatched: number;
  ambiguous: number;
  failed: number;
  files: ManagedOpenAiOAuthFile[];
}

export interface OpenAiOAuthUpdateResult {
  dryRun: boolean;
  updated: number;
  skipped: number;
  failed: number;
  items: Array<{
    path: string;
    email: string;
    status: 'updated' | 'would_update' | 'skipped' | 'failed';
    channelName?: string;
    remoteId?: string;
    error?: string;
  }>;
}

interface ParsedOpenAiOAuthFile {
  savedFile: OpenAiOAuthSavedFile;
  normalized?: NormalizedOpenAiOAuthJson;
  contentHash?: string;
  parseError?: string;
  state?: fileStateStore.OpenAiOAuthFileState;
}

interface MatchOutcome {
  localAccount?: Account;
  matchedChannel?: ChannelConfig;
  matchedRemote?: RemoteAccountFull;
  status: OpenAiOAuthMatchStatus;
  error?: string;
}

type RemoteCacheEntry =
  | { ok: true; accounts: RemoteAccountFull[] }
  | { ok: false; error: string };

export function parseOpenAiOAuthJsonContent(content: string, label = 'JSON'): NormalizedOpenAiOAuthJson {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error(`${label} 不是有效的 JSON`);
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label} 必须是对象 JSON`);
  }

  const data = raw as Record<string, unknown>;
  const accessToken = pickString(data, 'access_token', 'accessToken');
  const refreshToken = pickString(data, 'refresh_token', 'refreshToken');
  const idToken = pickString(data, 'id_token', 'idToken');

  if (!accessToken) throw new Error(`${label} 缺少 access_token`);

  const accessClaims = decodeOpenAiJwt(accessToken);
  const accessPayload = decodeJwtPayload(accessToken) ?? {};
  const idClaims = decodeJwtPayload(idToken) ?? {};
  const idAuth = (idClaims['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;

  const email = pickString(data, 'email') || accessClaims.email || decodeIdTokenEmail(idToken);
  if (!email) throw new Error(`${label} 无法解析邮箱`);

  const accountId = pickString(data, 'account_id', 'accountId')
    || accessClaims.accountId
    || pickString(idAuth, 'chatgpt_account_id');
  const organizationId = pickString(data, 'organization_id', 'organizationId')
    || decodeIdTokenOrg(idToken)
    || accessClaims.organizationId;
  const planType = pickString(data, 'plan_type', 'planType')
    || resolvePlanTypeFromTokens(accessToken, idToken);
  const expiredAt = pickString(data, 'expired_at', 'expires_at', 'expired')
    || (accessClaims.exp > 0 ? new Date(accessClaims.exp * 1000).toISOString() : '');
  const clientId = pickString(data, 'client_id', 'clientId')
    || pickString(accessPayload, 'client_id')
    || OPENAI_OAUTH_CLIENT_ID;
  const userId = pickString(data, 'chatgpt_user_id', 'user_id', 'userId')
    || accessClaims.userId
    || pickString(idAuth, 'chatgpt_user_id');

  const format: OpenAiOAuthJsonFormat = (
    Object.prototype.hasOwnProperty.call(data, 'last_refresh')
    || Object.prototype.hasOwnProperty.call(data, 'expired')
    || pickString(data, 'type') === 'codex'
  )
    ? 'team-auto'
    : 'auth-pusher';

  return {
    format,
    email,
    accessToken,
    refreshToken,
    idToken,
    accountId,
    organizationId,
    planType,
    clientId,
    userId,
    expiredAt,
    raw: data,
  };
}

export function normalizeToCapturedJson(record: NormalizedOpenAiOAuthJson): OpenAiOAuthCapturedJson {
  return {
    email: record.email,
    access_token: record.accessToken,
    refresh_token: record.refreshToken || undefined,
    id_token: record.idToken || undefined,
    account_id: record.accountId || undefined,
    organization_id: record.organizationId || undefined,
    plan_type: record.planType || undefined,
  };
}

export function saveNormalizedOpenAiOAuthJson(record: NormalizedOpenAiOAuthJson): OpenAiOAuthSavedFile {
  return writeManagedJsonFile(record.email, normalizeToCapturedJson(record));
}

export function importOpenAiOAuthJsonFiles(inputs: Array<{ originalName: string; content: string }>): OpenAiOAuthImportFilesResult {
  const files: OpenAiOAuthImportFilesResult['files'] = [];
  let imported = 0;
  let failed = 0;

  for (const input of inputs) {
    try {
      const normalized = parseOpenAiOAuthJsonContent(input.content, input.originalName);
      const savedFile = saveNormalizedOpenAiOAuthJson(normalized);
      imported += 1;
      files.push({
        originalName: input.originalName,
        status: 'imported',
        email: normalized.email,
        path: savedFile.path,
      });
    } catch (err) {
      failed += 1;
      files.push({
        originalName: input.originalName,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { imported, failed, files };
}

export function listManagedOpenAiOAuthFiles(): OpenAiOAuthManagedFilesResult {
  const directory = getOpenAiOAuthOutputDir();
  const files = fs.readdirSync(directory)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .map((filename) => toSavedFile(path.join(directory, filename)))
    .map((savedFile) => toManagedFile(readOpenAiOAuthFile(savedFile)))
    .sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));

  return { directory, files };
}

export async function matchManagedOpenAiOAuthFiles(filePaths: string[]): Promise<OpenAiOAuthMatchResult> {
  const selected = resolveSelectedFiles(filePaths);
  const remoteCache = new Map<string, Promise<RemoteCacheEntry>>();
  const files: ManagedOpenAiOAuthFile[] = [];
  let matched = 0;
  let unmatched = 0;
  let ambiguous = 0;
  let failed = 0;

  for (const item of selected) {
    if (!item.normalized || !item.contentHash) {
      fileStateStore.upsert({
        path: item.savedFile.path,
        email: item.savedFile.email,
        contentHash: item.contentHash ?? '',
        matchStatus: 'parse_error',
        matchError: item.parseError ?? 'JSON 解析失败',
        lastMatchedAt: new Date().toISOString(),
      });
      files.push(toManagedFile({ ...item, state: fileStateStore.findByPath(item.savedFile.path) }));
      failed += 1;
      continue;
    }

    const outcome = await resolveMatch(item.normalized, remoteCache);
    fileStateStore.upsert({
      path: item.savedFile.path,
      email: item.normalized.email,
      contentHash: item.contentHash,
      matchedAccountId: outcome.localAccount?.id,
      matchedChannelId: outcome.matchedChannel?.id,
      matchedChannelName: outcome.matchedChannel?.name,
      matchedRemoteId: outcome.matchedRemote?.remoteId,
      matchStatus: outcome.status,
      matchError: outcome.error ?? '',
      lastMatchedAt: new Date().toISOString(),
    });

    if (outcome.status === 'matched') matched += 1;
    else if (outcome.status === 'ambiguous') ambiguous += 1;
    else if (outcome.status === 'parse_error') failed += 1;
    else unmatched += 1;

    files.push(toManagedFile({ ...item, state: fileStateStore.findByPath(item.savedFile.path) }));
  }

  return { matched, unmatched, ambiguous, failed, files };
}

export async function updateMatchedRemoteFiles(input: {
  filePaths: string[];
  dryRun?: boolean;
}): Promise<OpenAiOAuthUpdateResult> {
  const dryRun = input.dryRun === true;
  const selected = resolveSelectedFiles(input.filePaths);
  const remoteCache = new Map<string, Promise<RemoteCacheEntry>>();
  const items: OpenAiOAuthUpdateResult['items'] = [];
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of selected) {
    const labelEmail = item.normalized?.email || item.savedFile.email;
    if (!item.normalized || !item.contentHash) {
      fileStateStore.upsert({
        path: item.savedFile.path,
        email: labelEmail,
        contentHash: item.contentHash ?? '',
        matchStatus: 'parse_error',
        matchError: item.parseError ?? 'JSON 解析失败',
        lastMatchedAt: new Date().toISOString(),
      });
      items.push({
        path: item.savedFile.path,
        email: labelEmail,
        status: 'failed',
        error: item.parseError ?? 'JSON 解析失败',
      });
      failed += 1;
      continue;
    }

    const outcome = await resolveMatch(item.normalized, remoteCache);
    const state = fileStateStore.upsert({
      path: item.savedFile.path,
      email: item.normalized.email,
      contentHash: item.contentHash,
      matchedAccountId: outcome.localAccount?.id,
      matchedChannelId: outcome.matchedChannel?.id,
      matchedChannelName: outcome.matchedChannel?.name,
      matchedRemoteId: outcome.matchedRemote?.remoteId,
      matchStatus: outcome.status,
      matchError: outcome.error ?? '',
      lastMatchedAt: new Date().toISOString(),
    });

    if (outcome.status !== 'matched' || !outcome.matchedChannel || !outcome.matchedRemote?.remoteId) {
      items.push({
        path: item.savedFile.path,
        email: item.normalized.email,
        status: 'failed',
        error: outcome.error ?? '未能匹配到可更新的远端号池',
      });
      failed += 1;
      continue;
    }

    if (state.lastRemoteUpdateHash === item.contentHash && state.lastRemoteUpdateStatus === 'success') {
      items.push({
        path: item.savedFile.path,
        email: item.normalized.email,
        status: 'skipped',
        channelName: outcome.matchedChannel.name,
        remoteId: outcome.matchedRemote.remoteId,
        error: 'JSON 未变化，已禁止重复远端更新',
      });
      skipped += 1;
      continue;
    }

    const pusher = defaultRegistry.get(outcome.matchedChannel.pusherType);
    if (!pusher.canUpdateRemote()) {
      items.push({
        path: item.savedFile.path,
        email: item.normalized.email,
        status: 'failed',
        channelName: outcome.matchedChannel.name,
        remoteId: outcome.matchedRemote.remoteId,
        error: `渠道类型 ${outcome.matchedChannel.pusherType} 暂不支持远端更新`,
      });
      failed += 1;
      continue;
    }

    if (dryRun) {
      items.push({
        path: item.savedFile.path,
        email: item.normalized.email,
        status: 'would_update',
        channelName: outcome.matchedChannel.name,
        remoteId: outcome.matchedRemote.remoteId,
      });
      skipped += 1;
      continue;
    }

    const result = await pusher.updateRemoteAccount(
      outcome.matchedChannel.pusherConfig,
      outcome.matchedRemote.remoteId,
      {
        email: item.normalized.email,
        accessToken: item.normalized.accessToken,
        refreshToken: item.normalized.refreshToken || undefined,
        idToken: item.normalized.idToken || undefined,
        accountId: item.normalized.accountId || undefined,
        organizationId: item.normalized.organizationId || undefined,
        planType: item.normalized.planType || undefined,
        clientId: item.normalized.clientId || undefined,
        userId: item.normalized.userId || undefined,
        expiredAt: item.normalized.expiredAt || undefined,
      },
    );

    if (!result.ok) {
      fileStateStore.upsert({
        path: item.savedFile.path,
        email: item.normalized.email,
        contentHash: item.contentHash,
        matchedAccountId: outcome.localAccount?.id,
        matchedChannelId: outcome.matchedChannel.id,
        matchedChannelName: outcome.matchedChannel.name,
        matchedRemoteId: outcome.matchedRemote.remoteId,
        matchStatus: 'matched',
        matchError: '',
        lastMatchedAt: new Date().toISOString(),
        lastRemoteUpdateStatus: 'failed',
        lastRemoteUpdateError: result.error ?? '远端更新失败',
      });
      items.push({
        path: item.savedFile.path,
        email: item.normalized.email,
        status: 'failed',
        channelName: outcome.matchedChannel.name,
        remoteId: outcome.matchedRemote.remoteId,
        error: result.error ?? '远端更新失败',
      });
      failed += 1;
      continue;
    }

    const localAccount = buildLocalPoolAccount(item.normalized, outcome.matchedChannel, outcome.matchedRemote);
    accountStore.upsertBatch([localAccount]);
    fileStateStore.upsert({
      path: item.savedFile.path,
      email: item.normalized.email,
      contentHash: item.contentHash,
      matchedAccountId: accountStore.findByEmail(item.normalized.email)?.id,
      matchedChannelId: outcome.matchedChannel.id,
      matchedChannelName: outcome.matchedChannel.name,
      matchedRemoteId: outcome.matchedRemote.remoteId,
      matchStatus: 'matched',
      matchError: '',
      lastMatchedAt: new Date().toISOString(),
      lastRemoteUpdateHash: item.contentHash,
      lastRemoteUpdatedAt: new Date().toISOString(),
      lastRemoteUpdateStatus: 'success',
      lastRemoteUpdateError: '',
    });

    items.push({
      path: item.savedFile.path,
      email: item.normalized.email,
      status: 'updated',
      channelName: outcome.matchedChannel.name,
      remoteId: outcome.matchedRemote.remoteId,
    });
    updated += 1;
  }

  return { dryRun, updated, skipped, failed, items };
}

function resolveSelectedFiles(filePaths: string[]): ParsedOpenAiOAuthFile[] {
  const outputDir = path.resolve(getOpenAiOAuthOutputDir());
  const seen = new Set<string>();
  const selected: ParsedOpenAiOAuthFile[] = [];

  for (const filePath of filePaths) {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) continue;
    const relative = path.relative(outputDir, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if (!fs.existsSync(resolved) || !resolved.toLowerCase().endsWith('.json')) continue;
    seen.add(resolved);
    selected.push(readOpenAiOAuthFile(toSavedFile(resolved)));
  }

  return selected;
}

function readOpenAiOAuthFile(savedFile: OpenAiOAuthSavedFile): ParsedOpenAiOAuthFile {
  const state = fileStateStore.findByPath(savedFile.path);
  try {
    const content = fs.readFileSync(savedFile.path, 'utf-8');
    const normalized = parseOpenAiOAuthJsonContent(content, savedFile.filename);
    return {
      savedFile,
      normalized,
      contentHash: computeNormalizedHash(normalized),
      state,
    };
  } catch (err) {
    return {
      savedFile,
      parseError: err instanceof Error ? err.message : String(err),
      state,
    };
  }
}

function toManagedFile(parsed: ParsedOpenAiOAuthFile): ManagedOpenAiOAuthFile {
  const state = parsed.state;
  const matchStatus = (state?.matchStatus || undefined) as OpenAiOAuthMatchStatus | undefined;
  const hasSuccessfulRemoteSync = Boolean(
    parsed.contentHash
    && state?.lastRemoteUpdateStatus === 'success'
    && state.lastRemoteUpdateHash === parsed.contentHash,
  );

  let syncStatus: OpenAiOAuthSyncStatus = 'pending_match';
  if (parsed.parseError) syncStatus = 'parse_error';
  else if (matchStatus === 'matched' && state?.matchedRemoteId) syncStatus = hasSuccessfulRemoteSync ? 'synced' : 'ready';
  else if (matchStatus === 'unmatched') syncStatus = 'unmatched';
  else if (matchStatus === 'ambiguous') syncStatus = 'ambiguous';
  else if (matchStatus === 'remote_missing') syncStatus = 'remote_missing';
  else if (matchStatus === 'unsupported_channel') syncStatus = 'unsupported_channel';
  else if (matchStatus === 'channel_error') syncStatus = 'channel_error';

  return {
    ...parsed.savedFile,
    email: parsed.normalized?.email ?? parsed.savedFile.email,
    format: parsed.normalized?.format,
    planType: parsed.normalized?.planType || undefined,
    parseOk: !parsed.parseError,
    parseError: parsed.parseError || undefined,
    localAccountId: state?.matchedAccountId || accountStore.findByEmail(parsed.normalized?.email ?? parsed.savedFile.email)?.id,
    matchedChannelId: state?.matchedChannelId,
    matchedChannelName: state?.matchedChannelName,
    matchedRemoteId: state?.matchedRemoteId,
    matchStatus,
    matchError: state?.matchError,
    syncStatus,
    canRemoteUpdate: syncStatus === 'ready',
    lastMatchedAt: state?.lastMatchedAt,
    lastRemoteUpdatedAt: state?.lastRemoteUpdatedAt,
    lastRemoteUpdateStatus: state?.lastRemoteUpdateStatus,
    lastRemoteUpdateError: state?.lastRemoteUpdateError,
  };
}

async function resolveMatch(
  record: NormalizedOpenAiOAuthJson,
  remoteCache: Map<string, Promise<RemoteCacheEntry>>,
): Promise<MatchOutcome> {
  const email = record.email.toLowerCase();
  const localAccount = accountStore.findByEmail(record.email);
  const linkedChannelId = localAccount?.sourceChannelId;

  if (linkedChannelId) {
    const channel = channelStore.findChannel(linkedChannelId);
    if (!channel) {
      return {
        localAccount: localAccount ?? undefined,
        status: 'unmatched',
        error: `来源渠道不存在: ${linkedChannelId}`,
      };
    }

    const pusher = defaultRegistry.get(channel.pusherType);
    if (!pusher.canUpdateRemote()) {
      return {
        localAccount,
        matchedChannel: channel,
        status: 'unsupported_channel',
        error: `渠道 ${channel.name} (${channel.pusherType}) 暂不支持远端更新`,
      };
    }

    const remoteEntry = await loadRemoteAccounts(channel, remoteCache);
    if (!remoteEntry.ok) {
      return {
        localAccount,
        matchedChannel: channel,
        status: 'channel_error',
        error: `${channel.name} 拉取远端账号失败: ${remoteEntry.error}`,
      };
    }

    const remote = remoteEntry.accounts.find((item) => item.email.toLowerCase() === email);
    if (!remote?.remoteId) {
      return {
        localAccount,
        matchedChannel: channel,
        status: 'remote_missing',
        error: `${record.email} 未在远端号池 ${channel.name} 中找到`,
      };
    }

    return { localAccount, matchedChannel: channel, matchedRemote: remote, status: 'matched' };
  }

  const channels = channelStore.loadChannels()
    .filter((channel) => {
      if (!defaultRegistry.has(channel.pusherType)) return false;
      const pusher = defaultRegistry.get(channel.pusherType);
      return pusher.canFetchRemote() && pusher.canUpdateRemote();
    });

  const candidates: Array<{ channel: ChannelConfig; remote: RemoteAccountFull }> = [];
  const errors: string[] = [];

  await Promise.all(channels.map(async (channel) => {
    const remoteEntry = await loadRemoteAccounts(channel, remoteCache);
    if (!remoteEntry.ok) {
      errors.push(`${channel.name}: ${remoteEntry.error}`);
      return;
    }
    const remote = remoteEntry.accounts.find((item) => item.email.toLowerCase() === email);
    if (remote?.remoteId) candidates.push({ channel, remote });
  }));

  if (candidates.length === 1) {
    return {
      localAccount: localAccount ?? undefined,
      matchedChannel: candidates[0].channel,
      matchedRemote: candidates[0].remote,
      status: 'matched',
    };
  }

  if (candidates.length > 1) {
    return {
      localAccount: localAccount ?? undefined,
      status: 'ambiguous',
      error: `邮箱同时命中多个远端号池: ${candidates.map((item) => item.channel.name).join(', ')}`,
    };
  }

  return {
    localAccount: localAccount ?? undefined,
    status: 'unmatched',
    error: errors.length > 0
      ? `未找到匹配号池；同时有渠道拉取失败: ${errors.join(' | ')}`
      : `未找到 ${record.email} 对应的远端号池`,
  };
}

function loadRemoteAccounts(
  channel: ChannelConfig,
  remoteCache: Map<string, Promise<RemoteCacheEntry>>,
): Promise<RemoteCacheEntry> {
  const existing = remoteCache.get(channel.id);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const pusher = defaultRegistry.get(channel.pusherType);
      const accounts = await pusher.fetchRemoteAccounts(channel.pusherConfig);
      return { ok: true, accounts } satisfies RemoteCacheEntry;
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies RemoteCacheEntry;
    }
  })();

  remoteCache.set(channel.id, promise);
  return promise;
}

function buildLocalPoolAccount(
  record: NormalizedOpenAiOAuthJson,
  channel: ChannelConfig,
  remote: RemoteAccountFull,
): Account {
  const syncTag = `sync:${channel.name}`;
  return {
    id: nanoid(12),
    email: record.email,
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    idToken: record.idToken,
    accountId: record.accountId,
    organizationId: record.organizationId,
    planType: record.planType,
    tags: [syncTag],
    disabled: remote.disabled,
    expiredAt: record.expiredAt,
    sourceType: 'remote',
    source: syncTag,
    sourceChannelId: channel.id,
    importedAt: new Date().toISOString(),
    pushHistory: [],
    lastProbe: null,
  };
}

function writeManagedJsonFile(email: string, record: OpenAiOAuthCapturedJson): OpenAiOAuthSavedFile {
  const outputDir = getOpenAiOAuthOutputDir();
  const filename = sanitizeEmailFilename(email);
  const filePath = path.join(outputDir, filename);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(record, null, 2), 'utf-8');
  fs.renameSync(tempPath, filePath);

  const stat = fs.statSync(filePath);
  return {
    filename,
    email,
    path: filePath,
    savedAt: stat.mtime.toISOString(),
    sizeBytes: stat.size,
  };
}

function toSavedFile(filePath: string): OpenAiOAuthSavedFile {
  const stat = fs.statSync(filePath);
  return {
    filename: path.basename(filePath),
    email: path.basename(filePath).replace(/\.json$/i, ''),
    path: filePath,
    savedAt: stat.mtime.toISOString(),
    sizeBytes: stat.size,
  };
}

function sanitizeEmailFilename(email: string): string {
  const normalized = String(email ?? '').trim().toLowerCase();
  const safe = normalized
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 180);
  return `${safe || `openai-oauth-${Date.now()}`}.json`;
}

function computeNormalizedHash(record: NormalizedOpenAiOAuthJson): string {
  const canonical = {
    email: record.email,
    access_token: record.accessToken,
    refresh_token: record.refreshToken,
    id_token: record.idToken,
    account_id: record.accountId,
    organization_id: record.organizationId,
    plan_type: record.planType,
    client_id: record.clientId,
    user_id: record.userId,
    expired_at: record.expiredAt,
  };
  return createHash('sha256').update(stableStringify(canonical)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}
