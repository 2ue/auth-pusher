import { Router } from 'express';
import * as schedulerService from '../services/scheduler.service.js';

export const schedulerRoutes = Router();

schedulerRoutes.get('/', (_req, res) => {
  res.json(schedulerService.listScheduledTasks());
});

schedulerRoutes.post('/', (req, res) => {
  try {
    const task = schedulerService.createScheduledTask(req.body);
    res.status(201).json(task);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

schedulerRoutes.put('/:id', (req, res) => {
  try {
    const task = schedulerService.updateScheduledTask(req.params.id, req.body);
    res.json(task);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

schedulerRoutes.delete('/:id', (req, res) => {
  const ok = schedulerService.deleteScheduledTask(req.params.id);
  if (!ok) return res.status(404).json({ error: '定时任务不存在' });
  res.json({ ok: true });
});
