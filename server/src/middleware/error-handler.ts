import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

/**
 * 统一错误处理中间件
 * 捕获未处理的异常，返回标准化 JSON 错误格式
 */
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  logger.error({ err }, 'unhandled error');

  const statusCode = (err as unknown as { statusCode?: number }).statusCode ?? 500;
  res.status(statusCode).json({
    error: err.message || 'Internal Server Error',
  });
}
