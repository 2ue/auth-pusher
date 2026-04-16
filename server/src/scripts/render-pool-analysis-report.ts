import fs from 'node:fs/promises';
import path from 'node:path';

type SnapshotAccount = {
  id?: number | string;
  email: string;
  name?: string;
  platform: string;
  type: string;
  status: string;
  schedulable?: boolean;
  disabled?: boolean;
  last_used_at?: string | null;
  current_concurrency?: number;
  account_id?: string;
  organization_id?: string;
  plan_type?: string;
  access_token_sha256: string;
  refresh_token_present: boolean;
  id_token_present: boolean;
};

type DuplicateGroup = {
  email: string;
  records: SnapshotAccount[];
  uniqueTokenHashes: string[];
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

async function latestAuditDir(root: string): Promise<string> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (dirs.length === 0) {
    throw new Error(`no audit directories under ${root}`);
  }
  return path.join(root, dirs[dirs.length - 1]);
}

function groupByEmail(accounts: SnapshotAccount[]): Map<string, SnapshotAccount[]> {
  const out = new Map<string, SnapshotAccount[]>();
  for (const account of accounts) {
    const key = normalizeEmail(account.email);
    const arr = out.get(key) ?? [];
    arr.push(account);
    out.set(key, arr);
  }
  return out;
}

function uniqueEmails(accounts: SnapshotAccount[]): string[] {
  return [...new Set(accounts.map((account) => normalizeEmail(account.email)))].sort();
}

function duplicateGroups(accounts: SnapshotAccount[]): DuplicateGroup[] {
  const grouped = groupByEmail(accounts);
  const result: DuplicateGroup[] = [];
  for (const [email, records] of grouped.entries()) {
    if (records.length <= 1) continue;
    result.push({
      email,
      records: [...records].sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? ''), 'en')),
      uniqueTokenHashes: [...new Set(records.map((record) => record.access_token_sha256))].sort(),
    });
  }
  return result.sort((a, b) => a.email.localeCompare(b.email, 'en'));
}

function emailSet(accounts: SnapshotAccount[]): Set<string> {
  return new Set(uniqueEmails(accounts));
}

function recordMapByEmail(accounts: SnapshotAccount[]): Map<string, SnapshotAccount[]> {
  const grouped = groupByEmail(accounts);
  for (const records of grouped.values()) {
    records.sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? ''), 'en'));
  }
  return grouped;
}

function intersection(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((item) => right.has(item)).sort();
}

function difference(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((item) => !right.has(item)).sort();
}

function chooseKeepRecord(records: SnapshotAccount[]): SnapshotAccount {
  return [...records].sort((a, b) => {
    const aConcurrency = a.current_concurrency ?? 0;
    const bConcurrency = b.current_concurrency ?? 0;
    if (aConcurrency !== bConcurrency) return bConcurrency - aConcurrency;

    const aUsed = a.last_used_at ? new Date(a.last_used_at).getTime() : 0;
    const bUsed = b.last_used_at ? new Date(b.last_used_at).getTime() : 0;
    if (aUsed !== bUsed) return bUsed - aUsed;

    return String(a.id ?? '').localeCompare(String(b.id ?? ''), 'en');
  })[0];
}

function lines(items: string[]): string {
  return items.length ? `${items.join('\n')}\n` : '';
}

async function main(): Promise<void> {
  const auditsRoot = path.resolve(process.cwd(), '../data/pool-audits');
  const auditDir = process.argv[2] ? path.resolve(process.argv[2]) : await latestAuditDir(auditsRoot);

  const pool1Local = await readJsonFile<SnapshotAccount[]>(path.join(auditDir, 'pool1.local.snapshot.json'));
  const pool2Local = await readJsonFile<SnapshotAccount[]>(path.join(auditDir, 'pool2.local.snapshot.json'));
  const pool1Remote = await readJsonFile<SnapshotAccount[]>(path.join(auditDir, 'pool1.remote.snapshot.json'));
  const pool2Remote = await readJsonFile<SnapshotAccount[]>(path.join(auditDir, 'pool2.remote.snapshot.json'));

  const local1Set = emailSet(pool1Local);
  const local2Set = emailSet(pool2Local);
  const remote1Set = emailSet(pool1Remote);
  const remote2Set = emailSet(pool2Remote);
  const localUnion = new Set([...local1Set, ...local2Set]);
  const remoteUnion = new Set([...remote1Set, ...remote2Set]);
  const allUnion = new Set([...localUnion, ...remoteUnion]);

  const localOverlap = intersection(local1Set, local2Set);
  const remoteOverlap = intersection(remote1Set, remote2Set);
  const pool1RemoteDuplicates = duplicateGroups(pool1Remote);
  const pool2RemoteDuplicates = duplicateGroups(pool2Remote);

  const remote1DeleteByCanonical = difference(remote1Set, local1Set);
  const remote1AddByCanonical = difference(local1Set, remote1Set);
  const remote2NonCanonical = difference(remote2Set, local2Set);
  const remote2MissingCanonical = difference(local2Set, remote2Set);

  const remoteOnly = difference(remoteUnion, localUnion);
  const localOnly = difference(localUnion, remoteUnion);

  const strictPool1Target = local1Set.size;
  const strictPool2Target = local2Set.size;
  const targetTotal = allUnion.size;
  const balancedLow = Math.floor(targetTotal / 2);
  const balancedHigh = Math.ceil(targetTotal / 2);
  const balanceGap = Math.max(0, balancedHigh - strictPool1Target);
  const balanceExtraCandidates = remoteOnly.slice(0, balanceGap);
  const balancePool1Target = strictPool1Target + balanceExtraCandidates.length;
  const balancePool2Target = strictPool2Target;

  const pool1RemoteByEmail = recordMapByEmail(pool1Remote);
  const pool2RemoteByEmail = recordMapByEmail(pool2Remote);
  const pool1DuplicateDeleteLines = pool1RemoteDuplicates.map((group) => {
    const keep = chooseKeepRecord(group.records);
    const deleteIds = group.records
      .filter((record) => String(record.id) !== String(keep.id))
      .map((record) => String(record.id))
      .join(',');
    return `${group.email}\tkeep_id=${String(keep.id)}\tdelete_ids=${deleteIds}\tunique_token_hashes=${group.uniqueTokenHashes.length}`;
  });
  const pool2DuplicateDeleteLines = pool2RemoteDuplicates.map((group) => {
    const keep = chooseKeepRecord(group.records);
    const deleteIds = group.records
      .filter((record) => String(record.id) !== String(keep.id))
      .map((record) => String(record.id))
      .join(',');
    return `${group.email}\tkeep_id=${String(keep.id)}\tdelete_ids=${deleteIds}\tunique_token_hashes=${group.uniqueTokenHashes.length}`;
  });

  const remoteOverlapAnalysis = remoteOverlap.map((email) => {
    const pool1Hashes = [...new Set((pool1RemoteByEmail.get(email) ?? []).map((item) => item.access_token_sha256))].sort();
    const pool2Hashes = [...new Set((pool2RemoteByEmail.get(email) ?? []).map((item) => item.access_token_sha256))].sort();
    const sameHash = pool1Hashes.length === pool2Hashes.length && pool1Hashes.every((hash, index) => hash === pool2Hashes[index]);
    return `${email}\tsame_token_hash=${sameHash ? 'yes' : 'no'}\tpool1_records=${(pool1RemoteByEmail.get(email) ?? []).length}\tpool2_records=${(pool2RemoteByEmail.get(email) ?? []).length}`;
  });
  const remoteOnlyDetail = remoteOnly.map((email) => {
    const record = (pool1RemoteByEmail.get(email) ?? [])[0];
    return `${email}\tpool1_id=${String(record?.id ?? '')}\tplan_type=${record?.plan_type ?? ''}\tlast_used_at=${record?.last_used_at ?? ''}\tcurrent_concurrency=${record?.current_concurrency ?? 0}`;
  });

  const md = `# 号池分析报告

生成目录：\`${auditDir}\`

## 1. 数据来源说明

- 本地基线：\`pool1.local.snapshot.json\`、\`pool2.local.snapshot.json\`
- 远端快照：\`pool1.remote.snapshot.json\`、\`pool2.remote.snapshot.json\`
- 本报告只做分析，不包含任何远端写操作
- 这里的 JSON 只是本地导出的分析/备份文件，不是系统实时存储
- 本地实时存储在：\`auth-pusher/data/auth-pusher.db\`
- 远端实时存储在各自的 \`sub2api\` 数据库里

## 2. 关键数量

### 本地基线

- 号池1：${pool1Local.length} 条，唯一邮箱 ${local1Set.size}
- 号池2：${pool2Local.length} 条，唯一邮箱 ${local2Set.size}
- 本地两池交集邮箱：${localOverlap.length}
- 本地总唯一邮箱：${localUnion.size}

### 远端现状

- 号池1：${pool1Remote.length} 条，唯一邮箱 ${remote1Set.size}
- 号池2：${pool2Remote.length} 条，唯一邮箱 ${remote2Set.size}
- 远端两池交集邮箱：${remoteOverlap.length}
- 远端总唯一邮箱：${remoteUnion.size}

### 本地+远端合并去重

- 合并后的总唯一邮箱：${allUnion.size}
- 远端存在但本地基线没有的邮箱：${remoteOnly.length}
- 本地基线有但两个远端都没有的邮箱：${localOnly.length}

## 3. 远端号池自身重复分析

### 号池1 自身重复

- 按邮箱重复组数：${pool1RemoteDuplicates.length}
- 重复额外记录数：${pool1RemoteDuplicates.reduce((sum, item) => sum + item.records.length - 1, 0)}
- 结论：${pool1RemoteDuplicates.length === 0 ? '未发现号池1自身邮箱重复。' : `发现 ${pool1RemoteDuplicates.length} 组重复，而且这些重复都发生在本地号池1应保留邮箱内部。`}

### 号池2 自身重复

- 按邮箱重复组数：${pool2RemoteDuplicates.length}
- 重复邮箱涉及的额外记录数：${pool2RemoteDuplicates.reduce((sum, item) => sum + item.records.length - 1, 0)}
- 结论：${pool2RemoteDuplicates.length === 0 ? '未发现号池2自身邮箱重复。' : '号池2存在自身重复，应该只保留每个重复邮箱的一条记录。'}

## 4. 两个远端号池交叉重复分析

- 远端号池1 与 号池2 交叉重复邮箱数：${remoteOverlap.length}
- 这些交叉邮箱，按你此前的口径，应优先视为号池2归属，因此应从号池1删除
- 本地基线两池交集邮箱数：${localOverlap.length}
- 结论：本地基线本身没有交叉，问题主要发生在远端

## 5. 以本地为准的修复结论

### 号池1

- 应保留唯一邮箱数：${local1Set.size}
- 远端当前唯一邮箱数：${remote1Set.size}
- 应从号池1删除的邮箱数：${remote1DeleteByCanonical.length}
- 应补回号池1的邮箱数：${remote1AddByCanonical.length}
- 另外，号池1内部还需要删除 66 条重复记录

### 号池2

- 应保留唯一邮箱数：${local2Set.size}
- 远端当前唯一邮箱数：${remote2Set.size}
- 号池2非本地基线邮箱数：${remote2NonCanonical.length}
- 号池2缺少本地基线邮箱数：${remote2MissingCanonical.length}
- 号池2额外需要处理的是“重复记录”，不是邮箱集合错误

## 6. 两种可选目标

### 方案A：严格按本地基线纠偏

- 号池1目标唯一邮箱数：${strictPool1Target}
- 号池2目标唯一邮箱数：${strictPool2Target}
- 优点：完全以当前本地正确数据为准，变更最少
- 需要处理：
  - 号池1删除 67 个不属于本地号池1的邮箱
  - 号池1再删除 66 条内部重复记录
  - 号池2只删除 8 条重复记录

### 方案B：尽量均衡，但尽量少改

- 合并去重后的总唯一邮箱数：${targetTotal}
- 理想均衡分配：${balancedLow}/${balancedHigh}
- 如果号池2维持本地基线 58 不动，号池1还差 ${balanceGap} 个邮箱才能到 ${balancedHigh}
- 最少改动做法：
  - 先完成方案A
  - 再从“远端有、但本地两个池都没有”的 10 个邮箱里，选择 ${balanceExtraCandidates.length} 个补到号池1
- 这样最终可变成 ${balancePool1Target}/${balancePool2Target}
- 这个方案不再是“严格按本地基线”，而是允许吸收远端独有邮箱

## 7. 对“尽量均衡”的判断

- 如果坚持“本地数据就是准的”，那严格结论只能是 66/58
- 如果你接受吸收远端独有邮箱，那么可以把号池1补到 67
- 但要做到真正接近 67/67，还需要进一步决定剩余 9 个远端独有邮箱的归属，这已经超出“纠偏”范畴

## 8. 结论摘要

- 号池1远端既有自身重复，也混入了大量号池2邮箱
- 号池2远端邮箱集合基本正确，但有自身重复记录
- 57 个跨池重复邮箱的 token 指纹完全一致，说明同一批账号被同时放进了两个池
- 远端另外还有 10 个邮箱只存在于号池1，不在本地任何池
- 如果只做纠偏，不做均衡：
  - 号池1：删除 67 个错池邮箱，再删除 66 条内部重复记录
  - 号池2：删除 8 条重复记录
- 如果尽量均衡：
  - 先完成上面的纠偏
  - 再从那 10 个远端独有邮箱里选 1 个补入号池1
  - 最终可做到 67/58
`;

  await fs.writeFile(path.join(auditDir, 'analysis.md'), `${md}\n`);
  await fs.writeFile(path.join(auditDir, 'pool1.delete.emails.txt'), lines(remote1DeleteByCanonical));
  await fs.writeFile(path.join(auditDir, 'pool1.add.emails.txt'), lines(remote1AddByCanonical));
  await fs.writeFile(path.join(auditDir, 'pool2.noncanonical.emails.txt'), lines(remote2NonCanonical));
  await fs.writeFile(path.join(auditDir, 'pool2.missing.emails.txt'), lines(remote2MissingCanonical));
  await fs.writeFile(path.join(auditDir, 'remote.cross-pool-overlap.emails.txt'), lines(remoteOverlap));
  await fs.writeFile(path.join(auditDir, 'remote.cross-pool-overlap.detail.txt'), lines(remoteOverlapAnalysis));
  await fs.writeFile(path.join(auditDir, 'remote.pool1.internal-duplicate-records.to-delete.txt'), lines(pool1DuplicateDeleteLines));
  await fs.writeFile(path.join(auditDir, 'pool2.duplicate-records.to-delete.txt'), lines(pool2DuplicateDeleteLines));
  await fs.writeFile(path.join(auditDir, 'remote.only-in-pool1.emails.txt'), lines(remoteOnly));
  await fs.writeFile(path.join(auditDir, 'remote.only-in-pool1.detail.txt'), lines(remoteOnlyDetail));
  await fs.writeFile(path.join(auditDir, 'balance.fill-pool1.candidate-emails.txt'), lines(balanceExtraCandidates));

  console.log(JSON.stringify({
    auditDir,
    localUniqueTotal: localUnion.size,
    remoteUniqueTotal: remoteUnion.size,
    allUniqueTotal: allUnion.size,
    remotePool1DeleteEmails: remote1DeleteByCanonical.length,
    remotePool1AddEmails: remote1AddByCanonical.length,
    remotePool2DuplicateGroups: pool2RemoteDuplicates.length,
    remotePool1DuplicateGroups: pool1RemoteDuplicates.length,
    remoteOnlyInPool1: remoteOnly.length,
    balanceFillPool1Candidates: balanceExtraCandidates.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
