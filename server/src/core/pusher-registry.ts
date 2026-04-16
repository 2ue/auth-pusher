import type { BasePusher } from './base-pusher.js';

export class PusherRegistry {
  private readonly pushers = new Map<string, BasePusher>();

  private normalizeType(type: string): string {
    const normalized = type.trim().toLowerCase();
    return normalized === 'cpa_upload' ? 'cliproxycli' : normalized;
  }

  register(pusher: BasePusher): void {
    const name = this.normalizeType(pusher.type);
    if (!name) throw new Error('Pusher 缺少 type');
    this.pushers.set(name, pusher);
  }

  get(type: string): BasePusher {
    const p = this.pushers.get(this.normalizeType(type));
    if (!p) throw new Error(`不支持的推送类型: ${type}`);
    return p;
  }

  list(): BasePusher[] {
    return Array.from(this.pushers.values());
  }

  has(type: string): boolean {
    return this.pushers.has(this.normalizeType(type));
  }
}
