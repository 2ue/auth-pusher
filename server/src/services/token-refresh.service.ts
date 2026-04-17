/**
 * Token 刷新服务
 * 使用 OpenAI OAuth endpoint 刷新 access_token
 */
import axios from 'axios';
import { decodeOpenAiJwt } from '../utils/jwt.js';
import { logger } from '../utils/logger.js';

const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REFRESH_SCOPES = 'openid profile email';
const USER_AGENT = 'codex-cli/0.91.0';

export interface RefreshTarget {
  id?: string;
  email: string;
  refreshToken: string;
  index?: number;
}

export interface RefreshResult {
  id?: string;
  email: string;
  index?: number;
  status: 'ok' | 'invalid_grant' | 'error';
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiredAt?: string;
  planType?: string;
  accountId?: string;
  organizationId?: string;
  errorMessage: string;
}

export interface BatchRefreshResult {
  total: number;
  refreshed: number;
  results: RefreshResult[];
}

export interface RefreshBatchOptions {
  concurrency?: number;
  onResult?: (result: RefreshResult, target: RefreshTarget, index: number) => void | Promise<void>;
}

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
}

export async function refreshToken(target: RefreshTarget): Promise<RefreshResult> {
  const { email, refreshToken: rt } = target;

  if (!rt) {
    return { id: target.id, email, index: target.index, status: 'error', errorMessage: '缺少 refresh_token' };
  }

  try {
    const params = new URLSearchParams();
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', rt);
    params.set('client_id', OPENAI_CLIENT_ID);
    params.set('scope', REFRESH_SCOPES);

    const res = await axios.post<OAuthTokenResponse>(OPENAI_TOKEN_URL, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      timeout: 30_000,
      validateStatus: () => true,
    });

    if (res.status !== 200) {
      const body = typeof res.data === 'object' ? res.data : {};
      const errorCode = String((body as Record<string, unknown>).error ?? '');
      const errorDesc = String((body as Record<string, unknown>).error_description ?? '');

      if (errorCode === 'invalid_grant') {
        return { id: target.id, email, index: target.index, status: 'invalid_grant', errorMessage: errorDesc || 'refresh_token 已失效' };
      }
      return { id: target.id, email, index: target.index, status: 'error', errorMessage: `HTTP ${res.status}: ${errorDesc || errorCode || 'unknown'}` };
    }

    const data = res.data;
    const newAccessToken = data.access_token;
    const newRefreshToken = data.refresh_token || undefined;
    const newIdToken = data.id_token || undefined;

    const claims = decodeOpenAiJwt(newAccessToken);
    const expiredAt = claims.exp > 0 ? new Date(claims.exp * 1000).toISOString() : undefined;

    return {
      id: target.id,
      email: claims.email || email,
      index: target.index,
      status: 'ok',
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      idToken: newIdToken,
      expiredAt,
      planType: claims.planType || undefined,
      accountId: claims.accountId || undefined,
      organizationId: claims.organizationId || undefined,
      errorMessage: '',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'refresh failed';
    logger.error({ email, error: msg }, 'token refresh error');
    return { id: target.id, email, index: target.index, status: 'error', errorMessage: msg };
  }
}

export async function refreshBatch(
  targets: RefreshTarget[],
  options: RefreshBatchOptions = {},
): Promise<BatchRefreshResult> {
  const results: RefreshResult[] = [];
  const concurrency = Math.max(1, options.concurrency ?? 3);
  let cursor = 0;

  const takeNext = () => {
    if (cursor >= targets.length) return null;
    const t = targets[cursor];
    const idx = cursor;
    cursor += 1;
    return { target: t, idx };
  };

  const workerCount = Math.min(concurrency, targets.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const item = takeNext();
      if (!item) break;
      const result = await refreshToken(item.target);
      results.push(result);
      await options.onResult?.(result, item.target, item.idx);
    }
  });

  await Promise.all(workers);

  return {
    total: targets.length,
    refreshed: results.filter((r) => r.status === 'ok').length,
    results,
  };
}
