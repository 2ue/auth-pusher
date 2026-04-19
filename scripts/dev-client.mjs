import { spawn } from 'node:child_process';

const HEALTH_URL = process.env.AUTH_PUSHER_SERVER_HEALTH_URL ?? 'http://127.0.0.1:3771/api/health';
const TIMEOUT_MS = Number(process.env.AUTH_PUSHER_WAIT_TIMEOUT_MS ?? 30000);
const POLL_INTERVAL_MS = 500;
function getClientCommand() {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm -F ./client dev'],
    };
  }

  return {
    command: 'pnpm',
    args: ['-F', './client', 'dev'],
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer() {
  const startedAt = Date.now();

  while (Date.now() - startedAt < TIMEOUT_MS) {
    try {
      const response = await fetch(HEALTH_URL);

      if (response.ok) {
        return;
      }
    } catch {
      // The dev server is still booting, keep polling until the timeout.
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for server health check: ${HEALTH_URL}`);
}

async function main() {
  console.log(`[dev] waiting for server: ${HEALTH_URL}`);
  await waitForServer();
  console.log('[dev] server is ready, starting Vite');

  const { command, args } = getClientCommand();
  const clientProcess = spawn(command, args, {
    stdio: 'inherit',
  });

  const forwardSignal = (signal) => {
    if (!clientProcess.killed) {
      clientProcess.kill(signal);
    }
  };

  process.on('SIGINT', forwardSignal);
  process.on('SIGTERM', forwardSignal);

  clientProcess.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error('[dev] failed to start client after waiting for server');
  console.error(error);
  process.exit(1);
});
