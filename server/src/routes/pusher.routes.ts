import { Router } from 'express';
import { defaultRegistry } from '../pushers/index.js';

export const pusherRoutes: ReturnType<typeof Router> = Router();

pusherRoutes.get('/', (_req, res) => {
  const schemas = defaultRegistry.list().map((p) => p.schema);
  res.json(schemas);
});

pusherRoutes.get('/:type/schema', (req, res) => {
  try {
    const pusher = defaultRegistry.get(req.params.type);
    res.json(pusher.schema);
  } catch (e) {
    res.status(404).json({ error: (e as Error).message });
  }
});
