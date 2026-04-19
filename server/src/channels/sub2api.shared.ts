export const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

export const SUB2API_ACCOUNT_API_PATH = '/api/v1/admin/accounts';
export const SUB2API_GROUPS_API_PATH = '/api/v1/admin/groups';
export const SUB2API_BULK_UPDATE_PATH = '/api/v1/admin/accounts/bulk-update';

export interface Sub2ApiConnection {
  baseUrl: string;
  token: string;
  authMode: 'admin_api_key' | 'admin_jwt';
}

/** 解码 JWT payload（不验证签名） */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return {};
    let payload = parts[1];
    payload += '='.repeat((4 - payload.length % 4) % 4);
    const json = Buffer.from(payload, 'base64url').toString('utf-8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function normalizeSub2ApiAuthMode(mode: string): 'admin_api_key' | 'admin_jwt' {
  const normalized = mode.toLowerCase().trim();
  if (['admin_jwt', 'jwt', 'bearer'].includes(normalized)) return 'admin_jwt';
  return 'admin_api_key';
}

export function extractSub2ApiConnection(config: Record<string, unknown>): Sub2ApiConnection {
  return {
    baseUrl: String(config.base_url ?? '').replace(/\/+$/, ''),
    token: String(config.token ?? config.admin_key ?? ''),
    authMode: normalizeSub2ApiAuthMode(String(config.auth_mode ?? 'admin_api_key')),
  };
}

export function buildSub2ApiHeaders(
  connection: Pick<Sub2ApiConnection, 'token' | 'authMode'>,
): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (connection.authMode === 'admin_jwt') headers.Authorization = `Bearer ${connection.token}`;
  else headers['x-api-key'] = connection.token;
  return headers;
}

export function parseSub2ApiGroupIds(value: unknown): number[] {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isFinite(item));
}

export function buildOpenAiOauthCredentials(input: {
  email?: string;
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  accountId?: string;
  organizationId?: string;
  planType?: string;
  clientId?: string;
  userId?: string;
  expiredAt?: string;
  modelMapping?: unknown;
}): Record<string, unknown> {
  const accessToken = String(input.accessToken ?? '');
  const refreshToken = String(input.refreshToken ?? '');
  const idToken = String(input.idToken ?? '');

  const atPayload = decodeJwtPayload(accessToken);
  const atAuth = (atPayload['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
  const itPayload = decodeJwtPayload(idToken);
  const itAuth = (itPayload['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;

  const accountId = String(
    input.accountId
    ?? atAuth.chatgpt_account_id
    ?? '',
  );
  const userId = String(
    input.userId
    ?? atAuth.chatgpt_user_id
    ?? '',
  );

  let organizationId = String(
    input.organizationId
    ?? itAuth.organization_id
    ?? '',
  );
  if (!organizationId) {
    const orgs = Array.isArray(itAuth.organizations) ? itAuth.organizations : [];
    if (orgs.length > 0) {
      organizationId = String((orgs[0] as Record<string, unknown>)?.id ?? '');
    }
  }

  const expTimestamp = Number(atPayload.exp ?? 0);
  const credentials: Record<string, unknown> = {
    access_token: accessToken,
  };

  const expiresAt = String(input.expiredAt ?? '').trim();
  if (expiresAt) credentials.expires_at = expiresAt;
  else if (expTimestamp > 0) credentials.expires_at = new Date(expTimestamp * 1000).toISOString();

  if (refreshToken) credentials.refresh_token = refreshToken;
  if (idToken) credentials.id_token = idToken;
  if (String(input.email ?? '').trim()) credentials.email = String(input.email).trim();
  credentials.client_id = String(input.clientId ?? atPayload.client_id ?? OPENAI_OAUTH_CLIENT_ID).trim() || OPENAI_OAUTH_CLIENT_ID;
  if (accountId) credentials.chatgpt_account_id = accountId;
  if (userId) credentials.chatgpt_user_id = userId;
  if (organizationId) credentials.organization_id = organizationId;

  const planType = String(
    input.planType
    ?? atAuth.chatgpt_plan_type
    ?? itAuth.chatgpt_plan_type
    ?? '',
  );
  if (planType) credentials.plan_type = planType;

  if (input.modelMapping && typeof input.modelMapping === 'object' && Object.keys(input.modelMapping as object).length > 0) {
    credentials.model_mapping = input.modelMapping;
  }

  return credentials;
}
