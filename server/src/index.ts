import { createApp } from './app.js';
import { logger } from './utils/logger.js';

const PORT = process.env.PORT ?? 3771;
const app = createApp();

app.listen(PORT, () => {
  logger.info({ port: PORT }, '服务已启动 http://localhost:%s', PORT);
});
