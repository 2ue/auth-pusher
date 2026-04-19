import { defaultRegistry } from '../pushers/index.js';
import type { PusherType } from '../../../shared/types/pusher.js';
import { BaseChannel } from './base-channel.js';
import { PusherBackedChannel } from './pusher-backed.channel.js';
import { Sub2ApiChannel } from './sub2api.channel.js';
import { Sub2ApiPusher } from '../pushers/sub2api.pusher.js';

export class ChannelRegistry {
  private readonly channels = new Map<PusherType, BaseChannel>();

  register(channel: BaseChannel): void {
    this.channels.set(channel.type, channel);
  }

  has(type: PusherType): boolean {
    return this.channels.has(type);
  }

  get(type: PusherType): BaseChannel {
    const channel = this.channels.get(type);
    if (!channel) throw new Error(`未注册的渠道能力: ${type}`);
    return channel;
  }
}

export function buildDefaultChannelRegistry(): ChannelRegistry {
  const registry = new ChannelRegistry();

  registry.register(new Sub2ApiChannel(defaultRegistry.get('sub2api') as Sub2ApiPusher));
  registry.register(new PusherBackedChannel(defaultRegistry.get('codex2api')));
  registry.register(new PusherBackedChannel(defaultRegistry.get('cliproxycli')));

  return registry;
}

export const defaultChannelRegistry = buildDefaultChannelRegistry();
