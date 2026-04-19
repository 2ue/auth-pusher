import type { ChannelConfig } from '../../../shared/types/channel.js';
import type { PusherType } from '../../../shared/types/pusher.js';
import type { RemoteAccountFull, RemoteAccountUpdateInput } from '../core/base-pusher.js';
import {
  defaultChannelRegistry,
} from '../channels/index.js';
import type {
  ChannelActionResult,
  ChannelCapabilities,
  ChannelRemoteUpdateOptions,
} from '../channels/base-channel.js';
import * as channelStore from '../persistence/channel.store.js';

export function getChannelCapabilities(channel: ChannelConfig): ChannelCapabilities {
  return defaultChannelRegistry.get(channel.pusherType).getCapabilities(channel);
}

export function getPusherTypeCapabilities(pusherType: PusherType): ChannelCapabilities {
  if (!defaultChannelRegistry.has(pusherType)) {
    return {
      fetchRemote: false,
      updateRemote: false,
      forceUpdateRemote: false,
      resetRemoteState: false,
      setSchedulable: false,
      resetAndEnableScheduling: false,
    };
  }
  return defaultChannelRegistry.get(pusherType).getCapabilities({
    id: '',
    name: '',
    pusherType,
    enabled: true,
    createdAt: '',
    updatedAt: '',
    pusherConfig: {},
    fieldMapping: {},
  });
}

export async function fetchRemoteAccounts(channel: ChannelConfig): Promise<RemoteAccountFull[]> {
  return defaultChannelRegistry.get(channel.pusherType).fetchRemoteAccounts(channel);
}

export async function fetchRemoteAccountsByChannelId(channelId: string): Promise<RemoteAccountFull[]> {
  const channel = channelStore.findChannel(channelId);
  if (!channel) throw new Error('渠道不存在');
  return fetchRemoteAccounts(channel);
}

export async function updateRemoteAccount(
  channel: ChannelConfig,
  remoteId: string,
  input: RemoteAccountUpdateInput,
  options?: ChannelRemoteUpdateOptions,
): Promise<ChannelActionResult> {
  return defaultChannelRegistry.get(channel.pusherType).updateRemoteAccount(channel, remoteId, input, options);
}

export async function resetRemoteStateAndEnableScheduling(
  channel: ChannelConfig,
  remoteId: string,
): Promise<ChannelActionResult> {
  return defaultChannelRegistry.get(channel.pusherType).resetRemoteStateAndEnableScheduling(channel, remoteId);
}
