import axios from 'axios';
import FormData from 'form-data';
import type { PushRequest } from '../../../shared/types/pusher.js';

export interface ExecuteResult {
  statusCode: number;
  body: Record<string, unknown>;
  durationMs: number;
}

export async function executeRequest(request: PushRequest): Promise<ExecuteResult> {
  const start = Date.now();

  try {
    if (request.transport === 'multipart_file') {
      const form = new FormData();
      form.append(request.fileFieldName ?? 'file', Buffer.from(request.fileContent ?? ''), {
        filename: request.fileName ?? 'data.json',
        contentType: 'application/json',
      });

      const headers = { ...request.headers, ...form.getHeaders() };

      const res = await axios.post(request.url, form, {
        headers,
        timeout: request.timeoutMs,
        validateStatus: () => true,
      });

      return { statusCode: res.status, body: typeof res.data === 'object' ? res.data : { text: String(res.data).slice(0, 400) }, durationMs: Date.now() - start };
    }

    const res = await axios.post(request.url, request.jsonBody ?? {}, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...request.headers },
      timeout: request.timeoutMs,
      validateStatus: () => true,
    });

    const body = typeof res.data === 'object' ? res.data : { text: String(res.data).slice(0, 400) };
    return { statusCode: res.status, body, durationMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { statusCode: 0, body: { error: message }, durationMs: Date.now() - start };
  }
}
