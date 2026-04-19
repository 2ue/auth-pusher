import type { PusherType } from '../../../shared/types/pusher.js';
import type { ChannelConfig } from '../../../shared/types/channel.js';
import type { RemoteAccountFull, RemoteAccountUpdateInput } from '../core/base-pusher.js';

export interface ChannelCapabilities {
  fetchRemote: boolean;
  updateRemote: boolean;
  forceUpdateRemote: boolean;
  resetRemoteState: boolean;
  setSchedulable: boolean;
  resetAndEnableScheduling: boolean;
}

export interface ChannelActionResult {
  ok: boolean;
  error?: string;
}

export interface ChannelRemoteUpdateOptions {
  force?: boolean;
}

export abstract class BaseChannel {
  constructor(readonly type: PusherType) {}

  getCapabilities(_channel: ChannelConfig): ChannelCapabilities {
    const fetchRemote = this.supportsFetchRemote();
    const updateRemote = this.supportsUpdateRemote();
    const setSchedulable = this.supportsSetSchedulable();
    const resetRemoteState = this.supportsResetRemoteState();
    return {
      fetchRemote,
      updateRemote,
      forceUpdateRemote: updateRemote,
      resetRemoteState,
      setSchedulable,
      resetAndEnableScheduling: resetRemoteState && setSchedulable,
    };
  }

  protected supportsFetchRemote(): boolean { return false; }

  protected supportsUpdateRemote(): boolean { return false; }

  protected supportsResetRemoteState(): boolean { return false; }

  protected supportsSetSchedulable(): boolean { return false; }

  async fetchRemoteAccounts(_channel: ChannelConfig): Promise<RemoteAccountFull[]> {
    throw new Error(`渠道类型 ${this.type} 不支持查看远端账号`);
  }

  async updateRemoteAccount(
    _channel: ChannelConfig,
    _remoteId: string,
    _input: RemoteAccountUpdateInput,
    _options?: ChannelRemoteUpdateOptions,
  ): Promise<ChannelActionResult> {
    return { ok: false, error: `渠道类型 ${this.type} 不支持远端更新` };
  }

  async resetRemoteState(_channel: ChannelConfig, _remoteId: string): Promise<ChannelActionResult> {
    return { ok: false, error: `渠道类型 ${this.type} 不支持重置远端状态` };
  }

  async setRemoteSchedulable(
    _channel: ChannelConfig,
    _remoteId: string,
    _schedulable: boolean,
  ): Promise<ChannelActionResult> {
    return { ok: false, error: `渠道类型 ${this.type} 不支持修改远端调度状态` };
  }

  async resetRemoteStateAndEnableScheduling(channel: ChannelConfig, remoteId: string): Promise<ChannelActionResult> {
    const capabilities = this.getCapabilities(channel);
    if (!capabilities.resetAndEnableScheduling) {
      return { ok: false, error: `渠道类型 ${this.type} 不支持“重置状态并打开调度”` };
    }

    const resetResult = await this.resetRemoteState(channel, remoteId);
    if (!resetResult.ok) return resetResult;

    return this.setRemoteSchedulable(channel, remoteId, true);
  }
}
