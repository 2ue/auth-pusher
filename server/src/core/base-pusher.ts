import type { PusherSchema, PushRequest } from '../../../shared/types/pusher.js';
import type { MappedDataItem } from '../../../shared/types/data.js';
import type { Account } from '../../../shared/types/account.js';

/** 远端账号状态（用于号池渠道 Tab 展示，不含敏感信息） */
export interface RemoteAccountStatus {
  email: string;
  status: string;
  schedulable: boolean;
  planType: string;
  disabled: boolean;
  errorMessage: string;
}

/** 远端账号完整信息（仅后端内部使用，含 token） */
export interface RemoteAccountFull extends RemoteAccountStatus {
  accessToken: string;
  /** 远端系统中的唯一标识（用于删除等操作） */
  remoteId?: string;
}

export interface RemoteAccountUpdateInput {
  email: string;
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  accountId?: string;
  organizationId?: string;
  planType?: string;
  clientId?: string;
  userId?: string;
  expiredAt?: string;
}

export abstract class BasePusher {
  abstract readonly type: string;
  abstract readonly schema: PusherSchema;

  /** 验证渠道配置是否完整有效 */
  abstract validateConfig(config: Record<string, unknown>): {
    valid: boolean;
    errors: string[];
  };

  /** 为单条数据构建推送请求 */
  abstract buildRequest(
    item: MappedDataItem,
    config: Record<string, unknown>,
  ): PushRequest;

  /** 批量模式构建请求（默认不支持） */
  buildBatchRequest(
    _items: MappedDataItem[],
    _config: Record<string, unknown>,
  ): PushRequest | null {
    return null;
  }

  /** 自定义响应评估（默认 200/201 为成功） */
  evaluateResponse(
    statusCode: number,
    body: Record<string, unknown>,
  ): { ok: boolean; externalId: string; error: string } {
    const ok = statusCode === 200 || statusCode === 201;
    const externalId = String(
      body.id ?? body.account_id ?? body.external_id ?? (body.data as Record<string, unknown>)?.id ?? '',
    );
    const error = ok ? '' : String(body.error ?? body.message ?? body.msg ?? body.detail ?? `HTTP ${statusCode}`);
    return { ok, externalId, error };
  }

  /** 是否支持从该渠道同步账号到本地 */
  canSync(): boolean { return false; }

  /** 从渠道拉取 auth 类型账号到本地号池 */
  async syncAccounts(_config: Record<string, unknown>): Promise<Account[]> {
    throw new Error('该渠道不支持同步');
  }

  /** 是否支持查看远端账号列表 */
  canFetchRemote(): boolean { return false; }

  /** 拉取远端账号列表（含 token，仅后端内部使用） */
  async fetchRemoteAccounts(_config: Record<string, unknown>): Promise<RemoteAccountFull[]> {
    throw new Error('该渠道不支持查看远端账号');
  }

  /** 是否支持从远端删除账号 */
  canDelete(): boolean { return false; }

  /** 从远端删除指定账号 */
  async deleteAccount(_config: Record<string, unknown>, _remoteId: string): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: 'Not supported' };
  }

  /** 是否支持更新远端现有账号 */
  canUpdateRemote(): boolean { return false; }

  /** 更新远端已有账号 */
  async updateRemoteAccount(
    _config: Record<string, unknown>,
    _remoteId: string,
    _input: RemoteAccountUpdateInput,
  ): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: 'Not supported' };
  }

  /** 脱敏处理：隐藏 headers 中的 token */
  protected redactHeaders(headers: Record<string, string>): Record<string, string> {
    const redacted = { ...headers };
    for (const key of Object.keys(redacted)) {
      const lower = key.toLowerCase();
      if (lower === 'authorization' || lower === 'x-api-key' || lower === 'x-admin-key') {
        const val = redacted[key];
        redacted[key] = val.length > 12 ? val.slice(0, 6) + '***' + val.slice(-4) : '***';
      }
    }
    return redacted;
  }
}
