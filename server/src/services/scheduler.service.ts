/**
 * 定时推送调度服务
 * 基于 Channel 配置和 Cron 表达式定时执行推送任务
 */
import cron from 'node-cron';
import { nanoid } from 'nanoid';
import * as channelStore from '../persistence/channel.store.js';
import * as pushService from './push.service.js';
import * as scheduledTaskStore from '../persistence/scheduled-task.store.js';
import type { ScheduledTask } from '../persistence/scheduled-task.store.js';

export type { ScheduledTask } from '../persistence/scheduled-task.store.js';

const runningJobs = new Map<string, cron.ScheduledTask>();

export function listScheduledTasks(): ScheduledTask[] {
  return scheduledTaskStore.loadAll();
}

export function createScheduledTask(input: {
  channelId: string;
  cronExpression: string;
}): ScheduledTask {
  if (!cron.validate(input.cronExpression)) {
    throw new Error(`无效的 Cron 表达式: ${input.cronExpression}`);
  }
  const channel = channelStore.findChannel(input.channelId);
  if (!channel) throw new Error('渠道不存在');

  const task: ScheduledTask = {
    id: nanoid(12),
    channelId: input.channelId,
    cronExpression: input.cronExpression,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  scheduledTaskStore.insert(task);
  startCronJob(task);
  return task;
}

export function updateScheduledTask(id: string, input: {
  cronExpression?: string;
  enabled?: boolean;
}): ScheduledTask {
  const task = scheduledTaskStore.find(id);
  if (!task) throw new Error('定时任务不存在');

  if (input.cronExpression !== undefined) {
    if (!cron.validate(input.cronExpression)) throw new Error(`无效的 Cron 表达式: ${input.cronExpression}`);
    task.cronExpression = input.cronExpression;
  }
  if (input.enabled !== undefined) task.enabled = input.enabled;

  scheduledTaskStore.update(task);

  // 重启 cron job
  stopCronJob(id);
  if (task.enabled) startCronJob(task);

  return task;
}

export function deleteScheduledTask(id: string): boolean {
  stopCronJob(id);
  return scheduledTaskStore.remove(id);
}

async function executeScheduledTask(task: ScheduledTask) {
  const current = scheduledTaskStore.find(task.id);
  if (!current || !current.enabled) return;

  const channel = channelStore.findChannel(task.channelId);
  if (!channel) {
    current.lastRunStatus = 'failed';
    current.lastRunError = '渠道已被删除';
    current.lastRunAt = new Date().toISOString();
    scheduledTaskStore.update(current);
    return;
  }

  try {
    const filter = channel.defaultAccountFilter ?? {};
    const result = await pushService.executePush({
      channelIds: [channel.id],
      dataSource: 'pool',
      accountFilter: {
        planType: filter.planType,
        disabled: filter.excludeDisabled !== false ? false : undefined,
        expired: filter.excludeExpired !== false ? false : undefined,
      },
    });
    current.lastRunAt = new Date().toISOString();
    current.lastRunStatus = 'success';
    current.lastRunError = undefined;
    current.lastTaskId = result.taskIds?.[0];
  } catch (err) {
    current.lastRunAt = new Date().toISOString();
    current.lastRunStatus = 'failed';
    current.lastRunError = err instanceof Error ? err.message : String(err);
  }
  scheduledTaskStore.update(current);
}

function startCronJob(task: ScheduledTask) {
  if (runningJobs.has(task.id)) return;
  const job = cron.schedule(task.cronExpression, () => {
    void executeScheduledTask(task);
  });
  runningJobs.set(task.id, job);
}

function stopCronJob(id: string) {
  const job = runningJobs.get(id);
  if (job) {
    job.stop();
    runningJobs.delete(id);
  }
}

/** 启动时恢复所有已启用的定时任务 */
export function initScheduler() {
  const tasks = scheduledTaskStore.loadAll();
  for (const task of tasks) {
    if (task.enabled && cron.validate(task.cronExpression)) {
      startCronJob(task);
    }
  }
  import('../utils/logger.js').then(({ logger }) => logger.info({ count: tasks.filter((t) => t.enabled).length }, 'scheduled tasks restored'));
}
