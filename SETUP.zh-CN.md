# 安装指南

[English](SETUP.md) | **中文**

> **详细文档已迁移至 [Clowder AI 网站](https://zts212653.github.io/clowder-ai/docs.html)** — 启动参数、环境变量、常见问题和架构说明。

## 前置条件

| 工具 | 版本 | 安装 |
|------|------|------|
| **Node.js** | >= 20 | [nodejs.org](https://nodejs.org/) |
| **pnpm** | >= 9 | `npm install -g pnpm` |
| **Redis** | >= 7 *（可选）* | `brew install redis` · [redis.io](https://redis.io/) · 用 `--memory` 跳过 |

## 安装与运行

```bash
git clone https://github.com/zts212653/clowder-ai.git
cd clowder-ai
pnpm install
pnpm start          # 打开 http://localhost:3003
```

也可以从 [Releases 页面](https://github.com/zts212653/clowder-ai/releases/latest) 下载桌面安装包（Windows `.exe` / macOS `.dmg`）。

## 常用参数

| 参数 | 效果 |
|------|------|
| `--quick` | 跳过重新编译 |
| `--memory` | 跳过 Redis（使用内存存储） |
| `--daemon` | 后台运行 |

## 更多

- [启动命令参考](https://zts212653.github.io/clowder-ai/docs.html) — 所有 `pnpm start` 选项
- [环境变量](https://zts212653.github.io/clowder-ai/docs.html) — `.env` 配置说明
- [常见问题](https://zts212653.github.io/clowder-ai/docs.html) — FAQ
- [README](README.zh-CN.md) — 项目概览
