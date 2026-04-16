import type { Request, Response, NextFunction } from 'express';
import * as settingsStore from '../persistence/settings.store.js';

/**
 * API Key 鉴权中间件
 * 如果 settings.apiKey 为空，则跳过鉴权（向下兼容）
 * 支持 Header: Authorization: Bearer <key> 或 X-Api-Key: <key>
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const settings = settingsStore.load();
  const configuredKey = settings.apiKey;

  // 未配置 apiKey → 不启用鉴权
  if (!configuredKey) return next();

  const authHeader = req.headers.authorization;
  const xApiKey = req.headers['x-api-key'];

  let providedKey: string | undefined;

  if (authHeader?.startsWith('Bearer ')) {
    providedKey = authHeader.slice(7);
  } else if (typeof xApiKey === 'string') {
    providedKey = xApiKey;
  }

  if (!providedKey || providedKey !== configuredKey) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
  }

  next();
}
