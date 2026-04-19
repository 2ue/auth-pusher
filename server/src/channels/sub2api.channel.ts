import axios from 'axios';
import type { ChannelConfig } from '../../../shared/types/channel.js';
import type { RemoteAccountUpdateInput } from '../core/base-pusher.js';
import type { Sub2ApiPusher } from '../pushers/sub2api.pusher.js';
import type { ChannelActionResult, ChannelRemoteUpdateOptions } from './base-channel.js';
import { PusherBackedChannel } from './pusher-backed.channel.js';
import {
  SUB2API_ACCOUNT_API_PATH,
  SUB2API_BULK_UPDATE_PATH,
  buildOpenAiOauthCredentials,
  buildSub2ApiHeaders,
  extractSub2ApiConnection,
} from './sub2api.shared.js';

export class Sub2ApiChannel extends PusherBackedChannel {
  constructor(pusher: Sub2ApiPusher) {
    super(pusher);
  }

  protected override supportsUpdateRemote(): boolean {
    return true;
  }

  protected override supportsResetRemoteState(): boolean {
    return true;
  }

  protected override supportsSetSchedulable(): boolean {
    return true;
  }

  override async updateRemoteAccount(
    channel: ChannelConfig,
    remoteId: string,
    input: RemoteAccountUpdateInput,
    _options?: ChannelRemoteUpdateOptions,
  ): Promise<ChannelActionResult> {
    const accountId = Number.parseInt(remoteId, 10);
    if (!Number.isFinite(accountId) || accountId <= 0) {
      return { ok: false, error: `无效的远端账号 ID: ${remoteId}` };
    }

    const connection = extractSub2ApiConnection(channel.pusherConfig);
    const headers = {
      ...buildSub2ApiHeaders(connection),
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
    });

    const body = {
      account_ids: [accountId],
      name: input.email,
      extra: { email: input.email },
      credentials,
    };

    try {
      const response = await axios.post<Record<string, unknown>>(
        `${connection.baseUrl}${SUB2API_BULK_UPDATE_PATH}`,
        body,
        { headers, timeout: 20000, validateStatus: () => true },
      );
      return parseSub2ApiActionResponse(response.status, response.data, '远端更新失败');
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  override async resetRemoteState(channel: ChannelConfig, remoteId: string): Promise<ChannelActionResult> {
    const accountId = Number.parseInt(remoteId, 10);
    if (!Number.isFinite(accountId) || accountId <= 0) {
      return { ok: false, error: `无效的远端账号 ID: ${remoteId}` };
    }

    const connection = extractSub2ApiConnection(channel.pusherConfig);
    const headers = {
      ...buildSub2ApiHeaders(connection),
      'Content-Type': 'application/json',
    };

    try {
      const response = await axios.post<Record<string, unknown>>(
        `${connection.baseUrl}${SUB2API_ACCOUNT_API_PATH}/${accountId}/recover-state`,
        {},
        { headers, timeout: 20000, validateStatus: () => true },
      );
      return parseSub2ApiActionResponse(response.status, response.data, '重置远端状态失败');
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  override async setRemoteSchedulable(
    channel: ChannelConfig,
    remoteId: string,
    schedulable: boolean,
  ): Promise<ChannelActionResult> {
    const accountId = Number.parseInt(remoteId, 10);
    if (!Number.isFinite(accountId) || accountId <= 0) {
      return { ok: false, error: `无效的远端账号 ID: ${remoteId}` };
    }

    const connection = extractSub2ApiConnection(channel.pusherConfig);
    const headers = {
      ...buildSub2ApiHeaders(connection),
      'Content-Type': 'application/json',
    };

    try {
      const response = await axios.post<Record<string, unknown>>(
        `${connection.baseUrl}${SUB2API_ACCOUNT_API_PATH}/${accountId}/schedulable`,
        { schedulable },
        { headers, timeout: 20000, validateStatus: () => true },
      );
      return parseSub2ApiActionResponse(response.status, response.data, '修改远端调度状态失败');
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

function parseSub2ApiActionResponse(
  status: number,
  body: Record<string, unknown>,
  fallbackError: string,
): ChannelActionResult {
  if (status < 200 || status >= 300) {
    return { ok: false, error: extractSub2ApiError(body, `HTTP ${status}`) };
  }

  if (body.success === false) {
    return { ok: false, error: extractSub2ApiError(body, fallbackError) };
  }

  const code = Number(body.code ?? 0);
  if (!Number.isNaN(code) && code !== 0 && code !== 200 && code !== 201) {
    return { ok: false, error: extractSub2ApiError(body, fallbackError) };
  }

  const payload = ((body.data ?? body) || {}) as Record<string, unknown>;
  if (Array.isArray(payload.results)) {
    const firstFailure = payload.results.find((item) => {
      if (!item || typeof item !== 'object') return false;
      return (item as Record<string, unknown>).success === false;
    }) as Record<string, unknown> | undefined;
    if (firstFailure) {
      return { ok: false, error: String(firstFailure.error ?? firstFailure.message ?? fallbackError) };
    }
  }

  return { ok: true };
}

function extractSub2ApiError(body: Record<string, unknown>, fallback: string): string {
  return String(body.error ?? body.message ?? body.msg ?? fallback);
}
