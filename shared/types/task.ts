export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type TaskItemStatus = 'pending' | 'pushing' | 'success' | 'failed' | 'skipped';

export interface PushTask {
  id: string;
  channelId: string;
  channelName: string;
  pusherType: string;
  status: TaskStatus;
  totalItems: number;
  successCount: number;
  failedCount: number;
  createdAt: string;
  completedAt?: string;
  items: PushTaskItem[];
}

export interface PushTaskItem {
  index: number;
  identifier: string;
  status: TaskItemStatus;
  pushResult?: {
    ok: boolean;
    statusCode: number;
    externalId: string;
    error: string;
    durationMs: number;
    responseBody: Record<string, unknown>;
  };
}

export interface PushProgressEvent {
  type: 'item_start' | 'item_complete' | 'task_complete' | 'task_error';
  taskId: string;
  itemIndex?: number;
  identifier?: string;
  result?: PushTaskItem['pushResult'];
  summary?: { total: number; success: number; failed: number };
}
