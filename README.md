# auth-pusher

账号 / Token 数据的解析、检测与推送工作台。支持从多种导出格式（原始 Token 文件、SUB2API 导出等）解析账号，探测配额与可用性，并推送到多种目标渠道（codex2api、sub2api、cpa-upload 等）。

## 技术栈

- **Server**: Node 22 · TypeScript · Express 5 · better-sqlite3 · zod · node-cron · pino
- **Client**: React 19 · Vite · TypeScript · TailwindCSS 4 · Radix UI · React Router
- **包管理**: pnpm（workspace 分别装在 `server/` 和 `client/`）

## 目录结构

```
.
├── client/        前端（Vite + React）
├── server/        后端（Express + SQLite）
├── shared/        前后端共享的 TypeScript 类型
└── data/          运行时数据目录（DB、上传、profiles 配置）
```

## 环境要求

- Node.js 22.x（`.nvmrc` 已指定）
- pnpm 9+

## 快速开始

```bash
# 安装依赖
pnpm install
pnpm --dir server install
pnpm --dir client install

# 开发（同时启动前后端）
pnpm dev
```

- 后端默认监听 `http://localhost:3771`
- 前端默认运行在 `http://localhost:5573`，通过 Vite 代理将 `/api` 转发到后端

## 独立启动

```bash
pnpm dev:server   # 仅后端 (tsx watch)
pnpm dev:client   # 仅前端 (vite)
```

## 构建与上线

```bash
pnpm --dir server build && pnpm --dir server start
pnpm --dir client build   # 产物在 client/dist
```

## 环境变量

| 变量 | 作用 | 默认值 |
|---|---|---|
| `PORT` | 后端端口 | `3771` |
| `AUTH_PUSHER_DATA_DIR` | 运行时数据目录 | `./data` |
| `LOG_LEVEL` | pino 日志级别 | `info` |
| `NODE_ENV` | 运行环境 | - |
| `OPENAI_TEST_MODEL` | 账号可用性检测模型 | - |
| `OPENAI_PROBE_MODEL` | 配额探测模型 | - |

## 数据目录

`data/` 下运行时会产生的文件已在 `.gitignore` 中排除：

- `data/auth-pusher.db*` —— SQLite 数据库
- `data/uploads/`、`data/push-tasks/`、`data/channels.json`
- `auth-data/`、`04-04-ha-10/` 等导出目录

保留并版本化的：

- `data/profiles.json` —— 内置数据解析器模板（字段映射 / 指纹规则），不含账号数据

## JSON → SQLite 迁移

早期版本使用 JSON 文件存储，如需从旧数据迁移：

```bash
pnpm --dir server migrate
```

## 主要模块

- **账号池** (`/account`)：导入、检测、去重
- **数据解析 profile** (`/profile`)：可配置字段映射与指纹规则
- **渠道** (`/channel`)：推送目标配置
- **推送任务** (`/push`、`/tasks`)：批量推送与结果追踪
- **定时任务** (`/scheduler`)：node-cron 调度
- **推送器** (`server/src/pushers/`)：`codex2api`、`sub2api`、`cpa-upload`
