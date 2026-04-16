import type { PusherType } from './pusher.js';

export interface ChannelConfig {
  id: string;
  name: string;
  pusherType: PusherType;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  pusherConfig: Record<string, unknown>;
  fieldMapping: Record<string, string>;
  /** 渠道级推送间隔覆盖（毫秒），不设则用全局 */
  pushIntervalMs?: number;
  /** 渠道级推送并发覆盖，不设则用全局 */
  pushConcurrency?: number;
  /** 默认账号筛选条件（用于快捷推送/定时任务） */
  defaultAccountFilter?: {
    planType?: string;
    excludeDisabled?: boolean;
    excludeExpired?: boolean;
  };
}

export interface ChannelSummary {
  id: string;
  name: string;
  pusherType: PusherType;
  enabled: boolean;
  lastPushAt?: string;
  lastPushStatus?: 'success' | 'partial' | 'failed';
}
