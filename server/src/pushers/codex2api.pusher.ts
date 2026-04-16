import axios from 'axios';
import { BasePusher, type RemoteAccountFull } from '../core/base-pusher.js';
import type { PusherSchema, PushRequest } from '../../../shared/types/pusher.js';
import type { MappedDataItem } from '../../../shared/types/data.js';
import type { Account } from '../../../shared/types/account.js';
import { nanoid } from 'nanoid';
import { resolvePlanTypeFromTokens } from '../utils/jwt.js';

const PATH_RT = '/api/admin/accounts';
const PATH_AT = '/api/admin/accounts/at';
const PATH_LIST = '/api/admin/accounts';
const PATH_EXPORT = '/api/admin/accounts/export';

interface Codex2ApiVisibleAccount {
  remoteId: string;
  email: string;
  status: string;
  planType: string;
  disabled: boolean;
  schedulable: boolean;
  errorMessage: string;
}

export class Codex2ApiPusher extends BasePusher {
  readonly type = 'codex2api';

  readonly schema: PusherSchema = {
    type: 'codex2api',
    name: 'Codex2API',
    description: '导入 token 到 Codex2API 平台',
    configFields: [
      { key: 'base_url', label: '服务地址', type: 'string', required: true, placeholder: 'https://codex2api.example.com' },
      { key: 'admin_key', label: 'Admin Key', type: 'string', required: true, secret: true },
      {
        key: 'import_mode', label: '导入模式', type: 'select', required: false,
        options: [
          { label: 'Refresh Token (默认)', value: 'refresh_token' },
          { label: 'Access Token', value: 'access_token' },
        ],
        defaultValue: 'refresh_token',
      },
      {
        key: 'sync_filter', label: '同步范围', type: 'select', required: false,
        options: [
          { label: '仅运行时活跃', value: 'healthy' },
          { label: '全部未删除', value: 'all' },
        ],
        defaultValue: 'all',
        description: 'healthy = DB active + 运行时 active；all = DB active（含限流/错误等）',
      },
      { key: 'proxy_url', label: '代理地址', type: 'string', required: false, placeholder: 'http://proxy:port' },
      { key: 'timeout_seconds', label: '超时(秒)', type: 'number', required: false, defaultValue: 30 },
    ],
    requiredDataFields: ['email'],
    optionalDataFields: ['access_token', 'refresh_token'],
    supportsBatch: false,
    transport: 'json',
  };

  validateConfig(config: Record<string, unknown>) {
    const errors: string[] = [];
    if (!config.base_url) errors.push('缺少服务地址');
    if (!config.admin_key) errors.push('缺少 Admin Key');
    return { valid: errors.length === 0, errors };
  }

  buildRequest(item: MappedDataItem, config: Record<string, unknown>): PushRequest {
    const baseUrl = String(config.base_url).replace(/\/+$/, '');
    const adminKey = String(config.admin_key);
    const mode = normalizeImportMode(String(config.import_mode ?? 'refresh_token'));
    const proxyUrl = String(config.proxy_url ?? '');
    const timeout = Number(config.timeout_seconds ?? 30) * 1000;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'X-Admin-Key': adminKey,
    };

    const fields = item.fields;
    const jsonBody: Record<string, unknown> = {
      name: String(fields.email ?? item.identifier),
    };

    if (proxyUrl) jsonBody.proxy_url = proxyUrl;

    // token 是必传字段
    if (mode === 'access_token') {
      jsonBody.access_token = String(fields.access_token ?? '');
    } else {
      jsonBody.refresh_token = String(fields.refresh_token ?? '');
    }

    const apiPath = mode === 'access_token' ? PATH_AT : PATH_RT;

    return {
      identifier: item.identifier,
      provider: this.type,
      url: `${baseUrl}${apiPath}`,
      headers,
      jsonBody,
      transport: 'json',
      timeoutMs: timeout,
      snapshot: {
        url: `${baseUrl}${apiPath}`,
        headers: { ...this.redactHeaders(headers) },
        import_mode: mode,
        email: fields.email,
      },
    };
  }

  evaluateResponse(statusCode: number, body: Record<string, unknown>) {
    if (statusCode < 200 || statusCode >= 300) {
      return { ok: false, externalId: '', error: String(body.error ?? body.message ?? `HTTP ${statusCode}`) };
    }

    if (body.success === false || ['error', 'failed', 'fail'].includes(String(body.status))) {
      return { ok: false, externalId: '', error: String(body.error ?? body.message ?? '导入失败') };
    }

    // Codex2API 特有: success/failed 计数
    const data = (body.data ?? body) as Record<string, unknown>;
    const successCount = Number(data.success ?? body.success ?? -1);
    const failedCount = Number(data.failed ?? body.failed ?? -1);

    if (successCount >= 0 || failedCount >= 0) {
      const ok = (successCount >= 1) && (failedCount === 0 || isNaN(failedCount));
      if (!ok) {
        return {
          ok: false,
          externalId: '',
          error: `Codex2API 导入结果: success=${successCount}, failed=${failedCount}`,
        };
      }
      return { ok: true, externalId: '', error: '' };
    }

    // 通用回退
    return super.evaluateResponse(statusCode, body);
  }

  override canDelete(): boolean { return true; }

  override async deleteAccount(config: Record<string, unknown>, remoteId: string): Promise<{ ok: boolean; error?: string }> {
    const baseUrl = String(config.base_url ?? '').replace(/\/+$/, '');
    const adminKey = String(config.admin_key ?? '');
    const url = `${baseUrl}${PATH_LIST}/${remoteId}`;
    try {
      const { status, data } = await axios.delete<Record<string, unknown>>(url, {
        headers: { 'X-Admin-Key': adminKey, Accept: 'application/json' },
        timeout: 15000,
        validateStatus: () => true,
      });
      if (status >= 200 && status < 300) return { ok: true };
      return { ok: false, error: String((data as Record<string, unknown>)?.error ?? (data as Record<string, unknown>)?.message ?? `HTTP ${status}`) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  override canSync(): boolean { return true; }
  override canFetchRemote(): boolean { return true; }

  override async syncAccounts(config: Record<string, unknown>): Promise<Account[]> {
    const baseUrl = String(config.base_url ?? '').replace(/\/+$/, '');
    const adminKey = String(config.admin_key ?? '');
    const timeoutMs = Number(config.timeout_seconds ?? 30) * 1000;
    const visibleAccounts = await fetchVisibleAccounts(baseUrl, adminKey, timeoutMs);
    const exportEntries = await fetchExportEntries(baseUrl, adminKey, timeoutMs, visibleAccounts.map((row) => row.remoteId));
    const exportByEmail = buildExportMap(exportEntries);
    const accounts: Account[] = [];

    for (const row of visibleAccounts) {
      const entry = exportByEmail.get(normalizeEmailKey(row.email));
      const email = row.email;
      const accessToken = normalizeText(entry?.access_token);
      const refreshToken = normalizeText(entry?.refresh_token);
      if (!email || (!accessToken && !refreshToken)) continue;

      const idToken = normalizeText(entry?.id_token);
      let planType = normalizeText(entry?.plan_type) || row.planType;
      if (!planType) planType = resolvePlanTypeFromTokens(accessToken, idToken);

      accounts.push({
        id: nanoid(12),
        email,
        accessToken,
        refreshToken,
        idToken,
        accountId: normalizeText(entry?.account_id),
        organizationId: normalizeText(entry?.organization_id),
        planType,
        tags: [],
        disabled: row.disabled,
        expiredAt: normalizeText(entry?.expired),
        sourceType: 'remote',
        source: '',
        importedAt: new Date().toISOString(),
        pushHistory: [],
        lastProbe: null,
      });
    }

    return accounts;
  }

  override async fetchRemoteAccounts(config: Record<string, unknown>): Promise<RemoteAccountFull[]> {
    const baseUrl = String(config.base_url ?? '').replace(/\/+$/, '');
    const adminKey = String(config.admin_key ?? '');
    const timeoutMs = Number(config.timeout_seconds ?? 30) * 1000;
    const visibleAccounts = await fetchVisibleAccounts(baseUrl, adminKey, timeoutMs);
    const exportEntries = await fetchExportEntries(baseUrl, adminKey, timeoutMs, visibleAccounts.map((row) => row.remoteId));
    const exportByEmail = buildExportMap(exportEntries);

    return visibleAccounts.map((row) => {
      const entry = exportByEmail.get(normalizeEmailKey(row.email));
      const accessToken = normalizeText(entry?.access_token);
      const refreshToken = normalizeText(entry?.refresh_token);
      let planType = normalizeText(entry?.plan_type) || row.planType;
      if (!planType) {
        planType = resolvePlanTypeFromTokens(accessToken, normalizeText(entry?.id_token));
      }
      const tokenError = accessToken || refreshToken ? '' : 'token_unavailable';

      return {
        email: row.email,
        status: row.status,
        schedulable: row.schedulable,
        planType,
        accessToken,
        disabled: row.disabled,
        errorMessage: row.errorMessage || tokenError,
        remoteId: row.remoteId,
      };
    });
  }
}

function normalizeImportMode(mode: string): 'refresh_token' | 'access_token' {
  const m = mode.toLowerCase().trim();
  if (['access', 'access_token', 'at'].includes(m)) return 'access_token';
  return 'refresh_token';
}

function normalizeText(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeEmailKey(value: unknown): string {
  return normalizeText(value).toLowerCase();
}

function buildExportMap(entries: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    const key = normalizeEmailKey(entry.email ?? entry.name);
    if (!key) continue;
    map.set(key, entry);
  }
  return map;
}

async function fetchVisibleAccounts(
  baseUrl: string,
  adminKey: string,
  timeoutMs: number,
): Promise<Codex2ApiVisibleAccount[]> {
  const { data: body } = await axios.get<Record<string, unknown>>(`${baseUrl}${PATH_LIST}`, {
    headers: { Accept: 'application/json', 'X-Admin-Key': adminKey },
    timeout: timeoutMs,
  });
  const rows = Array.isArray(body.accounts) ? body.accounts as Record<string, unknown>[] : [];

  return rows
    .map((row) => {
      const email = normalizeText(row.email ?? row.name);
      if (!email) return null;
      const status = normalizeText(row.status).toLowerCase() || 'unknown';
      const locked = row.locked === true;
      return {
        remoteId: normalizeText(row.id ?? row.name),
        email,
        status,
        planType: normalizeText(row.plan_type),
        disabled: locked || status !== 'active',
        schedulable: !locked && status === 'active',
        errorMessage: locked ? 'locked' : '',
      };
    })
    .filter((item): item is Codex2ApiVisibleAccount => item !== null);
}

async function fetchExportEntries(
  baseUrl: string,
  adminKey: string,
  timeoutMs: number,
  remoteIds: string[],
): Promise<Record<string, unknown>[]> {
  const sanitizedIds = remoteIds.map((id) => normalizeText(id)).filter(Boolean);
  if (sanitizedIds.length === 0) return [];

  const batches = chunkIds(sanitizedIds, 100);
  const merged: Record<string, unknown>[] = [];

  for (const ids of batches) {
    const body = await requestExportEntries(baseUrl, adminKey, timeoutMs, ids);
    if (body === null) {
      const fallback = await requestExportEntries(baseUrl, adminKey, timeoutMs);
      return fallback ?? [];
    }
    merged.push(...body);
  }

  return merged;
}

async function requestExportEntries(
  baseUrl: string,
  adminKey: string,
  timeoutMs: number,
  ids?: string[],
): Promise<Record<string, unknown>[] | null> {
  const params = new URLSearchParams({ filter: 'all' });
  if (ids && ids.length > 0) {
    params.set('ids', ids.join(','));
  }

  const response = await axios.get(`${baseUrl}${PATH_EXPORT}?${params.toString()}`, {
    headers: { Accept: 'application/json', 'X-Admin-Key': adminKey },
    timeout: timeoutMs,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    return null;
  }
  return Array.isArray(response.data) ? response.data as Record<string, unknown>[] : null;
}

function chunkIds(ids: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}
