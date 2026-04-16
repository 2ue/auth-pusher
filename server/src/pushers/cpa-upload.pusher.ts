import axios from 'axios';
import { nanoid } from 'nanoid';
import { BasePusher } from '../core/base-pusher.js';
import type { PusherSchema, PushRequest } from '../../../shared/types/pusher.js';
import type { MappedDataItem } from '../../../shared/types/data.js';
import type { Account } from '../../../shared/types/account.js';
import { resolvePlanTypeFromTokens } from '../utils/jwt.js';

const API_PATH = '/v0/management/auth-files';

export class CpaUploadPusher extends BasePusher {
  readonly type = 'cliproxycli';

  readonly schema: PusherSchema = {
    type: 'cliproxycli',
    name: 'CliproxyCLI',
    description: '上传认证文件到 CliproxyCLI 管理平台',
    configFields: [
      { key: 'base_url', label: '服务地址', type: 'string', required: true, placeholder: 'https://cpa.example.com' },
      { key: 'token', label: 'Bearer Token', type: 'string', required: true, secret: true },
    ],
    requiredDataFields: ['email', 'access_token'],
    optionalDataFields: ['refresh_token', 'id_token', 'session_token', 'account_id'],
    supportsBatch: false,
    transport: 'multipart_file',
  };

  validateConfig(config: Record<string, unknown>) {
    const errors: string[] = [];
    if (!config.base_url) errors.push('缺少服务地址');
    if (!config.token) errors.push('缺少 Bearer Token');
    return { valid: errors.length === 0, errors };
  }

  buildRequest(item: MappedDataItem, config: Record<string, unknown>): PushRequest {
    const baseUrl = String(config.base_url).replace(/\/+$/, '');
    const token = String(config.token);
    const fields = item.fields;

    // 构建 token 导出文件内容
    const tokenExport: Record<string, unknown> = {
      email: String(fields.email ?? item.identifier),
      access_token: String(fields.access_token ?? ''),  // 必传
    };
    // 可选字段：有值才传
    if (fields.refresh_token) tokenExport.refresh_token = String(fields.refresh_token);
    if (fields.id_token) tokenExport.id_token = String(fields.id_token);
    if (fields.session_token) tokenExport.session_token = String(fields.session_token);
    if (fields.account_id) tokenExport.account_id = String(fields.account_id);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `codex_tokens_${timestamp}.json`;
    const fileContent = JSON.stringify(tokenExport, null, 2);

    return {
      identifier: item.identifier,
      provider: this.type,
      url: `${baseUrl}${API_PATH}`,
      headers: {
        Authorization: `Bearer ${token}`,
      },
      fileName,
      fileContent,
      fileFieldName: 'file',
      transport: 'multipart_file',
      timeoutMs: 30000,
      snapshot: {
        url: `${baseUrl}${API_PATH}`,
        headers: { Authorization: 'Bearer ***' },
        file_name: fileName,
        email: fields.email,
      },
    };
  }

  evaluateResponse(statusCode: number, body: Record<string, unknown>) {
    // CliproxyCLI: 只要 2xx 且非 HTML 就算成功
    if (statusCode >= 200 && statusCode < 300) {
      const text = String(body.text ?? '');
      if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
        return { ok: false, externalId: '', error: '响应为 HTML 页面，请检查 URL 配置' };
      }
      if (body.success === false || ['error', 'failed', 'fail'].includes(String(body.status))) {
        return { ok: false, externalId: '', error: String(body.error ?? body.message ?? '上传失败') };
      }
      const externalId = String(body.id ?? body.account_id ?? body.external_id ?? '');
      return { ok: true, externalId, error: '' };
    }
    return { ok: false, externalId: '', error: String(body.error ?? body.message ?? `HTTP ${statusCode}`) };
  }

  // ======== 删除能力 ========

  override canDelete(): boolean { return true; }

  override async deleteAccount(config: Record<string, unknown>, remoteId: string): Promise<{ ok: boolean; error?: string }> {
    const baseUrl = String(config.base_url ?? '').replace(/\/+$/, '');
    const token = String(config.token ?? '');
    const url = `${baseUrl}${API_PATH}?name=${encodeURIComponent(remoteId)}`;
    try {
      const { status, data } = await axios.delete<Record<string, unknown>>(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        timeout: 15000,
        validateStatus: () => true,
      });
      if (status >= 200 && status < 300) return { ok: true };
      return { ok: false, error: String((data as Record<string, unknown>)?.error ?? (data as Record<string, unknown>)?.message ?? `HTTP ${status}`) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ======== 同步能力 ========

  override canSync(): boolean { return true; }

  override async syncAccounts(config: Record<string, unknown>): Promise<Account[]> {
    const baseUrl = String(config.base_url ?? '').replace(/\/+$/, '');
    const token = String(config.token ?? '');
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    };

    const listUrl = `${baseUrl}${API_PATH}`;
    const { data: listBody } = await axios.get<Record<string, unknown>>(listUrl, { headers, timeout: 30000 });
    const files = (listBody.files ?? []) as Record<string, unknown>[];
    const accounts: Account[] = [];

    for (const file of files) {
      const name = String(file.name ?? '');
      const email = String(file.email ?? file.label ?? file.account ?? '');
      if (!name || !email) continue;

      try {
        const dlUrl = `${baseUrl}${API_PATH}/download?name=${encodeURIComponent(name)}`;
        const { data: content } = await axios.get<Record<string, unknown>>(dlUrl, { headers, timeout: 15000 });
        const accessToken = String(content.access_token ?? '');
        if (!accessToken) continue; // 只同步 auth 类型

        const idToken = String(content.id_token ?? '');
        let planType = String(content.plan_type ?? '');
        if (!planType) planType = resolvePlanTypeFromTokens(accessToken, idToken);

        accounts.push({
          id: nanoid(12), email, accessToken,
          refreshToken: String(content.refresh_token ?? ''),
          idToken,
          accountId: String(content.account_id ?? content.chatgpt_account_id ?? ''),
          organizationId: String(content.organization_id ?? ''),
          planType, tags: [],
          disabled: file.disabled === true,
          expiredAt: '', sourceType: 'remote', source: '',
          importedAt: new Date().toISOString(), pushHistory: [], lastProbe: null,
        });
      } catch {
        // 单个文件下载失败不阻断
      }
    }
    return accounts;
  }
}
