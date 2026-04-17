/* ── 数据解析 / 导出相关纯函数 ── */

export function getByPath(obj: Record<string, unknown>, fieldPath: string): unknown {
  if (!fieldPath) return undefined;
  if (fieldPath in obj) return obj[fieldPath];

  const parts = fieldPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function pickMappedValue(
  fields: Record<string, unknown>,
  fieldMapping: Record<string, string>,
  standardField: string,
  fallbacks: string[],
): string {
  const mappedPath = fieldMapping[standardField];
  const candidates = [
    mappedPath ? getByPath(fields, mappedPath) : undefined,
    ...fallbacks.map((key) => getByPath(fields, key)),
  ];

  for (const candidate of candidates) {
    const text = String(candidate ?? '').trim();
    if (text) return text;
  }
  return '';
}

export function decodeTokenClaims(accessToken: string): { email: string; accountId: string; planType: string } {
  const empty = { email: '', accountId: '', planType: '' };
  if (!accessToken) return empty;

  try {
    const parts = accessToken.split('.');
    if (parts.length < 2) return empty;
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
    const auth = (payload['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
    const profile = (payload['https://api.openai.com/profile'] ?? {}) as Record<string, unknown>;
    return {
      email: String(profile.email ?? '').trim(),
      accountId: String(auth.chatgpt_account_id ?? '').trim(),
      planType: String(auth.chatgpt_plan_type ?? '').trim(),
    };
  } catch {
    return empty;
  }
}

export function extractProbeTarget(
  fields: Record<string, unknown>,
  fieldMapping: Record<string, string>,
  planTypeOverride?: string,
): { email: string; accessToken: string; accountId?: string; planType?: string } {
  const accessToken = pickMappedValue(fields, fieldMapping, 'access_token', ['access_token', 'accessToken', 'token']);
  const claims = decodeTokenClaims(accessToken);
  const email = pickMappedValue(fields, fieldMapping, 'email', ['email', 'Email']) || claims.email;
  const accountId = pickMappedValue(fields, fieldMapping, 'account_id', ['account_id', 'accountId']) || claims.accountId;
  const planType = planTypeOverride?.trim()
    || pickMappedValue(fields, fieldMapping, 'plan_type', ['plan_type', 'planType'])
    || claims.planType;

  return {
    email,
    accessToken,
    accountId: accountId || undefined,
    planType: planType || undefined,
  };
}

export function sanitizeFilenamePart(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

export function buildExportFilename(index: number, email: string, accountId: string): string {
  const emailPart = sanitizeFilenamePart(email);
  if (emailPart) return `${emailPart}.json`;
  const accountPart = sanitizeFilenamePart(accountId);
  if (accountPart) return `${accountPart}.json`;
  return `record-${String(index + 1).padStart(4, '0')}.json`;
}

export function resolvePlanTypeOverride(preset: string, custom: string): string {
  if (preset === '__custom__') return custom.trim();
  return preset.trim();
}

/** 导入时的 plan type 选项（自动识别 = 不覆盖） */
export const PLAN_TYPE_OPTIONS = [
  { value: '', label: '自动识别' },
  { value: 'free', label: 'free' },
  { value: 'plus', label: 'plus' },
  { value: 'pro', label: 'pro' },
  { value: 'team', label: 'team' },
  { value: '__custom__', label: '其他' },
];

/** 导出时的 plan type 覆盖选项（跟随原数据 = 不覆盖） */
export const EXPORT_PLAN_OPTIONS = [
  { value: '', label: '跟随原数据' },
  { value: 'free', label: 'free' },
  { value: 'plus', label: 'plus' },
  { value: 'pro', label: 'pro' },
  { value: 'team', label: 'team' },
  { value: '__custom__', label: '自定义' },
];
