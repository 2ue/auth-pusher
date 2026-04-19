import axios from 'axios';
import { nanoid } from 'nanoid';
import { BasePusher, type RemoteAccountFull, type RemoteAccountUpdateInput } from '../core/base-pusher.js';
import type { PusherSchema, PushRequest } from '../../../shared/types/pusher.js';
import type { MappedDataItem } from '../../../shared/types/data.js';
import type { Account } from '../../../shared/types/account.js';
import { resolvePlanTypeFromTokens } from '../utils/jwt.js';
import {
  SUB2API_ACCOUNT_API_PATH as API_PATH,
  SUB2API_GROUPS_API_PATH as GROUPS_PATH,
  SUB2API_BULK_UPDATE_PATH as BULK_UPDATE_PATH,
  OPENAI_OAUTH_CLIENT_ID,
  type Sub2ApiConnection,
  buildOpenAiOauthCredentials,
  buildSub2ApiHeaders,
  decodeJwtPayload,
  extractSub2ApiConnection,
  normalizeSub2ApiAuthMode,
  parseSub2ApiGroupIds,
} from '../channels/sub2api.shared.js';

export interface Sub2ApiGroup {
  id: number;
  name: string;
  platform: string;
  status: string;
  description: string;
  account_count: number;
}

export class Sub2ApiPusher extends BasePusher {
  readonly type = 'sub2api';

  readonly schema: PusherSchema = {
    type: 'sub2api',
    name: 'SUB2API',
    description: '推送账号到 SUB2API 平台',
    configFields: [
      { key: 'base_url', label: '服务地址', type: 'string', required: true, placeholder: 'https://sub2api.example.com' },
      { key: 'token', label: 'Token', type: 'string', required: true, placeholder: 'API Key 或 JWT Token', secret: true },
      {
        key: 'auth_mode', label: '认证模式', type: 'select', required: false,
        options: [
          { label: 'API Key (默认)', value: 'admin_api_key' },
          { label: 'JWT Bearer', value: 'admin_jwt' },
        ],
        defaultValue: 'admin_api_key',
      },
      { key: 'group_ids', label: '分组ID', type: 'string', required: false, placeholder: '逗号分隔，如 1,2,3', description: '账号所属分组' },
      { key: 'concurrency', label: '并发数', type: 'number', required: false, placeholder: '不填则使用渠道默认值' },
      { key: 'load_factor', label: '负载因子', type: 'number', required: false, placeholder: '不填则使用渠道默认值' },
      { key: 'priority', label: '优先级', type: 'number', required: false, placeholder: '不填则使用渠道默认值' },
      { key: 'rate_multiplier', label: '速率倍率', type: 'number', required: false, placeholder: '不填则使用渠道默认值' },
      { key: 'model_mapping', label: '模型映射', type: 'json', required: false, description: 'JSON 格式，如 {"gpt-4": "gpt-4o"}' },
    ],
    requiredDataFields: ['email', 'access_token'],
    optionalDataFields: ['refresh_token', 'id_token', 'account_id', 'organization_id'],
    supportsBatch: false,
    transport: 'json',
  };

  validateConfig(config: Record<string, unknown>) {
    const errors: string[] = [];
    if (!config.base_url) errors.push('缺少服务地址');
    if (!config.token) errors.push('缺少 Token');
    return { valid: errors.length === 0, errors };
  }

  buildRequest(item: MappedDataItem, config: Record<string, unknown>): PushRequest {
    const baseUrl = String(config.base_url).replace(/\/+$/, '');
    const token = String(config.token);
    const authMode = normalizeSub2ApiAuthMode(String(config.auth_mode ?? 'admin_api_key'));

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
    };

    if (authMode === 'admin_jwt') {
      headers['Authorization'] = `Bearer ${token}`;
    } else {
      headers['x-api-key'] = token;
    }

    const fields = item.fields;
    const accessToken = String(fields.access_token ?? '');
    const refreshToken = String(fields.refresh_token ?? '');
    const idToken = String(fields.id_token ?? '');

    // 解码 access_token JWT，提取关键字段（与 Python sub2api_payload.py 对齐）
    const atPayload = decodeJwtPayload(accessToken);
    const atAuth = (atPayload['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;

    const chatgptAccountId = String(
      atAuth.chatgpt_account_id ?? fields.account_id ?? '',
    );
    const chatgptUserId = String(atAuth.chatgpt_user_id ?? '');
    const expTimestamp = Number(atPayload.exp ?? 0);

    // 解码 id_token JWT，提取 organization_id
    const itPayload = decodeJwtPayload(idToken);
    const itAuth = (itPayload['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
    let organizationId = String(
      itAuth.organization_id ?? fields.organization_id ?? '',
    );
    if (!organizationId) {
      const orgs = Array.isArray(itAuth.organizations) ? itAuth.organizations : [];
      if (orgs.length > 0) {
        organizationId = String((orgs[0] as Record<string, unknown>)?.id ?? '');
      }
    }

    // 构建 credentials（对齐 sub2api OAuth BuildAccountCredentials）
    const credentials: Record<string, unknown> = {
      access_token: accessToken,
    };

    // expires_at: sub2api OAuth 流程存的是 RFC3339 字符串，需对齐
    if (expTimestamp > 0) {
      credentials.expires_at = new Date(expTimestamp * 1000).toISOString();
    }

    if (refreshToken) credentials.refresh_token = refreshToken;
    // id_token: sub2api OAuth 流程会保存，缺失可能导致 refresh 报错
    if (idToken) credentials.id_token = idToken;
    credentials.client_id = OPENAI_OAUTH_CLIENT_ID;
    if (chatgptAccountId) credentials.chatgpt_account_id = chatgptAccountId;
    if (chatgptUserId) credentials.chatgpt_user_id = chatgptUserId;
    if (organizationId) credentials.organization_id = organizationId;

    // plan_type: 前端手选 > 数据字段 > access_token JWT > id_token JWT
    const planType = String(
      config.plan_type
      || fields.plan_type
      || (fields['credentials.plan_type'])
      || atAuth.chatgpt_plan_type
      || itAuth.chatgpt_plan_type
      || '',
    );
    if (planType) credentials.plan_type = planType;

    // 模型映射
    if (config.model_mapping) {
      const mm = typeof config.model_mapping === 'string'
        ? JSON.parse(config.model_mapping as string)
        : config.model_mapping;
      if (mm && typeof mm === 'object' && Object.keys(mm as object).length > 0) {
        credentials.model_mapping = mm;
      }
    }

    const jsonBody: Record<string, unknown> = {
      name: String(fields.email ?? item.identifier),
      platform: 'openai',
      type: 'oauth',
      credentials,
      extra: { email: String(fields.email ?? item.identifier) },
    };

    // 分组
    const groupIds = parseSub2ApiGroupIds(config.group_ids);
    if (groupIds.length > 0) jsonBody.group_ids = groupIds;

    // 可选数值参数：仅传明确设置了且 > 0 的值，避免传 0 覆盖远端默认值
    const numFields = ['concurrency', 'load_factor', 'priority', 'rate_multiplier'] as const;
    for (const f of numFields) {
      if (config[f] == null || config[f] === '' || config[f] === 0) continue;
      const val = Number(config[f]);
      if (Number.isFinite(val) && val > 0) jsonBody[f] = val;
    }

    return {
      identifier: item.identifier,
      provider: this.type,
      url: `${baseUrl}${API_PATH}`,
      headers,
      jsonBody,
      transport: 'json',
      timeoutMs: 30000,
      snapshot: {
        url: `${baseUrl}${API_PATH}`,
        headers: this.redactHeaders(headers),
        email: fields.email,
        auth_mode: authMode,
      },
    };
  }

  /** 从 SUB2API 拉取可用分组列表 */
  async fetchGroups(config: Record<string, unknown>): Promise<Sub2ApiGroup[]> {
    const baseUrl = String(config.base_url).replace(/\/+$/, '');
    const token = String(config.token);
    const authMode = normalizeSub2ApiAuthMode(String(config.auth_mode ?? 'admin_api_key'));

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (authMode === 'admin_jwt') {
      headers['Authorization'] = `Bearer ${token}`;
    } else {
      headers['x-api-key'] = token;
    }

    const url = `${baseUrl}${GROUPS_PATH}?page=1&page_size=500&platform=openai`;
    const { data: body } = await axios.get<Record<string, unknown>>(url, { headers, timeout: 15000 });

    if (body.code !== 0 && body.code !== 200) {
      throw new Error(`拉取分组失败: ${body.message ?? body.msg ?? '未知错误'}`);
    }

    const data = body.data as Record<string, unknown> | unknown[];
    let items: unknown[];
    if (Array.isArray(data)) {
      items = data;
    } else if (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).items)) {
      items = (data as Record<string, unknown>).items as unknown[];
    } else {
      items = [];
    }

    return items.map((item) => {
      const g = item as Record<string, unknown>;
      return {
        id: Number(g.id ?? 0),
        name: String(g.name ?? ''),
        platform: String(g.platform ?? ''),
        status: String(g.status ?? ''),
        description: String(g.description ?? ''),
        account_count: Number(g.account_count ?? 0),
      };
    });
  }

  evaluateResponse(statusCode: number, body: Record<string, unknown>) {
    if (statusCode < 200 || statusCode >= 300) {
      return { ok: false, externalId: '', error: String(body.error ?? body.message ?? `HTTP ${statusCode}`) };
    }

    // 检查 code == 0 模式
    if (body.code === 0 || body.code === 200 || body.code === 201) {
      const data = (body.data ?? {}) as Record<string, unknown>;
      const externalId = String(data.id ?? body.id ?? body.account_id ?? '');
      return { ok: true, externalId, error: '' };
    }

    // 通用成功标记
    if (body.success === true || ['ok', 'success', 'created', 'published'].includes(String(body.status))) {
      const externalId = String(body.id ?? body.account_id ?? body.external_id ?? '');
      return { ok: true, externalId, error: '' };
    }

    if (body.success === false || ['error', 'failed', 'fail'].includes(String(body.status))) {
      return { ok: false, externalId: '', error: String(body.error ?? body.message ?? '推送失败') };
    }

    // 有 external_id 也算成功
    const extId = String(body.id ?? body.account_id ?? body.external_id ?? (body.data as Record<string, unknown>)?.id ?? '');
    if (extId) return { ok: true, externalId: extId, error: '' };

    return { ok: false, externalId: '', error: 'SUB2API 响应未提供明确成功标记' };
  }

  // ======== 删除能力 ========

  override canDelete(): boolean { return true; }
  override canUpdateRemote(): boolean { return true; }

  override async deleteAccount(config: Record<string, unknown>, remoteId: string): Promise<{ ok: boolean; error?: string }> {
    const conn = extractSub2ApiConnection(config);
    const headers = buildSub2ApiHeaders(conn);
    const url = `${conn.baseUrl}${API_PATH}/${remoteId}`;
    try {
      const { status, data } = await axios.delete<Record<string, unknown>>(url, { headers, timeout: 15000, validateStatus: () => true });
      if (status >= 200 && status < 300) return { ok: true };
      return { ok: false, error: String((data as Record<string, unknown>)?.error ?? (data as Record<string, unknown>)?.message ?? `HTTP ${status}`) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  override async updateRemoteAccount(
    config: Record<string, unknown>,
    remoteId: string,
    input: RemoteAccountUpdateInput,
  ): Promise<{ ok: boolean; error?: string }> {
    const accountId = Number.parseInt(remoteId, 10);
    if (!Number.isFinite(accountId) || accountId <= 0) {
      return { ok: false, error: `无效的远端账号 ID: ${remoteId}` };
    }

    const conn = extractSub2ApiConnection(config);
    const headers = {
      ...buildSub2ApiHeaders(conn),
      'Content-Type': 'application/json',
    };

    const credentials = buildOpenAiOauthCredentials({
      email: input.email,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      idToken: input.idToken,
      accountId: input.accountId,
      organizationId: input.organizationId,
      planType: input.planType,
      clientId: input.clientId,
      userId: input.userId,
      expiredAt: input.expiredAt,
      modelMapping: undefined,
    });

    const body = {
      account_ids: [accountId],
      name: input.email,
      extra: { email: input.email },
      credentials,
    };

    try {
      const url = `${conn.baseUrl}${BULK_UPDATE_PATH}`;
      const { status, data } = await axios.post<Record<string, unknown>>(url, body, {
        headers,
        timeout: 20000,
        validateStatus: () => true,
      });

      if (status < 200 || status >= 300) {
        return {
          ok: false,
          error: String((data as Record<string, unknown>)?.error ?? (data as Record<string, unknown>)?.message ?? `HTTP ${status}`),
        };
      }

      const payload = ((data as Record<string, unknown>)?.data ?? data) as Record<string, unknown>;
      const success = Number(payload.success ?? 0);
      const failed = Number(payload.failed ?? 0);
      if (success > 0 && failed === 0) return { ok: true };
      if ((data as Record<string, unknown>)?.code === 0 || (data as Record<string, unknown>)?.code === 200) return { ok: true };

      const results = Array.isArray(payload.results) ? payload.results : [];
      const firstFailure = results.find((item) => {
        if (!item || typeof item !== 'object') return false;
        return (item as Record<string, unknown>).success === false;
      }) as Record<string, unknown> | undefined;

      return {
        ok: false,
        error: String(firstFailure?.error ?? (data as Record<string, unknown>)?.error ?? (data as Record<string, unknown>)?.message ?? '远端更新失败'),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ======== 同步能力 ========

  override canSync(): boolean { return true; }
  override canFetchRemote(): boolean { return true; }

  /** 从 sub2api 同步 auth 类型账号到本地 */
  override async syncAccounts(config: Record<string, unknown>): Promise<Account[]> {
    const conn = extractSub2ApiConnection(config);
    const accounts: Account[] = [];
    let page = 1;
    const pageSize = 500;

    while (true) {
      const { items, total } = await fetchPage(conn, page, pageSize);
      for (const item of items) {
        const creds = (item.credentials ?? {}) as Record<string, unknown>;
        const extra = (item.extra ?? {}) as Record<string, unknown>;
        const email = String(extra.email ?? item.name ?? '');
        if (!email) continue;
        const accessToken = String(creds.access_token ?? '');
        if (!accessToken) continue; // 只同步 auth 类型

        const idToken = String(creds.id_token ?? '');
        let planType = String(creds.plan_type ?? '');
        if (!planType) planType = resolvePlanTypeFromTokens(accessToken, idToken);

        accounts.push({
          id: nanoid(12), email, accessToken,
          refreshToken: String(creds.refresh_token ?? ''),
          idToken,
          accountId: String(creds.chatgpt_account_id ?? ''),
          organizationId: String(creds.organization_id ?? ''),
          planType, tags: [],
          disabled: item.status === 'inactive' || item.status === 'error',
          expiredAt: '', sourceType: 'remote', source: '',
          importedAt: new Date().toISOString(), pushHistory: [], lastProbe: null,
        });
      }
      if (items.length < pageSize || accounts.length >= total) break;
      page++;
    }
    return accounts;
  }

  /** 拉取远端账号列表 */
  override async fetchRemoteAccounts(config: Record<string, unknown>): Promise<RemoteAccountFull[]> {
    const conn = extractSub2ApiConnection(config);
    const results: RemoteAccountFull[] = [];
    let page = 1;
    const pageSize = 500;

    while (true) {
      const { items, total } = await fetchPage(conn, page, pageSize);
      for (const item of items) {
        const creds = (item.credentials ?? {}) as Record<string, unknown>;
        const extra = (item.extra ?? {}) as Record<string, unknown>;
        const email = String(extra.email ?? item.name ?? '');
        if (!email) continue;
        const accessToken = String(creds.access_token ?? '');
        if (!accessToken) continue; // 只展示 auth 类型

        results.push({
          email,
          status: String(item.status ?? 'unknown'),
          schedulable: item.schedulable === true,
          planType: String(creds.plan_type ?? ''),
          accessToken,
          disabled: item.status === 'inactive' || item.status === 'error',
          errorMessage: String(item.error_message ?? ''),
          remoteId: String(item.id ?? ''),
        });
      }
      if (items.length < pageSize || results.length >= total) break;
      page++;
    }
    return results;
  }
}

async function fetchPage(conn: Sub2ApiConnection, page: number, pageSize: number) {
  const url = `${conn.baseUrl}${API_PATH}?page=${page}&page_size=${pageSize}&platform=openai`;
  const { data: body } = await axios.get<Record<string, unknown>>(url, { headers: buildSub2ApiHeaders(conn), timeout: 30000 });
  if (body.code !== 0 && body.code !== 200) throw new Error(`Sub2API 错误: ${body.message ?? body.msg ?? '未知'}`);
  const data = body.data as Record<string, unknown>;
  const items = (Array.isArray(data) ? data : (data?.items as unknown[] ?? [])) as Record<string, unknown>[];
  const total = Number((data as Record<string, unknown>)?.total ?? 0);
  return { items, total };
}
