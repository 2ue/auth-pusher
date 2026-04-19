import { Router } from 'express';
import { nanoid } from 'nanoid';
import * as store from '../persistence/profile.store.js';
import type { DataProfile } from '../../../shared/types/data-profile.js';

export const profileRoutes: ReturnType<typeof Router> = Router();

profileRoutes.get('/', (_req, res) => {
  res.json(store.loadProfiles());
});

profileRoutes.get('/:id', (req, res) => {
  const profile = store.findProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: '模板不存在' });
  res.json(profile);
});

profileRoutes.post('/', (req, res) => {
  try {
    const { name, description, multiFile, recordsPath, fieldMapping, fingerprint } = req.body;
    if (!name) return res.status(400).json({ error: '缺少模板名称' });
    if (!fieldMapping || Object.keys(fieldMapping).length === 0) {
      return res.status(400).json({ error: '缺少字段映射' });
    }

    const now = new Date().toISOString();
    const profile: DataProfile = {
      id: `dp-${nanoid(8)}`,
      name,
      description: description ?? '',
      multiFile: multiFile ?? false,
      recordsPath: recordsPath ?? '',
      fieldMapping,
      fingerprint: fingerprint ?? [],
      createdAt: now,
      updatedAt: now,
    };

    store.upsertProfile(profile);
    res.status(201).json(profile);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

profileRoutes.put('/:id', (req, res) => {
  try {
    const existing = store.findProfile(req.params.id);
    if (!existing) return res.status(404).json({ error: '模板不存在' });
    if (existing.builtin) return res.status(400).json({ error: '内置模板不可编辑' });

    const updated: DataProfile = {
      ...existing,
      name: req.body.name ?? existing.name,
      description: req.body.description ?? existing.description,
      fieldMapping: req.body.fieldMapping ?? existing.fieldMapping,
      fingerprint: req.body.fingerprint ?? existing.fingerprint,
      updatedAt: new Date().toISOString(),
    };

    store.upsertProfile(updated);
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

profileRoutes.delete('/:id', (req, res) => {
  const ok = store.removeProfile(req.params.id);
  if (!ok) return res.status(400).json({ error: '模板不存在或为内置模板' });
  res.json({ ok: true });
});
