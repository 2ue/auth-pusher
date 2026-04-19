import { Router } from 'express';
import * as channelService from '../services/channel.service.js';
import * as channelSyncService from '../services/channel-sync.service.js';
import * as channelRemoteService from '../services/channel-remote.service.js';
import * as usageProbeService from '../services/usage-probe.service.js';
import { defaultRegistry } from '../pushers/index.js';
import { Sub2ApiPusher } from '../pushers/sub2api.pusher.js';

export const channelRoutes: ReturnType<typeof Router> = Router();

channelRoutes.get('/', (_req, res) => {
  const channels = channelService.listChannels().map((ch) => ({
    ...ch,
    capabilities: {
      syncable: channelSyncService.isSyncable(ch.pusherType),
      ...channelRemoteService.getChannelCapabilities(ch),
    },
  }));
  res.json(channels);
});

channelRoutes.get('/:id', (req, res) => {
  const channel = channelService.getChannel(req.params.id);
  if (!channel) return res.status(404).json({ error: '渠道不存在' });
  res.json(channel);
});

channelRoutes.post('/', (req, res) => {
  try {
    const channel = channelService.createChannel(req.body);
    res.status(201).json(channel);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

channelRoutes.put('/:id', (req, res) => {
  try {
    const channel = channelService.updateChannel(req.params.id, req.body);
    res.json(channel);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

channelRoutes.delete('/:id', (req, res) => {
  const ok = channelService.deleteChannel(req.params.id);
  if (!ok) return res.status(404).json({ error: '渠道不存在' });
  res.json({ ok: true });
});

/** 从渠道同步账号到本地号池 */
channelRoutes.post('/:id/sync', async (req, res) => {
  try {
    const result = await channelSyncService.syncFromChannel(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** 检查渠道能力 */
channelRoutes.get('/:id/capabilities', (req, res) => {
  const channel = channelService.getChannel(req.params.id);
  if (!channel) return res.status(404).json({ error: '渠道不存在' });
  res.json({
    syncable: channelSyncService.isSyncable(channel.pusherType),
    ...channelRemoteService.getChannelCapabilities(channel),
  });
});

/** 获取远端账号列表（脱敏，不含 accessToken） */
channelRoutes.get('/:id/remote-accounts', async (req, res) => {
  try {
    const full = await channelRemoteService.fetchRemoteAccountsByChannelId(req.params.id);
    // 脱敏：去掉 accessToken
    const accounts = full.map(({ accessToken: _, ...rest }) => rest);
    res.json({ accounts, total: accounts.length });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** 探测渠道远端账号用量（后端直接用 token 探测，不暴露 token 给前端） */
channelRoutes.post('/:id/probe-usage', async (req, res) => {
  try {
    const full = await channelSyncService.fetchRemoteAccounts(req.params.id);
    const tokens = full
      .filter((a) => a.accessToken.trim() !== '')
      .map((a) => ({ email: a.email, accessToken: a.accessToken, planType: a.planType }));
    if (tokens.length === 0) {
      return res.json({ total: 0, probed: 0, results: [] });
    }
    const result = await usageProbeService.probeBatchUsage(tokens, { concurrency: 1 });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** 通道健康检查（验证连通性） */
channelRoutes.post('/:id/health-check', async (req, res) => {
  try {
    const channel = channelService.getChannel(req.params.id);
    if (!channel) return res.status(404).json({ error: '渠道不存在' });

    const config = channel.pusherConfig;
    const baseUrl = String(config.base_url ?? '').replace(/\/+$/, '');
    if (!baseUrl) return res.json({ ok: false, error: '未配置 base_url' });

    const start = Date.now();
    try {
      const { default: axios } = await import('axios');
      const token = String(config.token ?? config.admin_key ?? '');
      const headers: Record<string, string> = {};
      let testUrl = `${baseUrl}`;
      if (channel.pusherType === 'sub2api') {
        if (token) headers['Authorization'] = `Bearer ${token}`;
        testUrl = `${baseUrl}/api/v1/admin/accounts?limit=1`;
      } else if (channel.pusherType === 'codex2api') {
        if (token) headers['X-Admin-Key'] = token;
        testUrl = `${baseUrl}/api/admin/accounts`;
      } else if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const resp = await axios.get(testUrl, {
        headers,
        timeout: 10000,
        validateStatus: () => true,
      });
      const latencyMs = Date.now() - start;
      res.json({
        ok: resp.status < 500,
        statusCode: resp.status,
        latencyMs,
      });
    } catch (err) {
      res.json({
        ok: false,
        error: (err as Error).message,
        latencyMs: Date.now() - start,
      });
    }
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** 检查邮箱是否已存在于远端 */
channelRoutes.post('/:id/check-duplicates', async (req, res) => {
  try {
    const { emails } = req.body ?? {};
    if (!Array.isArray(emails)) return res.status(400).json({ error: '请提供 emails 数组' });

    const channel = channelService.getChannel(req.params.id);
    if (!channel) return res.status(404).json({ error: '渠道不存在' });

    const pusher = defaultRegistry.get(channel.pusherType);
    if (!pusher.canFetchRemote()) return res.json({ duplicates: [], unique: emails });

    const remoteAccounts = await pusher.fetchRemoteAccounts(channel.pusherConfig);
    const remoteEmails = new Set(remoteAccounts.map((a) => a.email.toLowerCase()));

    const duplicates: string[] = [];
    const unique: string[] = [];
    for (const email of emails) {
      if (remoteEmails.has(email.toLowerCase())) duplicates.push(email);
      else unique.push(email);
    }

    res.json({ duplicates, unique, remoteTotal: remoteAccounts.length });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** 拉取 SUB2API 分组列表 */
channelRoutes.get('/:id/groups', async (req, res) => {
  try {
    const channel = channelService.getChannel(req.params.id);
    if (!channel) return res.status(404).json({ error: '渠道不存在' });
    if (channel.pusherType !== 'sub2api') {
      return res.status(400).json({ error: '仅 SUB2API 渠道支持分组' });
    }
    const pusher = defaultRegistry.get('sub2api') as Sub2ApiPusher;
    const groups = await pusher.fetchGroups(channel.pusherConfig);
    res.json(groups);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
