/**
 * 账号可用性测试服务（SSE 流式）
 * 对单个或多个账号发起真实 API 请求，验证 Token 可用性并流式返回结果
 */
import type { Response } from 'express';
import axios from 'axios';
import * as accountStore from '../persistence/account.store.js';
import { extractRateLimitHeaders, resolveTestModel, toProbeState } from './usage-probe.service.js';
import type { AccountUsageResult } from './usage-probe.service.js';

function sendSSE(res: Response, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function setSseHeaders(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

interface TestResult {
  success: boolean;
  content: string;
  error?: string;
}

async function doTestAccount(
  account: { id: string; email: string; accessToken: string; accountId?: string },
  res: Response,
  model?: string,
): Promise<TestResult> {
  const modelId = resolveTestModel(model);
  sendSSE(res, { type: 'test_start', email: account.email, model: modelId });

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${account.accessToken}`,
      'Accept': 'text/event-stream',
      'OpenAI-Beta': 'responses=experimental',
    };
    if (account.accountId) headers['chatgpt-account-id'] = account.accountId;

    const response = await axios.post('https://chatgpt.com/backend-api/codex/responses', {
      model: modelId,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: true,
      store: false,
      instructions: 'You are a helpful assistant.',
    }, {
      headers,
      timeout: 30000,
      validateStatus: () => true,
      responseType: 'stream',
    });

    const status = response.status;

    // Handle error statuses
    if (status === 401 || status === 403) {
      (response.data as { destroy?: () => void } | undefined)?.destroy?.();
      const errorMsg = `Token 失效 (HTTP ${status})`;
      sendSSE(res, { type: 'error', error: errorMsg });
      // Update probe state
      const probeResult: AccountUsageResult = {
        accountId: account.id,
        email: account.email,
        status: 'token_invalid',
        usage: null,
        errorMessage: errorMsg,
      };
      accountStore.updateProbeState(account.id, toProbeState(probeResult));
      return { success: false, content: '', error: errorMsg };
    }

    if (status === 429) {
      (response.data as { destroy?: () => void } | undefined)?.destroy?.();
      const errorMsg = '限流中';
      sendSSE(res, { type: 'error', error: errorMsg });
      const probeResult: AccountUsageResult = {
        accountId: account.id,
        email: account.email,
        status: 'rate_limited',
        usage: { fiveHourUsed: 100, fiveHourResetAt: '', sevenDayUsed: 100, sevenDayResetAt: '' },
        errorMessage: errorMsg,
      };
      accountStore.updateProbeState(account.id, toProbeState(probeResult));
      return { success: false, content: '', error: errorMsg };
    }

    if (status !== 200) {
      const errorMsg = extractErrorMessage(await readStreamSnippet(response.data), status);
      sendSSE(res, { type: 'error', error: errorMsg });
      const probeResult: AccountUsageResult = {
        accountId: account.id,
        email: account.email,
        status: 'error',
        usage: null,
        errorMessage: errorMsg,
      };
      accountStore.updateProbeState(account.id, toProbeState(probeResult));
      return { success: false, content: '', error: errorMsg };
    }

    // 200 - parse SSE stream
    const stream = response.data as NodeJS.ReadableStream;
    let fullText = '';
    let buffer = '';
    const probeStatus: 'ok' | 'error' | 'token_invalid' | 'rate_limited' = 'ok';

    // Extract rate limit headers from response
    const usage = extractRateLimitHeaders(response.headers as Record<string, string>);

    return new Promise<TestResult>((resolve) => {
      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === '[DONE]') continue;

          try {
            const event = JSON.parse(jsonStr);
            const eventType = event.type ?? '';

            if (eventType === 'response.output_text.delta') {
              const delta = event.delta ?? '';
              if (delta) {
                fullText += delta;
                sendSSE(res, { type: 'content', text: delta });
              }
            }

            if (eventType === 'response.completed' || eventType === 'response.done') {
              // Completed
            }
          } catch {
            // ignore parse errors
          }
        }
      });

      stream.on('end', () => {
        // Update probe state with rate limit info
        const probeResult: AccountUsageResult = {
          accountId: account.id,
          email: account.email,
          status: probeStatus,
          usage,
          errorMessage: '',
        };
        accountStore.updateProbeState(account.id, toProbeState(probeResult));

        sendSSE(res, { type: 'test_complete', success: true, content: fullText });
        resolve({ success: true, content: fullText });
      });

      stream.on('error', (err: Error) => {
        const errorMsg = err.message;
        sendSSE(res, { type: 'error', error: errorMsg });
        resolve({ success: false, content: fullText, error: errorMsg });
      });
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    sendSSE(res, { type: 'error', error: errorMsg });
    return { success: false, content: '', error: errorMsg };
  }
}

/**
 * 单账号可用性测试（SSE 流式）
 */
export async function testAccount(accountId: string, res: Response, model?: string): Promise<void> {
  const account = accountStore.findById(accountId);
  if (!account) {
    res.status(404).json({ error: '账号不存在' });
    return;
  }

  setSseHeaders(res);

  try {
    await doTestAccount(
      { id: account.id, email: account.email, accessToken: account.accessToken, accountId: account.accountId || undefined },
      res,
      model,
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    sendSSE(res, { type: 'error', error: errorMsg });
  } finally {
    res.end();
  }
}

/**
 * 批量账号可用性测试（SSE 流式）
 */
export async function testAccountBatch(ids: string[], res: Response, model?: string): Promise<void> {
  setSseHeaders(res);
  sendSSE(res, { type: 'batch_start', total: ids.length, model: resolveTestModel(model) });

  let successCount = 0;
  let failedCount = 0;

  for (const id of ids) {
    const account = accountStore.findById(id);
    if (!account) {
      sendSSE(res, { type: 'item_result', accountId: id, email: '', success: false, error: '账号不存在' });
      failedCount++;
      continue;
    }

    try {
      const result = await doTestAccount(
        { id: account.id, email: account.email, accessToken: account.accessToken, accountId: account.accountId || undefined },
        res,
        model,
      );
      sendSSE(res, {
        type: 'item_result',
        accountId: id,
        email: account.email,
        success: result.success,
        error: result.error,
        content: result.content,
      });
      if (result.success) successCount++;
      else failedCount++;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      sendSSE(res, { type: 'item_result', accountId: id, email: account.email, success: false, error: errorMsg });
      failedCount++;
    }

    // Small delay between tests
    if (ids.indexOf(id) < ids.length - 1) {
      await delay(200);
    }
  }

  sendSSE(res, { type: 'batch_complete', total: ids.length, success: successCount, failed: failedCount });
  res.end();
}
