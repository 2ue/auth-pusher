import { nanoid } from 'nanoid';
import type { ChannelConfig } from '../../../shared/types/channel.js';
import * as store from '../persistence/channel.store.js';
import { defaultRegistry } from '../pushers/index.js';

export function listChannels(): ChannelConfig[] {
  return store.loadChannels();
}

export function getChannel(id: string): ChannelConfig | undefined {
  return store.findChannel(id);
}

export function createChannel(input: {
  name: string;
  pusherType: string;
  pusherConfig: Record<string, unknown>;
  fieldMapping?: Record<string, string>;
  pushIntervalMs?: number;
  pushConcurrency?: number;
  defaultAccountFilter?: ChannelConfig['defaultAccountFilter'];
}): ChannelConfig {
  // 验证 pusher 类型
  const pusher = defaultRegistry.get(input.pusherType);
  const validation = pusher.validateConfig(input.pusherConfig);
  if (!validation.valid) {
    throw new Error(`配置验证失败: ${validation.errors.join(', ')}`);
  }

  const now = new Date().toISOString();
  const channel: ChannelConfig = {
    id: nanoid(12),
    name: input.name,
    pusherType: input.pusherType as ChannelConfig['pusherType'],
    enabled: true,
    createdAt: now,
    updatedAt: now,
    pusherConfig: input.pusherConfig,
    fieldMapping: input.fieldMapping ?? {},
    pushIntervalMs: input.pushIntervalMs,
    pushConcurrency: input.pushConcurrency,
    defaultAccountFilter: input.defaultAccountFilter,
  };

  store.upsertChannel(channel);
  return channel;
}

export function updateChannel(id: string, input: {
  name?: string;
  pusherType?: string;
  pusherConfig?: Record<string, unknown>;
  fieldMapping?: Record<string, string>;
  enabled?: boolean;
  pushIntervalMs?: number;
  pushConcurrency?: number;
  defaultAccountFilter?: ChannelConfig['defaultAccountFilter'];
}): ChannelConfig {
  const existing = store.findChannel(id);
  if (!existing) throw new Error(`渠道不存在: ${id}`);

  const updated: ChannelConfig = {
    ...existing,
    name: input.name ?? existing.name,
    pusherType: (input.pusherType as ChannelConfig['pusherType']) ?? existing.pusherType,
    pusherConfig: input.pusherConfig ?? existing.pusherConfig,
    fieldMapping: input.fieldMapping ?? existing.fieldMapping,
    enabled: input.enabled ?? existing.enabled,
    pushIntervalMs: 'pushIntervalMs' in input ? input.pushIntervalMs : existing.pushIntervalMs,
    pushConcurrency: 'pushConcurrency' in input ? input.pushConcurrency : existing.pushConcurrency,
    defaultAccountFilter: 'defaultAccountFilter' in input ? input.defaultAccountFilter : existing.defaultAccountFilter,
    updatedAt: new Date().toISOString(),
  };

  // 验证新配置
  const pusher = defaultRegistry.get(updated.pusherType);
  const validation = pusher.validateConfig(updated.pusherConfig);
  if (!validation.valid) {
    throw new Error(`配置验证失败: ${validation.errors.join(', ')}`);
  }

  store.upsertChannel(updated);
  return updated;
}

export function deleteChannel(id: string): boolean {
  return store.removeChannel(id);
}
