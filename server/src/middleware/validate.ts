import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodError, type ZodSchema } from 'zod';

/**
 * 请求 body 校验中间件工厂
 * 用法: router.post('/path', validate(schema), handler)
 */
export function validate(schema: ZodSchema): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const messages = err.issues.map((e) => `${String(e.path.join('.'))}: ${e.message}`);
        return res.status(400).json({ error: '参数校验失败', details: messages });
      }
      next(err);
    }
  };
}
