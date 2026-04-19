import multer from 'multer';
import { Router, type Request, type Response } from 'express';
import {
  completeOpenAiOAuthSession,
  createOpenAiOAuthSession,
  getOpenAiOAuthServerConfig,
  type OpenAiOAuthCallbackResult,
  type OpenAiOAuthStartResult,
} from '../services/openai-oauth-capture.service.js';
import {
  importOpenAiOAuthJsonFiles,
  listManagedOpenAiOAuthFiles,
  matchManagedOpenAiOAuthFiles,
  updateMatchedRemoteFiles,
} from '../services/openai-oauth-file-sync.service.js';
import { logger } from '../utils/logger.js';

function buildCallbackUrl(req: Request): string {
  void req;
  return `${getOpenAiOAuthServerConfig().baseUrl}/auth/callback`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderErrorHtml(input: {
  error: string;
}): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenAI 授权失败</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 32px; }
    .card { max-width: 720px; margin: 0 auto; background: #111827; border: 1px solid #334155; border-radius: 16px; padding: 24px; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; background: #7f1d1d; color: #fecaca; font-size: 12px; }
    pre { white-space: pre-wrap; word-break: break-word; background: #020617; border: 1px solid #334155; border-radius: 12px; padding: 12px; }
    a { color: #93c5fd; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">授权失败</div>
    <h1>OpenAI OAuth 回调失败</h1>
    <pre>${escapeHtml(input.error)}</pre>
  </div>
</body>
</html>`;
}

function renderIndexHtml(input: {
  authUrl: string;
  sessionId: string;
}): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenAI OAuth 认证</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif; background: linear-gradient(135deg, #1d4ed8 0%, #0f172a 100%); padding: 24px; }
    .card { width: min(100%, 520px); border-radius: 20px; background: #ffffff; padding: 40px 32px; box-shadow: 0 24px 80px rgba(15, 23, 42, 0.35); text-align: center; }
    h1 { margin: 0 0 16px; color: #0f172a; font-size: 28px; }
    p { margin: 0 0 28px; color: #475569; line-height: 1.7; }
    .auth-link { display: inline-block; padding: 14px 34px; background: linear-gradient(135deg, #10a37f 0%, #0f8a6d 100%); color: #fff; font-weight: 700; text-decoration: none; border-radius: 999px; box-shadow: 0 10px 28px rgba(16, 163, 127, 0.35); }
    .meta { margin-top: 28px; font-size: 12px; color: #64748b; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; }
    code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
  </style>
</head>
<body>
  <div class="card">
    <h1>OpenAI OAuth 认证</h1>
    <p>点击下方按钮开始授权。回调成功后，账号会直接写成当前项目可导入的 JSON 文件。</p>
    <a class="auth-link" href="${escapeHtml(input.authUrl)}">开始认证</a>
    <div class="meta">Session ID: <code>${escapeHtml(input.sessionId)}</code></div>
  </div>
</body>
</html>`;
}

function renderSuccessHtml(input: {
  result?: OpenAiOAuthCallbackResult;
  returnTo: string;
}): string {
  const result = input.result;
  const returnLink = input.returnTo
    ? `<p><a href="${escapeHtml(input.returnTo)}">返回来源页面</a></p>`
    : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenAI 授权成功</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #020617; color: #e2e8f0; margin: 0; padding: 32px; }
    .card { max-width: 760px; margin: 0 auto; background: #0f172a; border: 1px solid #1e293b; border-radius: 16px; padding: 24px; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; background: #14532d; color: #bbf7d0; font-size: 12px; }
    dl { display: grid; grid-template-columns: 140px 1fr; gap: 12px; margin-top: 20px; }
    dt { color: #94a3b8; }
    dd { margin: 0; word-break: break-word; }
    code { background: #111827; border: 1px solid #334155; border-radius: 8px; padding: 2px 6px; }
    a { color: #93c5fd; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">已写入 JSON</div>
    <h1>OpenAI OAuth 回调完成</h1>
    <p>账号信息已经落盘为当前项目可直接导入的 JSON。</p>
    <dl>
      <dt>邮箱</dt>
      <dd>${escapeHtml(result?.record.email ?? '-')}</dd>
      <dt>文件名</dt>
      <dd><code>${escapeHtml(result?.savedFile.filename ?? '-')}</code></dd>
      <dt>保存目录</dt>
      <dd><code>${escapeHtml(result?.outputDir ?? '-')}</code></dd>
      <dt>完整路径</dt>
      <dd><code>${escapeHtml(result?.savedFile.path ?? '-')}</code></dd>
      <dt>Plan Type</dt>
      <dd>${escapeHtml(result?.record.plan_type ?? '-')}</dd>
      <dt>Account ID</dt>
      <dd>${escapeHtml(result?.record.account_id ?? '-')}</dd>
      <dt>Organization ID</dt>
      <dd>${escapeHtml(result?.record.organization_id ?? '-')}</dd>
    </dl>
    ${returnLink}
  </div>
</body>
</html>`;
}

function buildCompatApiPayload(result: OpenAiOAuthStartResult): Record<string, unknown> {
  return {
    session_id: result.sessionId,
    state: result.state,
    auth_url: result.authUrl,
    created_at: Date.parse(result.createdAt) / 1000,
    expires_at: result.expiresAt,
    redirect_uri: result.redirectUri,
    output_dir: result.outputDir,
  };
}

function buildSuccessRedirect(result: OpenAiOAuthCallbackResult): string {
  const params = new URLSearchParams();
  params.set('email', result.record.email);
  params.set('filename', result.savedFile.filename);
  params.set('output_dir', result.outputDir);
  params.set('path', result.savedFile.path);
  if (result.record.plan_type) params.set('plan_type', result.record.plan_type);
  if (result.record.account_id) params.set('account_id', result.record.account_id);
  if (result.record.organization_id) params.set('organization_id', result.record.organization_id);
  if (result.returnTo) params.set('return_to', result.returnTo);
  return `/success?${params.toString()}`;
}

export function handleOpenAiAuthIndex(req: Request, res: Response): void {
  const result = createOpenAiOAuthSession(buildCallbackUrl(req));
  res.type('html').send(renderIndexHtml({
    authUrl: result.authUrl,
    sessionId: result.sessionId,
  }));
}

export function handleOpenAiAuthUrl(req: Request, res: Response): void {
  const result = createOpenAiOAuthSession(buildCallbackUrl(req));
  res.json(buildCompatApiPayload(result));
}

export function handleOpenAiAuthSuccess(req: Request, res: Response): void {
  const email = String(req.query.email ?? '').trim();
  const filename = String(req.query.filename ?? '').trim();
  const outputDir = String(req.query.output_dir ?? '').trim();
  const filePath = String(req.query.path ?? '').trim();
  const planType = String(req.query.plan_type ?? '').trim();
  const accountId = String(req.query.account_id ?? '').trim();
  const organizationId = String(req.query.organization_id ?? '').trim();
  const returnTo = String(req.query.return_to ?? '').trim();

  const result = email || filename || filePath
    ? {
        outputDir,
        returnTo,
        savedFile: {
          email,
          filename,
          path: filePath,
          savedAt: '',
          sizeBytes: 0,
        },
        record: {
          email,
          access_token: '',
          plan_type: planType || undefined,
          account_id: accountId || undefined,
          organization_id: organizationId || undefined,
        },
      } satisfies OpenAiOAuthCallbackResult
    : undefined;

  res.type('html').send(renderSuccessHtml({ result, returnTo }));
}

export async function handleOpenAiAuthCallback(req: Request, res: Response): Promise<void> {
  const error = String(req.query.error ?? '').trim();
  const errorDescription = String(req.query.error_description ?? '').trim();
  const code = String(req.query.code ?? '').trim();
  const state = String(req.query.state ?? '').trim();

  if (error) {
    const message = errorDescription ? `${error}: ${errorDescription}` : error;
    res.status(400).type('html').send(renderErrorHtml({ error: message }));
    return;
  }

  if (!code || !state) {
    res.status(400).type('html').send(renderErrorHtml({ error: '回调参数缺失：需要 code 和 state' }));
    return;
  }

  try {
    const result = await completeOpenAiOAuthSession(state, code);
    res.redirect(buildSuccessRedirect(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'OAuth callback failed';
    logger.error({ err }, 'openai oauth callback failed');
    const statusCode = (err as Error & { statusCode?: number }).statusCode ?? 500;
    res.status(statusCode).type('html').send(renderErrorHtml({ error: message }));
  }
}

export const openaiAuthRoutes: ReturnType<typeof Router> = Router();
const uploadJsonFiles = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 500 },
});

openaiAuthRoutes.post('/start', (req, res) => {
  const returnTo = String(req.body?.returnTo ?? '').trim();
  const redirectUri = buildCallbackUrl(req);
  const result = createOpenAiOAuthSession(redirectUri, returnTo);
  res.json(result);
});

openaiAuthRoutes.get('/files', (_req, res) => {
  res.json(listManagedOpenAiOAuthFiles());
});

openaiAuthRoutes.post('/import-files', uploadJsonFiles.array('files', 500), (req, res) => {
  try {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      return res.status(400).json({ error: '请上传至少一个 JSON 文件' });
    }

    const inputs = files.map((file) => ({
      originalName: file.originalname,
      content: file.buffer.toString('utf-8'),
    }));
    res.json(importOpenAiOAuthJsonFiles(inputs));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

openaiAuthRoutes.post('/match', async (req, res) => {
  const filePaths = Array.isArray(req.body?.filePaths)
    ? req.body.filePaths.map((item: unknown) => String(item))
    : [];
  if (filePaths.length === 0) return res.status(400).json({ error: '请提供 filePaths 数组' });

  try {
    res.json(await matchManagedOpenAiOAuthFiles(filePaths));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

openaiAuthRoutes.post('/update-remote', async (req, res) => {
  const filePaths = Array.isArray(req.body?.filePaths)
    ? req.body.filePaths.map((item: unknown) => String(item))
    : [];
  const dryRun = req.body?.dryRun === true;
  if (filePaths.length === 0) return res.status(400).json({ error: '请提供 filePaths 数组' });

  try {
    res.json(await updateMatchedRemoteFiles({ filePaths, dryRun }));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
