export interface JwtAuthClaims {
  email: string;
  planType: string;
  accountId: string;
  userId: string;
  organizationId: string;
  exp: number;
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  if (!token) return null;

  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    let payload = parts[1];
    payload += '='.repeat((4 - payload.length % 4) % 4);
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 解码 JWT payload（不验证签名），提取 OpenAI auth 相关字段 */
export function decodeOpenAiJwt(token: string): JwtAuthClaims {
  const empty: JwtAuthClaims = { email: '', planType: '', accountId: '', userId: '', organizationId: '', exp: 0 };
  if (!token) return empty;

  try {
    const claims = decodeJwtPayload(token);
    if (!claims) return empty;

    const auth = (claims['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
    const profile = (claims['https://api.openai.com/profile'] ?? {}) as Record<string, unknown>;
    const organizations = Array.isArray(auth.organizations) ? auth.organizations : [];
    const defaultOrg = organizations.find((org) => (org as Record<string, unknown>)?.is_default === true) as Record<string, unknown> | undefined;
    const fallbackOrg = defaultOrg ?? (organizations[0] as Record<string, unknown> | undefined);

    return {
      email: String(profile.email ?? claims.email ?? ''),
      planType: String(auth.chatgpt_plan_type ?? ''),
      accountId: String(auth.chatgpt_account_id ?? ''),
      userId: String(auth.chatgpt_user_id ?? ''),
      organizationId: String(auth.organization_id ?? auth.poid ?? fallbackOrg?.id ?? ''),
      exp: Number(claims.exp ?? 0),
    };
  } catch {
    return empty;
  }
}

/** 从 id_token 解码 plan_type */
export function decodeIdTokenPlanType(idToken: string): string {
  if (!idToken) return '';
  try {
    const claims = decodeJwtPayload(idToken);
    if (!claims) return '';
    const auth = (claims['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
    return String(auth.chatgpt_plan_type ?? '');
  } catch {
    return '';
  }
}

/**
 * 从 access_token 和 id_token 中解析 plan_type
 * 优先级：access_token JWT > id_token JWT
 */
export function resolvePlanTypeFromTokens(accessToken: string, idToken: string): string {
  const atClaims = decodeOpenAiJwt(accessToken);
  if (atClaims.planType) return atClaims.planType;

  const itPlanType = decodeIdTokenPlanType(idToken);
  if (itPlanType) return itPlanType;

  if (accessToken || idToken) {
    // plan_type 无法从 token 中解析，静默跳过
  }
  return '';
}

/** 从 id_token 解码 organization_id */
export function decodeIdTokenOrg(idToken: string): string {
  if (!idToken) return '';
  try {
    const claims = decodeJwtPayload(idToken);
    if (!claims) return '';
    const auth = (claims['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;

    let orgId = String(auth.organization_id ?? '');
    if (!orgId) {
      const orgs = Array.isArray(auth.organizations) ? auth.organizations : [];
      const defaultOrg = orgs.find((org) => (org as Record<string, unknown>)?.is_default === true) as Record<string, unknown> | undefined;
      const fallbackOrg = defaultOrg ?? (orgs[0] as Record<string, unknown> | undefined);
      orgId = String(fallbackOrg?.id ?? auth.poid ?? '');
    }
    return orgId;
  } catch {
    return '';
  }
}

export function decodeIdTokenEmail(idToken: string): string {
  const claims = decodeJwtPayload(idToken);
  if (!claims) return '';
  return String(claims.email ?? '');
}
