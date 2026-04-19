import { createApp } from './app.js';
import { getOpenAiOAuthServerConfig } from './services/openai-oauth-capture.service.js';
import { logger } from './utils/logger.js';

const PORT = Number(process.env.PORT ?? 3771);
const oauthConfig = getOpenAiOAuthServerConfig();
const app = createApp();

function logOauthStartup(): void {
  logger.info('============================================================');
  logger.info('Codex OAuth 服务器');
  logger.info('============================================================');
  logger.info({ port: oauthConfig.port }, '已启动，监听端口 %s', oauthConfig.port);
  logger.info({ url: oauthConfig.baseUrl }, '认证页面: %s/', oauthConfig.baseUrl);
  logger.info({ url: oauthConfig.baseUrl }, 'API 端点: %s/api/auth-url', oauthConfig.baseUrl);
  logger.info('[守护模式] 服务器将持续运行，按 Ctrl+C 停止');
}

const mainServer = app.listen(PORT, () => {
  logger.info({ port: PORT }, '服务已启动 http://localhost:%s', PORT);
  if (oauthConfig.port === PORT) {
    logOauthStartup();
  }
});

mainServer.on('error', (err) => {
  logger.error({ err, port: PORT }, '主服务启动失败');
  process.exitCode = 1;
});

if (oauthConfig.port !== PORT) {
  const oauthServer = app.listen(oauthConfig.port, () => {
    logOauthStartup();
  });

  oauthServer.on('error', (err) => {
    logger.error({ err, port: oauthConfig.port }, 'OAuth 兼容端口启动失败');
  });
}
