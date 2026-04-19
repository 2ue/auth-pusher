import { Router } from 'express';
import * as tagStore from '../persistence/tag.store.js';

export const tagRoutes: ReturnType<typeof Router> = Router();

tagRoutes.get('/', (_req, res) => {
  res.json(tagStore.getAllUnique());
});

tagRoutes.post('/', (req, res) => {
  const { tag } = req.body as { tag?: string };
  if (!tag || !tag.trim()) {
    res.status(400).json({ error: '标签不能为空' });
    return;
  }
  tagStore.addPredefined(tag.trim());
  res.json({ ok: true });
});

tagRoutes.delete('/:tag', (req, res) => {
  tagStore.removePredefined(req.params.tag);
  res.json({ ok: true });
});
