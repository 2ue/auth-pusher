import axios from 'axios';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../persistence/json-store.js';
import {
  decodeIdTokenEmail,
  decodeIdTokenOrg,
  decodeJwtPayload,
  decodeOpenAiJwt,
  resolvePlanTypeFromTokens,
} from '../utils/jwt.js';
import { logger } from '../utils/logger.js';

const OPENAI_OAUTH_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const OPENAI_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_OAUTH_SCOPE = 'openid email profile offline_access';
const OPENAI_REFRESH_SCOPE = 'openid profile email';
const OPENAI_OAUTH_USER_AGENT = 'codex-cli/0.91.0';
const SESSION_TTL_MS = 30 * 60 * 1000;
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const OUTPUT_DIR_NAME = 'openai-oauth-json';
const DEFAULT_OAUTH_HOST = process.env.OPENAI_OAUTH_HOST?.trim() || 'localhost';
const DEFAULT_OAUTH_PORT = Number(process.env.OPENAI_OAUTH_PORT ?? 1455) || 1455;
const DEFAULT_OAUTH_BASE_URL = process.env.OPENAI_OAUTH_BASE_URL?.trim() || `http://${DEFAULT_OAUTH_HOST}:${DEFAULT_OAUTH_PORT}`;

interface PendingOpenAiOAuthSession {
  codeVerifier: string;
  createdAt: number;
  redirectUri: string;
  returnTo: string;
  sessionId: string;
  state: string;
}

interface OpenAiOAuthTokenResponse {
  access_token: string;
  expires_in: number;
  id_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type: string;
}

export interface OpenAiOAuthStartResult {
  authUrl: string;
  createdAt: string;
  expiresAt: string;
  outputDir: string;
  redirectUri: string;
  sessionId: string;
  state: string;
}

export interface OpenAiOAuthCapturedJson {
  access_token: string;
  account_id?: string;
  email: string;
  id_token?: string;
  organization_id?: string;
  plan_type?: string;
  refresh_token?: string;
}

export interface OpenAiOAuthSavedFile {
  email: string;
  filename: string;
  path: string;
  savedAt: string;
  sizeBytes: number;
}

export interface OpenAiOAuthFilesResult {
  directory: string;
  files: OpenAiOAuthSavedFile[];
}

export interface OpenAiOAuthCallbackResult {
  outputDir: string;
  record: OpenAiOAuthCapturedJson;
  returnTo: string;
  savedFile: OpenAiOAuthSavedFile;
}

export interface OpenAiOAuthServerConfig {
  baseUrl: string;
  host: string;
  port: number;
}

const pendingSessions = new Map<string, PendingOpenAiOAuthSession>();

const cleanupTimer = setInterval(() => {
  cleanupExpiredSessions();
}, SESSION_CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();

function cleanupExpiredSessions(now = Date.now()): void {
  for (const [state, session] of pendingSessions.entries()) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      pendingSessions.delete(state);
    }
  }
}

function ensureDir(dir: string): string {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getOpenAiOAuthOutputDir(): string {
  return ensureDir(path.join(getDataDir(), OUTPUT_DIR_NAME));
}

export function getOpenAiOAuthServerConfig(): OpenAiOAuthServerConfig {
  return {
    baseUrl: DEFAULT_OAUTH_BASE_URL,
    host: DEFAULT_OAUTH_HOST,
    port: DEFAULT_OAUTH_PORT,
  };
}

function generateState(): string {
  return randomBytes(16).toString('hex');
}

function generateSessionId(): string {
  return randomBytes(8).toString('hex');
}

function generateCodeVerifier(): string {
  return randomBytes(96).toString('base64url');
}

function generateCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

function normalizeText(value: unknown): string {
  return String(value ?? '').trim();
}

function sanitizeEmailFilename(email: string): string {
  const normalized = normalizeText(email).toLowerCase();
  const safe = normalized
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 180);
  return `${safe || `openai-oauth-${Date.now()}`}.json`;
}

function buildAuthorizationUrl(state: string, codeChallenge: string, redirectUri: string): string {
  const params = new URLSearchParams();
  params.set('response_type', 'code');
  params.set('client_id', OPENAI_OAUTH_CLIENT_ID);
  params.set('redirect_uri', redirectUri);
  params.set('scope', OPENAI_OAUTH_SCOPE);
  params.set('state', state);
  params.set('code_challenge', codeChallenge);
  params.set('code_challenge_method', 'S256');
  params.set('prompt', 'login');
  params.set('id_token_add_organizations', 'true');
  params.set('codex_cli_simplified_flow', 'true');
  return `${OPENAI_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

export function createOpenAiOAuthSession(redirectUri: string, returnTo = ''): OpenAiOAuthStartResult {
  cleanupExpiredSessions();

  const sessionId = generateSessionId();
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const createdAt = Date.now();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  pendingSessions.set(state, {
    state,
    sessionId,
    codeVerifier,
    redirectUri,
    returnTo,
    createdAt,
  });

  return {
    authUrl: buildAuthorizationUrl(state, codeChallenge, redirectUri),
    createdAt: new Date(createdAt).toISOString(),
    redirectUri,
    expiresAt: new Date(createdAt + SESSION_TTL_MS).toISOString(),
    outputDir: getOpenAiOAuthOutputDir(),
    sessionId,
    state,
  };
}

async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<OpenAiOAuthTokenResponse> {
  const form = new URLSearchParams();
  form.set('grant_type', 'authorization_code');
  form.set('client_id', OPENAI_OAUTH_CLIENT_ID);
  form.set('code', code);
  form.set('redirect_uri', redirectUri);
  form.set('code_verifier', codeVerifier);

  const response = await axios.post<OpenAiOAuthTokenResponse>(OPENAI_OAUTH_TOKEN_URL, form.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': OPENAI_OAUTH_USER_AGENT,
    },
    timeout: 60_000,
    validateStatus: () => true,
  });

  if (response.status !== 200) {
    const body = typeof response.data === 'object' && response.data
      ? JSON.stringify(response.data)
      : String(response.data ?? '');
    const error = new Error(`OpenAI token exchange failed: HTTP ${response.status}${body ? ` ${body}` : ''}`);
    (error as Error & { statusCode?: number }).statusCode = 502;
    throw error;
  }

  return response.data;
}

function buildCapturedJson(tokenResponse: OpenAiOAuthTokenResponse): OpenAiOAuthCapturedJson {
  const accessToken = normalizeText(tokenResponse.access_token);
  const refreshToken = normalizeText(tokenResponse.refresh_token);
  const idToken = normalizeText(tokenResponse.id_token);
  const accessClaims = decodeOpenAiJwt(accessToken);
  const idClaims = decodeJwtPayload(idToken) ?? {};
  const idAuth = (idClaims['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;

  const email = accessClaims.email || decodeIdTokenEmail(idToken);
  if (!email) {
    const error = new Error('授权成功，但未能从 token 中解析出邮箱');
    (error as Error & { statusCode?: number }).statusCode = 422;
    throw error;
  }

  const record: OpenAiOAuthCapturedJson = {
    email,
    access_token: accessToken,
  };

  if (refreshToken) record.refresh_token = refreshToken;
  if (idToken) record.id_token = idToken;

  const accountId = accessClaims.accountId || normalizeText(idAuth.chatgpt_account_id);
  const organizationId = decodeIdTokenOrg(idToken) || accessClaims.organizationId || normalizeText(idAuth.organization_id ?? idAuth.poid);
  const planType = resolvePlanTypeFromTokens(accessToken, idToken);

  if (accountId) record.account_id = accountId;
  if (organizationId) record.organization_id = organizationId;
  if (planType) record.plan_type = planType;

  return record;
}

function writeCapturedJson(record: OpenAiOAuthCapturedJson): OpenAiOAuthSavedFile {
  const outputDir = getOpenAiOAuthOutputDir();
  const filename = sanitizeEmailFilename(record.email);
  const filePath = path.join(outputDir, filename);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(record, null, 2), 'utf-8');
  fs.renameSync(tempPath, filePath);

  const stat = fs.statSync(filePath);
  return {
    filename,
    email: record.email,
    path: filePath,
    savedAt: stat.mtime.toISOString(),
    sizeBytes: stat.size,
  };
}

export async function completeOpenAiOAuthSession(state: string, code: string): Promise<OpenAiOAuthCallbackResult> {
  cleanupExpiredSessions();

  const session = pendingSessions.get(state);
  if (!session) {
    const error = new Error('授权会话不存在或已过期，请重新发起授权');
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }

  pendingSessions.delete(state);

  const tokenResponse = await exchangeCodeForTokens(code, session.codeVerifier, session.redirectUri);
  const record = buildCapturedJson(tokenResponse);
  const savedFile = writeCapturedJson(record);

  logger.info({ path: savedFile.path }, '凭证已保存到文件');
  logger.info(
    {
      email: record.email,
      filename: savedFile.filename,
      scope: normalizeText(tokenResponse.scope) || OPENAI_REFRESH_SCOPE,
    },
    'Token 获取成功',
  );

  return {
    record,
    savedFile,
    returnTo: session.returnTo,
    outputDir: getOpenAiOAuthOutputDir(),
  };
}

export function listOpenAiOAuthFiles(): OpenAiOAuthFilesResult {
  const directory = getOpenAiOAuthOutputDir();
  const files = fs.readdirSync(directory)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .map((filename) => {
      const filePath = path.join(directory, filename);
      const stat = fs.statSync(filePath);
      return {
        filename,
        email: filename.replace(/\.json$/i, ''),
        path: filePath,
        savedAt: stat.mtime.toISOString(),
        sizeBytes: stat.size,
      } satisfies OpenAiOAuthSavedFile;
    })
    .sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));

  return { directory, files };
}
