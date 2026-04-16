/** 通用响应评估：从响应体中提取 externalId 和错误信息 */
export function evaluateGenericResponse(
  statusCode: number,
  body: Record<string, unknown>,
): { ok: boolean; externalId: string; error: string } {
  // HTML 响应检测（URL 配置错误的常见表现）
  const text = String(body.text ?? '');
  if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
    return { ok: false, externalId: '', error: '响应为 HTML 页面，请检查 URL 配置' };
  }

  const ok = statusCode === 200 || statusCode === 201;

  // 提取 externalId
  const data = (body.data ?? {}) as Record<string, unknown>;
  const account = (data.account ?? {}) as Record<string, unknown>;
  const externalId = String(
    body.id ?? body.account_id ?? body.external_id ??
    data.id ?? data.account_id ?? account.id ?? '',
  );

  // 提取错误信息
  const error = ok
    ? ''
    : String(body.error ?? body.message ?? body.msg ?? body.detail ?? `HTTP ${statusCode}`).slice(0, 400);

  return { ok, externalId, error };
}
