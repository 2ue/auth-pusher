const { execSync } = require('node:child_process');

try {
  execSync('npm rebuild better-sqlite3', {
    stdio: 'inherit',
    shell: true,
  });
} catch (error) {
  const status = typeof error?.status === 'number' ? error.status : 'unknown';
  console.warn(`[install] better-sqlite3 rebuild exited with code ${status}. Continuing install.`);
}
