import express, { type Express } from 'express';
import cors from 'cors';
import { apiKeyAuth } from './middleware/auth.js';
import { errorHandler } from './middleware/error-handler.js';
import { channelRoutes } from './routes/channel.routes.js';
import { pusherRoutes } from './routes/pusher.routes.js';
import { dataRoutes } from './routes/data.routes.js';
import { pushRoutes } from './routes/push.routes.js';
import { profileRoutes } from './routes/profile.routes.js';
import { accountRoutes } from './routes/account.routes.js';
import { settingsRoutes } from './routes/settings.routes.js';
import { tagRoutes } from './routes/tag.routes.js';
import { fileRoutes } from './routes/file.routes.js';
import { schedulerRoutes } from './routes/scheduler.routes.js';
import {
  handleOpenAiAuthCallback,
  handleOpenAiAuthIndex,
  handleOpenAiAuthSuccess,
  handleOpenAiAuthUrl,
  openaiAuthRoutes,
} from './routes/openai-auth.routes.js';
import { initScheduler } from './services/scheduler.service.js';
import { hydrateAccountChannelLinks } from './services/account-channel-link.service.js';

export function createApp(): Express {
  const app = express();

  hydrateAccountChannelLinks();

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

  // 健康检查（无需鉴权）
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/', handleOpenAiAuthIndex);
  app.get('/api/auth-url', handleOpenAiAuthUrl);
  app.get('/success', handleOpenAiAuthSuccess);
  app.get('/auth/callback', (req, res) => {
    void handleOpenAiAuthCallback(req, res);
  });
  app.get('/api/openai-auth/callback', (req, res) => {
    void handleOpenAiAuthCallback(req, res);
  });

  // API Key 鉴权（apiKey 为空时不启用，向下兼容）
  app.use('/api', apiKeyAuth);

  app.use('/api/openai-auth', openaiAuthRoutes);
  app.use('/api/channels', channelRoutes);
  app.use('/api/pushers', pusherRoutes);
  app.use('/api/data', dataRoutes);
  app.use('/api/push', pushRoutes);
  app.use('/api/profiles', profileRoutes);
  app.use('/api/accounts', accountRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/tags', tagRoutes);
  app.use('/api/files', fileRoutes);
  app.use('/api/scheduler', schedulerRoutes);

  // 统一错误处理
  app.use(errorHandler);

  // 启动定时任务调度器
  initScheduler();

  return app;
}
