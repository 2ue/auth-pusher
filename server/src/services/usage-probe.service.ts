/**
 * 独立用量探测服务
 * 直接用账号 accessToken 调 ChatGPT API 获取 Codex 5h/7d rate limit 数据
 */
import axios from 'axios';
import type { AccountProbeState, AccountUsageStatus, UsageSnapshot } from '../../../shared/types/account.js';
import * as settingsStore from '../persistence/settings.store.js';

export const FALLBACK_OPENAI_PROBE_MODEL = process.env.OPENAI_PROBE_MODEL?.trim() || 'gpt-5.2';
export const FALLBACK_OPENAI_TEST_MODEL = process.env.OPENAI_TEST_MODEL?.trim()
  || process.env.OPENAI_PROBE_MODEL?.trim()
  || FALLBACK_OPENAI_PROBE_MODEL;

export interface ProbeTarget {
  id?: string;
  email: string;
  accessToken: string;
  accountId?: string;
  planType?: string;
}

export interface AccountUsageResult {
  accountId?: string;
  email: string;
  planType?: string;
  status: AccountUsageStatus;
  usage: UsageSnapshot | null;
  errorMessage: string;
}

export interface BatchUsageResult {
  total: number;
  probed: number;
  results: AccountUsageResult[];
}

export interface ProbeBatchOptions {
  concurrency?: number;
  model?: string;
  onResult?: (result: AccountUsageResult, target: ProbeTarget, index: number) => void | Promise<void>;
}

function normalizeModelId(value: string | undefined): string {
  return value?.trim() || '';
}

export function resolveProbeModel(model?: string): string {
  const explicit = normalizeModelId(model);
  if (explicit) return explicit;

  const settingsModel = normalizeModelId(settingsStore.load().defaultProbeModel);
  return settingsModel || FALLBACK_OPENAI_PROBE_MODEL;
}

export function resolveTestModel(model?: string): string {
  const explicit = normalizeModelId(model);
  if (explicit) return explicit;

  const settingsModel = normalizeModelId(settingsStore.load().defaultTestModel);
  return settingsModel || FALLBACK_OPENAI_TEST_MODEL;
}

async function readStreamSnippet(stream: unknown, maxBytes = 4096): Promise<string> {
  if (!stream || typeof stream !== 'object' || typeof (stream as { on?: unknown }).on !== 'function') {
    return '';
  }

  return await new Promise<string>((resolve) => {
    const readable = stream as NodeJS.ReadableStream & {
      destroy?: () => void;
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    };
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;

    const cleanup = () => {
      const off = readable.off?.bind(readable) ?? readable.removeListener?.bind(readable);
      off?.('data', onData);
      off?.('end', onDone);
      off?.('error', onDone);
    };

    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      readable.destroy?.();
      resolve(Buffer.concat(chunks, total).toString('utf8').trim());
    };

    const onData = (chunk: Buffer | string) => {
      if (done) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (buf.length === 0) return;
      const remaining = maxBytes - total;
      if (remaining <= 0) {
        finish();
        return;
      }
      const slice = buf.subarray(0, remaining);
      chunks.push(slice);
      total += slice.length;
      if (total >= maxBytes) finish();
    };

    const onDone = () => finish();

    readable.on('data', onData);
    readable.on('end', onDone);
    readable.on('error', onDone);
  });
}

function extractErrorMessage(rawBody: string, status: number): string {
  const body = rawBody.trim();
  if (!body) return `HTTP ${status}`;

  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    const detail = typeof parsed.error === 'string'
      ? parsed.error
      : parsed.error?.message ?? parsed.message ?? body;
    return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
  } catch {
    return `HTTP ${status}: ${body.slice(0, 300)}`;
  }
}

export function extractRateLimitHeaders(headers: Record<string, string | string[] | undefined>): UsageSnapshot | null {
  const primaryUsed = parseFloat(String(headers['x-codex-primary-used-percent'] ?? ''));
  const primaryReset = parseInt(String(headers['x-codex-primary-reset-after-seconds'] ?? ''), 10);
  const primaryWindow = parseInt(String(headers['x-codex-primary-window-minutes'] ?? ''), 10);
  const secondaryUsed = parseFloat(String(headers['x-codex-secondary-used-percent'] ?? ''));
  const secondaryReset = parseInt(String(headers['x-codex-secondary-reset-after-seconds'] ?? ''), 10);
  const secondaryWindow = parseInt(String(headers['x-codex-secondary-window-minutes'] ?? ''), 10);

  if (isNaN(primaryUsed) && isNaN(secondaryUsed)) return null;

  const now = Date.now();
  let used5h: number;
  let reset5hSec: number;
  let used7d: number;
  let reset7dSec: number;
  if (!isNaN(primaryWindow) && !isNaN(secondaryWindow) && primaryWindow > secondaryWindow) {
    used5h = secondaryUsed;
    reset5hSec = secondaryReset;
    used7d = primaryUsed;
    reset7dSec = primaryReset;
  } else {
    used5h = primaryUsed;
    reset5hSec = primaryReset;
    used7d = secondaryUsed;
    reset7dSec = secondaryReset;
  }

  return {
    fiveHourUsed: isNaN(used5h) ? 0 : used5h,
    fiveHourResetAt: isNaN(reset5hSec) ? '' : new Date(now + reset5hSec * 1000).toISOString(),
    sevenDayUsed: isNaN(used7d) ? 0 : used7d,
    sevenDayResetAt: isNaN(reset7dSec) ? '' : new Date(now + reset7dSec * 1000).toISOString(),
  };
}

export async function probeAccountUsage(
  accountId: string | undefined,
  email: string,
  planType: string | undefined,
  accessToken: string,
  chatgptAccountId?: string,
  model?: string,
): Promise<AccountUsageResult> {
  try {
    const modelId = resolveProbeModel(model);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'text/event-stream',
      'OpenAI-Beta': 'responses=experimental',
    };
    if (chatgptAccountId) headers['chatgpt-account-id'] = chatgptAccountId;

    const res = await axios.post('https://chatgpt.com/backend-api/codex/responses', {
      model: modelId,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: true, store: false, instructions: 'You are a helpful assistant.',
    }, {
      headers,
      timeout: 30000,
      validateStatus: () => true, // 不抛异常，我们需要读 429 的 headers
      responseType: 'stream',
    });

    const usage = extractRateLimitHeaders(res.headers as Record<string, string | string[] | undefined>);
    const stream = res.data as NodeJS.ReadableStream & { destroy?: () => void } | undefined;

    if (!usage) {
      if (res.status === 401 || res.status === 403) {
        stream?.destroy?.();
        return { accountId, email, planType, status: 'token_invalid', usage: null, errorMessage: `HTTP ${res.status}` };
      }
      if (res.status === 429) {
        stream?.destroy?.();
        return {
          accountId,
          email,
          planType,
          status: 'rate_limited',
          usage: { fiveHourUsed: 100, fiveHourResetAt: '', sevenDayUsed: 100, sevenDayResetAt: '' },
          errorMessage: '限流中',
        };
      }
      if (res.status < 200 || res.status >= 300) {
        const body = await readStreamSnippet(stream);
        return {
          accountId,
          email,
          planType,
          status: 'error',
          usage: null,
          errorMessage: extractErrorMessage(body, res.status),
        };
      }
      stream?.destroy?.();
      return { accountId, email, planType, status: 'ok', usage: null, errorMessage: '' };
    }

    stream?.destroy?.();

    return {
      accountId, email, planType, status: 'ok', errorMessage: '',
      usage,
    };
  } catch (err) {
    return {
      accountId,
      email,
      planType,
      status: 'error',
      usage: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function probeBatchUsage(
  accounts: ProbeTarget[],
  options: ProbeBatchOptions = {},
): Promise<BatchUsageResult> {
  const results: AccountUsageResult[] = [];
  const queue = [...accounts];
  const concurrency = Math.max(1, options.concurrency ?? 5);
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const currentIndex = index++;
      const acc = queue.shift()!;
      const result = await probeAccountUsage(
        acc.id,
        acc.email,
        acc.planType,
        acc.accessToken,
        acc.accountId,
        options.model,
      );
      results.push(result);
      await options.onResult?.(result, acc, currentIndex);
    }
  });
  await Promise.all(workers);
  return { total: accounts.length, probed: results.length, results };
}

export function toProbeState(result: AccountUsageResult): AccountProbeState {
  return {
    status: result.status,
    usage: result.usage,
    errorMessage: result.errorMessage,
    probedAt: new Date().toISOString(),
  };
}
