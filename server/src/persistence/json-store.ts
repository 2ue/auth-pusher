import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(currentDir, '../../../data');

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function readJsonFile<T>(relativePath: string, defaultValue: T): T {
  const filePath = path.join(DATA_DIR, relativePath);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return defaultValue;
  }
}

export function writeJsonFile<T>(relativePath: string, data: T): void {
  const filePath = path.join(DATA_DIR, relativePath);
  ensureDir(path.dirname(filePath));
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

export function deleteJsonFile(relativePath: string): boolean {
  const filePath = path.join(DATA_DIR, relativePath);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function getDataDir(): string {
  ensureDir(DATA_DIR);
  return DATA_DIR;
}
