import { Router } from 'express';
import type { AppSettings } from '../../../shared/types/settings.js';
import * as settingsStore from '../persistence/settings.store.js';

export const settingsRoutes = Router();

settingsRoutes.get('/', (_req, res) => {
  res.json(settingsStore.load());
});

settingsRoutes.put('/', (req, res) => {
  const body = req.body as Partial<AppSettings>;
  const current = settingsStore.load();
  const updated = settingsStore.normalizeSettings({
    ...current,
    ...body,
    pushIntervalMs: Math.max(0, Number(body.pushIntervalMs ?? current.pushIntervalMs)),
    pushConcurrency: Math.max(1, Math.floor(Number(body.pushConcurrency ?? current.pushConcurrency))),
    planQuotas: {
      ...current.planQuotas,
      ...(body.planQuotas ?? {}),
    },
    detectThresholds: {
      ...current.detectThresholds,
      ...(body.detectThresholds ?? {}),
    },
  });
  settingsStore.save(updated);
  res.json(updated);
});
