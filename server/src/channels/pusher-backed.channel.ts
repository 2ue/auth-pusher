import type { PusherType } from '../../../shared/types/pusher.js';
import type { ChannelConfig } from '../../../shared/types/channel.js';
import type { RemoteAccountFull } from '../core/base-pusher.js';
import type { BasePusher } from '../core/base-pusher.js';
import { BaseChannel } from './base-channel.js';

export class PusherBackedChannel extends BaseChannel {
  constructor(protected readonly pusher: BasePusher) {
    super(pusher.type as PusherType);
  }

  protected override supportsFetchRemote(): boolean {
    return this.pusher.canFetchRemote();
  }

  override async fetchRemoteAccounts(channel: ChannelConfig): Promise<RemoteAccountFull[]> {
    if (!this.pusher.canFetchRemote()) {
      return super.fetchRemoteAccounts(channel);
    }
    return this.pusher.fetchRemoteAccounts(channel.pusherConfig);
  }
}
