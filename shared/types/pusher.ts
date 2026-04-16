export type PusherType = 'sub2api' | 'codex2api' | 'cliproxycli';

export interface PusherFieldSchema {
  key: string;
  label: string;
  type: 'string' | 'number' | 'select' | 'boolean' | 'json';
  required: boolean;
  placeholder?: string;
  options?: { label: string; value: string }[];
  defaultValue?: unknown;
  description?: string;
  secret?: boolean;
}

export interface PusherSchema {
  type: PusherType;
  name: string;
  description: string;
  configFields: PusherFieldSchema[];
  requiredDataFields: string[];
  optionalDataFields: string[];
  supportsBatch: boolean;
  transport: 'json' | 'multipart_file';
}

export interface PushRequest {
  identifier: string;
  provider: string;
  url: string;
  headers: Record<string, string>;
  jsonBody?: Record<string, unknown>;
  fileName?: string;
  fileContent?: string;
  fileFieldName?: string;
  transport: 'json' | 'multipart_file';
  timeoutMs: number;
  snapshot: Record<string, unknown>;
}

export interface PushResult {
  identifier: string;
  ok: boolean;
  statusCode: number;
  responseBody: Record<string, unknown>;
  externalId: string;
  error: string;
  durationMs: number;
}
