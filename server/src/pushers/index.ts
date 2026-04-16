import { PusherRegistry } from '../core/pusher-registry.js';
import { Sub2ApiPusher } from './sub2api.pusher.js';
import { Codex2ApiPusher } from './codex2api.pusher.js';
import { CpaUploadPusher } from './cpa-upload.pusher.js';

export function buildDefaultRegistry(): PusherRegistry {
  const registry = new PusherRegistry();
  registry.register(new Sub2ApiPusher());
  registry.register(new Codex2ApiPusher());
  registry.register(new CpaUploadPusher());
  return registry;
}

export const defaultRegistry = buildDefaultRegistry();
