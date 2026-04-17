# 数据管理重新设计方案

## 背景

当前系统账号数据管理存在以下核心问题：
- 删除行为不一致（手动=物理删除，转移=软删除，同步消失=打标签）
- 无操作历史，无法追溯账号经历了什么
- 无批次概念，无法按导入批次回溯
- 号池和文件模式数据割裂
- 号池导出不支持格式选择

## 目标

1. **所有删除全部软删除** — 数据不丢失，可恢复
2. **操作可追溯** — 关键操作有记录，账号有完整时间线
3. **批次可管理** — 按导入批次查看、筛选、操作
4. **数据可流转** — 文件模式的数据可以入池，号池导出格式统一

---

## P1：统一软删除 + 回收站

### 后端改动

#### 1.1 accounts 表新增字段

```sql
ALTER TABLE accounts ADD COLUMN deleteReason TEXT NOT NULL DEFAULT '';
-- deleteReason 取值：manual / transfer / sync_removed / expired / invalid_token
-- deletedAt 字段已存在，保留
```

文件：`server/src/persistence/db.ts`

#### 1.2 account.store.ts 改造

- `remove(id)` → 改为调用 `softDelete(id, 'manual')`
- `removeBatch(ids)` → 改为调用 `softDeleteBatch(ids, 'manual')`
- `softDelete(id, reason)` — 增加 reason 参数
- `softDeleteBatch(ids, reason)` — 增加 reason 参数
- 新增 `permanentDelete(id)` — 真正物理删除（仅回收站中使用）
- 新增 `permanentDeleteBatch(ids)` — 批量物理删除

文件：`server/src/persistence/account.store.ts`

#### 1.3 路由改造

- `DELETE /accounts/:id` → 改为软删除 + reason=manual
- `POST /accounts/batch-delete` → 改为软删除 + reason=manual
- 新增 `POST /accounts/:id/restore` — 从回收站恢复
- 新增 `POST /accounts/batch-restore` — 批量恢复
- 新增 `POST /accounts/:id/permanent-delete` — 永久删除
- 新增 `POST /accounts/batch-permanent-delete` — 批量永久删除
- 现有 `transfer` 逻辑中的 softDelete 增加 reason=transfer
- 现有 `syncFromChannel` 中远端消失的账号改为 softDelete(reason=sync_removed)

文件：`server/src/routes/account.routes.ts`，`server/src/services/transfer.service.ts`，`server/src/services/channel-sync.service.ts`

#### 1.4 shared 类型更新

Account 接口增加 deleteReason 字段：

```typescript
export interface Account {
  // ... 现有字段
  deleteReason?: string;  // manual / transfer / sync_removed / expired / invalid_token
}
```

文件：`shared/types/account.ts`

### 前端改动

#### 1.5 号池页面增加回收站 Tab

在现有号池页面顶部增加 Tab 切换：
- "活跃账号" — `deletedAt IS NULL`（默认，和当前一致）
- "回收站" — `deletedAt IS NOT NULL`

回收站视图列：Email / Plan / 删除原因 / 删除时间 / 操作（恢复 / 永久删除）

文件：`client/src/pages/AccountPoolPage.tsx`

#### 1.6 查询接口适配

`GET /accounts` 增加 `deleted=true` 查询参数，返回已软删除的账号。

文件：`server/src/routes/account.routes.ts`，`server/src/persistence/account.store.ts`

---

## P2：操作事件表 + 事件记录

### 后端改动

#### 2.1 新建 account_events 表

```sql
CREATE TABLE IF NOT EXISTS account_events (
  id          TEXT PRIMARY KEY,
  accountId   TEXT NOT NULL,
  email       TEXT NOT NULL,
  eventType   TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '{}',
  createdAt   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_accountId ON account_events(accountId);
CREATE INDEX IF NOT EXISTS idx_events_type ON account_events(eventType);
CREATE INDEX IF NOT EXISTS idx_events_time ON account_events(createdAt);
```

文件：`server/src/persistence/db.ts`

#### 2.2 新建 event.store.ts

```typescript
export function addEvent(accountId, email, eventType, detail): void
export function addBatchEvents(events[]): void
export function getByAccountId(accountId, limit, offset): AccountEvent[]
export function getByEventType(eventType, limit, offset): AccountEvent[]
```

文件：`server/src/persistence/event.store.ts`（新建）

#### 2.3 各操作写入事件

在以下操作中增加事件记录：

| 操作 | eventType | 写入位置 |
|---|---|---|
| 导入 | import | account.routes.ts `/import` |
| 同步 | import | channel-sync.service.ts |
| 探测 | probe | account.routes.ts `/probe` |
| 刷新 | refresh | account.routes.ts `/:id/refresh`、`/batch-refresh` |
| 推送 | push | push.service.ts `pushSingleItem` |
| 删除 | delete | account.routes.ts 删除相关端点 |
| 恢复 | restore | account.routes.ts 恢复端点 |
| 转移 | transfer | transfer.service.ts |

#### 2.4 pushHistory 冻结

- 新的推送记录只写 account_events 表
- pushHistory JSON 字段保留只读，不再写入新数据
- 前端查询时合并两个来源

#### 2.5 事件查询 API

- `GET /accounts/:id/events` — 获取某账号的事件列表
- `GET /accounts/:id/events?type=push` — 按类型过滤

文件：`server/src/routes/account.routes.ts`

### 前端改动

#### 2.6 账号事件时间线

号池页面某一行展开或点击后，显示该账号的事件时间线。

文件：`client/src/pages/AccountPoolPage.tsx`（或新建事件组件）

---

## P3：导入批次管理

### 后端改动

#### 3.1 新建 import_batches 表

```sql
CREATE TABLE IF NOT EXISTS import_batches (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL,
  sourceType   TEXT NOT NULL,
  channelId    TEXT DEFAULT '',
  totalCount   INTEGER NOT NULL DEFAULT 0,
  addedCount   INTEGER NOT NULL DEFAULT 0,
  updatedCount INTEGER NOT NULL DEFAULT 0,
  skippedCount INTEGER NOT NULL DEFAULT 0,
  files        TEXT NOT NULL DEFAULT '[]',
  createdAt    TEXT NOT NULL
);
```

文件：`server/src/persistence/db.ts`

#### 3.2 新建 batch.store.ts

文件：`server/src/persistence/batch.store.ts`（新建）

#### 3.3 accounts 表新增 batchId

```sql
ALTER TABLE accounts ADD COLUMN batchId TEXT NOT NULL DEFAULT '';
```

#### 3.4 导入逻辑改造

每次导入/同步时：
1. 创建 import_batch 记录
2. 账号设置 batchId
3. 返回 batchId 给前端

文件：`server/src/services/account.service.ts`，`server/src/services/channel-sync.service.ts`

#### 3.5 批次查询 API

- `GET /batches` — 批次列表
- `GET /batches/:id` — 批次详情（含关联的账号统计）

文件：`server/src/routes/account.routes.ts`（或新建 batch.routes.ts）

### 前端改动

#### 3.6 号池页面增加批次筛选

在筛选栏增加"导入批次"下拉，或新增"按批次"Tab。

文件：`client/src/pages/AccountPoolPage.tsx`

---

## P4：导出统一 + 文件模式入池

### 后端改动

#### 4.1 号池导出支持多格式

`GET /accounts/export` 增加 `format` 和 `mode` 参数，复用 data.routes.ts 中的 formatRaw/formatCpa/formatSub2Api 函数。

提取导出格式函数到独立模块：`server/src/utils/export-formatter.ts`

文件：`server/src/routes/account.routes.ts`，`server/src/routes/data.routes.ts`

#### 4.2 文件模式入池

新增 API：`POST /data/import-to-pool` — 将文件模式的数据导入到号池。

接收 fileId + fieldMapping，调用 accountService.importFromRecords()。

文件：`server/src/routes/data.routes.ts`

### 前端改动

#### 4.3 号池导出格式选择

号池页面的"导出"按钮弹出 ExportDialog，支持 raw/cpa/sub2api + individual/merged。

文件：`client/src/pages/AccountPoolPage.tsx`

#### 4.4 检测/转换页面增加"导入到号池"

在导出按钮旁增加"导入到号池"按钮。

文件：`client/src/pages/DetectPage.tsx`，`client/src/pages/ConvertPage.tsx`

---

## P5：前端事件时间线 UI

### 前端改动

#### 5.1 EventTimeline 组件

通用的事件时间线组件，接收 accountId，调用 `/accounts/:id/events` 展示。

各事件类型有对应的图标和描述模板。

文件：`client/src/components/EventTimeline.tsx`（新建）

#### 5.2 号池页面集成

行内展开或侧边栏展示账号的事件时间线。

文件：`client/src/pages/AccountPoolPage.tsx`

---

## 实施顺序

```
P1 统一软删除 + 回收站     ← 最核心，改动最小
  ↓
P2 事件表 + 事件记录       ← 追溯能力基础
  ↓
P3 导入批次管理            ← 批次回溯
  ↓
P4 导出统一 + 入池         ← 打通数据孤岛
  ↓
P5 事件时间线 UI           ← 可视化追溯
```

每个阶段独立可交付，不依赖后续阶段。
