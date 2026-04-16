/** 常见字段名的别名映射 */
const FIELD_ALIASES: Record<string, string[]> = {
  email: ['email', 'user_email', 'mail', 'account', 'username', 'user', 'name', 'account_email'],
  access_token: ['access_token', 'accessToken', 'at', 'token', 'codex_access_token', 'credentials.access_token'],
  refresh_token: ['refresh_token', 'refreshToken', 'rt', 'refresh', 'credentials.refresh_token'],
  id_token: ['id_token', 'idToken', 'it', 'credentials.id_token'],
  session_token: ['session_token', 'sessionToken', 'st', 'session', 'cookie', 'refresh_cookie'],
  account_id: ['account_id', 'accountId', 'chatgpt_account_id', 'credentials.chatgpt_account_id'],
  organization_id: ['organization_id', 'org_id', 'orgId', 'credentials.organization_id'],
  plan_type: ['plan_type', 'planType', 'plan', 'type'],
};

/**
 * 根据检测到的字段名，自动推断标准字段映射
 */
export function detectFieldMapping(
  detectedFields: string[],
  requiredFields: string[],
  optionalFields: string[],
): Record<string, string> {
  const mapping: Record<string, string> = {};
  const lowerFields = new Map<string, string>();

  for (const f of detectedFields) {
    lowerFields.set(f.toLowerCase(), f);
  }

  const targetFields = [...requiredFields, ...optionalFields];

  for (const standard of targetFields) {
    const aliases = FIELD_ALIASES[standard] ?? [standard];

    for (const alias of aliases) {
      // 精确匹配（忽略大小写）
      const matched = lowerFields.get(alias.toLowerCase());
      if (matched) {
        mapping[standard] = matched;
        break;
      }
    }

    // 如果没精确匹配，尝试包含匹配
    if (!mapping[standard]) {
      for (const [lower, original] of lowerFields) {
        if (lower.includes(standard.toLowerCase()) || standard.toLowerCase().includes(lower)) {
          mapping[standard] = original;
          break;
        }
      }
    }
  }

  return mapping;
}
