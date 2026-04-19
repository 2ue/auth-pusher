import { Router } from 'express';
import * as pushService from '../services/push.service.js';
import * as taskService from '../services/task.service.js';
import * as accountStore from '../persistence/account.store.js';

export const pushRoutes: ReturnType<typeof Router> = Router();

pushRoutes.post('/execute', async (req, res) => {
  try {
    // 兼容旧接口: channelId → channelIds
    const body = { ...req.body };
    if (body.channelId && !body.channelIds) {
      body.channelIds = [body.channelId];
    }
    if (!body.dataSource) {
      body.dataSource = body.fileId ? 'file' : 'pool';
    }
    const result = await pushService.executePush(body);
    res.status(201).json(result);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

pushRoutes.get('/tasks', (_req, res) => {
  res.json(taskService.listTasks());
});

pushRoutes.get('/tasks/:id', (req, res) => {
  const task = taskService.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  res.json(task);
});

/** 重试任务中的失败项 */
pushRoutes.post('/tasks/:id/retry-failed', async (req, res) => {
  try {
    const task = taskService.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });

    const failedItems = task.items.filter((i) => i.status === 'failed');
    if (failedItems.length === 0) return res.json({ taskIds: [], message: '没有失败项' });

    // 从账号池中按 email 匹配失败项
    const emails = failedItems.map((i) => i.identifier.toLowerCase());
    const allAccounts = accountStore.loadAll();
    const matchedIds = allAccounts
      .filter((a) => emails.includes(a.email.toLowerCase()))
      .map((a) => a.id);

    if (matchedIds.length === 0) {
      return res.status(400).json({ error: '账号池中未找到这些失败账号' });
    }

    const result = await pushService.executePush({
      channelIds: [task.channelId],
      dataSource: 'pool',
      accountIds: matchedIds,
    });
    res.status(201).json(result);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

pushRoutes.delete('/tasks/:id', (req, res) => {
  const ok = taskService.deleteTask(req.params.id);
  if (!ok) return res.status(404).json({ error: '任务不存在' });
  res.json({ ok: true });
});

/** SSE 实时进度 */
pushRoutes.get('/tasks/:id/events', (req, res) => {
  const task = taskService.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // 如果任务已完成，直接发送完成事件
  if (task.status === 'completed' || task.status === 'failed') {
    const data = JSON.stringify({
      type: 'task_complete',
      taskId: task.id,
      summary: { total: task.totalItems, success: task.successCount, failed: task.failedCount },
    });
    res.write(`data: ${data}\n\n`);
    res.end();
    return;
  }

  pushService.subscribeToTask(req.params.id, res);
});
