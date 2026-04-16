const BASE = '/api';

/** 从 localStorage 读取 API Key（设置页配置后存入） */
function getApiKey(): string {
  return localStorage.getItem('auth-pusher-api-key') ?? '';
}

export function setApiKey(key: string) {
  if (key) localStorage.setItem('auth-pusher-api-key', key);
  else localStorage.removeItem('auth-pusher-api-key');
}

function buildHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
  const apiKey = getApiKey();
  if (apiKey) headers['X-Api-Key'] = apiKey;
  return headers;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: buildHeaders(),
    ...init,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export function get<T>(path: string): Promise<T> {
  return request<T>(path);
}

/** GET 并读取 X-Total-Count header */
export async function getWithTotal<T>(path: string): Promise<{ data: T; total: number }> {
  const res = await fetch(`${BASE}${path}`, {
    headers: buildHeaders(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  const total = parseInt(res.headers.get('X-Total-Count') ?? '0', 10);
  return { data: data as T, total };
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export function put<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
}

export function del<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' });
}

export async function upload<T>(path: string, formData: FormData): Promise<T> {
  const apiKey = getApiKey();
  const headers: Record<string, string> = {};
  if (apiKey) headers['X-Api-Key'] = apiKey;

  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}
