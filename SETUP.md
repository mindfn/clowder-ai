# Setup Guide

**English** | [中文](SETUP.zh-CN.md)

> **Detailed documentation has moved to the [Clowder AI website](https://zts212653.github.io/clowder-ai/docs.html)** — startup flags, environment variables, FAQ, and architecture guides.

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| **Node.js** | >= 20 | [nodejs.org](https://nodejs.org/) |
| **pnpm** | >= 9 | `npm install -g pnpm` |
| **Redis** | >= 7 *(optional)* | `brew install redis` · [redis.io](https://redis.io/) · use `--memory` to skip |

## Install & Run

```bash
git clone https://github.com/zts212653/clowder-ai.git
cd clowder-ai
pnpm install
pnpm start          # opens http://localhost:3003
```

Or download a desktop installer from the [Releases page](https://github.com/zts212653/clowder-ai/releases/latest) (Windows `.exe` / macOS `.dmg`).

## Common Flags

| Flag | Effect |
|------|--------|
| `--quick` | Skip rebuild |
| `--memory` | Skip Redis (in-memory store) |
| `--daemon` | Run in background |

## More

- [Startup & Commands](https://zts212653.github.io/clowder-ai/docs.html) — all `pnpm start` options
- [Environment Variables](https://zts212653.github.io/clowder-ai/docs.html) — `.env` reference
- [FAQ](https://zts212653.github.io/clowder-ai/docs.html) — common questions
- [README](README.md) — project overview
