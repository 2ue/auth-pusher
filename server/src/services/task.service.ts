import type { PushTask } from '../../../shared/types/task.js';
import * as store from '../persistence/task.store.js';

export function listTasks(): Omit<PushTask, 'items'>[] {
  return store.listTasks().map(({ items, ...rest }) => rest);
}

export function getTask(id: string): PushTask | null {
  return store.loadTask(id);
}

export function deleteTask(id: string): boolean {
  return store.deleteTask(id);
}
