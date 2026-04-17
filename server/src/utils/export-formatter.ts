import { decodeOpenAiJwt } from './jwt.js';

export type ExportFormat = 'raw' | 'cpa' | 'sub2api';
export type ExportMode = 'individual' | 'merged';

const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

export function pickField(fields: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const direct = fields[key];
    if (direct != null && String(direct).trim()) return String(direct);
    if (key.includes('.')) {
      const parts = key.split('.');
      let current: unknown = fields;
      for (const part of parts) {
        if (!current || typeof current !== 'object' || Array.isArray(current)) { current = undefined; break; }
        current = (current as Record<string, unknown>)[part];
      }
      if (current != null && String(current).trim()) return String(current);
    }
  }
  return '';
}

export function formatRaw(fields: Record<string, unknown>): Record<string, unknown> {
  const email = pickField(fields, ['email', 'Email', 'extra.email']);
  const accessToken = pickField(fields, ['access_token', 'accessToken', 'credentials.access_token']);
  const refreshToken = pickField(fields, ['refresh_token', 'refreshToken', 'credentials.refresh_token']);
  const idToken = pickField(fields, ['id_token', 'idToken', 'credentials.id_token']);
  const accountId = pickField(fields, ['account_id', 'accountId', 'credentials.chatgpt_account_id']);
  const planType = pickField(fields, ['plan_type', 'planType', 'credentials.plan_type']);

  const out: Record<string, unknown> = { email, access_token: accessToken };
  if (refreshToken) out.refresh_token = refreshToken;
  if (idToken) out.id_token = idToken;
  if (accountId) out.account_id = accountId;
  if (planType) out.plan_type = planType;
  return out;
}

export function formatCpa(fields: Record<string, unknown>): Record<string, unknown> {
  const email = pickField(fields, ['email', 'Email', 'extra.email']);
  const accessToken = pickField(fields, ['access_token', 'accessToken', 'credentials.access_token']);
  const refreshToken = pickField(fields, ['refresh_token', 'refreshToken', 'credentials.refresh_token']);
  const idToken = pickField(fields, ['id_token', 'idToken', 'credentials.id_token']);
  const sessionToken = pickField(fields, ['session_token', 'sessionToken']);
  const accountId = pickField(fields, ['account_id', 'accountId', 'credentials.chatgpt_account_id']);

  const out: Record<string, unknown> = { email, access_token: accessToken };
  if (refreshToken) out.refresh_token = refreshToken;
  if (idToken) out.id_token = idToken;
  if (sessionToken) out.session_token = sessionToken;
  if (accountId) out.account_id = accountId;
  return out;
}

export function formatSub2Api(fields: Record<string, unknown>): Record<string, unknown> {
  const email = pickField(fields, ['email', 'Email', 'extra.email']);
  const accessToken = pickField(fields, ['access_token', 'accessToken', 'credentials.access_token']);
  const refreshToken = pickField(fields, ['refresh_token', 'refreshToken', 'credentials.refresh_token']);
  const idToken = pickField(fields, ['id_token', 'idToken', 'credentials.id_token']);
  const accountIdField = pickField(fields, ['account_id', 'accountId', 'credentials.chatgpt_account_id']);
  const organizationIdField = pickField(fields, ['organization_id', 'organizationId', 'credentials.organization_id']);
  const planTypeField = pickField(fields, ['plan_type', 'planType', 'credentials.plan_type']);

  const atClaims = decodeOpenAiJwt(accessToken);
  const itClaims = decodeOpenAiJwt(idToken);

  const chatgptAccountId = accountIdField || atClaims.accountId;
  const chatgptUserId = atClaims.userId;
  const organizationId = organizationIdField || itClaims.organizationId;
  const planType = planTypeField || atClaims.planType || itClaims.planType;

  const credentials: Record<string, unknown> = {
    access_token: accessToken,
    client_id: OAUTH_CLIENT_ID,
  };
  if (atClaims.exp > 0) credentials.expires_at = new Date(atClaims.exp * 1000).toISOString();
  if (refreshToken) credentials.refresh_token = refreshToken;
  if (idToken) credentials.id_token = idToken;
  if (chatgptAccountId) credentials.chatgpt_account_id = chatgptAccountId;
  if (chatgptUserId) credentials.chatgpt_user_id = chatgptUserId;
  if (organizationId) credentials.organization_id = organizationId;
  if (planType) credentials.plan_type = planType;

  return {
    name: email,
    platform: 'openai',
    type: 'oauth',
    credentials,
    extra: { email },
  };
}

export function formatRecord(format: ExportFormat, fields: Record<string, unknown>): Record<string, unknown> {
  if (format === 'sub2api') return formatSub2Api(fields);
  if (format === 'cpa') return formatCpa(fields);
  return formatRaw(fields);
}

/** 将 Account 对象转为可导出的 fields 格式 */
export function accountToFields(account: {
  email: string; accessToken: string; refreshToken: string; idToken: string;
  accountId: string; organizationId: string; planType: string;
}): Record<string, unknown> {
  return {
    email: account.email,
    access_token: account.accessToken,
    refresh_token: account.refreshToken,
    id_token: account.idToken,
    account_id: account.accountId,
    organization_id: account.organizationId,
    plan_type: account.planType,
  };
}
