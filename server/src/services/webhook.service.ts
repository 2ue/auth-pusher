/**
 * Webhook 通知服务
 * 在推送任务完成/失败时发送通知到配置的 URL
 */
import axios from 'axios';
import * as settingsStore from '../persistence/settings.store.js';

export interface WebhookPayload {
  event: 'task_complete' | 'task_failed';
  taskId: string;
  channelName: string;
  pusherType: string;
  total: number;
  success: number;
  failed: number;
  completedAt: string;
}

export async function sendWebhook(payload: WebhookPayload): Promise<void> {
  const settings = settingsStore.load();
  const url = settings.webhookUrl;
  if (!url) return;

  try {
    await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });
  } catch (err) {
    const { logger } = await import('../utils/logger.js');
    logger.error({ err }, 'webhook send failed');
  }
}
