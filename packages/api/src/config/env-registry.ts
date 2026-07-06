/**
 * Environment variable registry — single source of truth for all user-configurable env vars.
 * Used by GET /api/config/env-summary to report current values to the frontend.
 *
 * ⚠️  ALL CATS: 新增 process.env.XXX → 必须在下方 ENV_VARS 数组注册！
 *    不注册 = 前端「环境 & 文件」页面看不到 = co-creator不知道 = 不存在。
 *    SOP.md「环境变量注册」章节有说明。
 *
 * To add a new env var:
 * 1. Add an EnvDefinition to ENV_VARS below
 * 2. Use process.env[name] in your code as usual
 * The "环境 & 文件" tab picks it up automatically.
 */

export type EnvCategory =
  | 'server'
  | 'storage'
  | 'cli'
  | 'connector'
  | 'frontend'
  | 'github_review'
  | 'evidence'
  | 'quota'
  | 'telemetry';

export interface EnvDefinition {
  /** The env var name, e.g. 'REDIS_URL' */
  name: string;
  /** Default value description (for display, not logic) */
  defaultValue: string;
  /** Human-readable description (Chinese) */
  description: string;
  /** Grouping category */
  category: EnvCategory;
  /** If true, current value is masked as '***' in API response */
  sensitive: boolean;
  /** If 'url', credentials in URL are masked but host/port/db preserved */
  maskMode?: 'url';
  /** If false, keep internal-only and do not surface in Hub env editor */
  hubVisible?: boolean;
  /** Explicit opt-in for generic Hub env writes. Unset means read-only. */
  runtimeEditable?: boolean;
  /**
   * If true, changes written via Hub take effect only after service restart.
   * The PATCH still succeeds (writes .env + process.env), but running instances
   * captured the value at startup and won't re-read it.
   * UI should show a "restart required" hint instead of "immediate effect".
   */
  restartRequired?: boolean;
  /** If true, this var should appear in .env.example (enforced by check:env-example) */
  exampleRecommended?: boolean;
  /** Explicit allowed values for cycle-style toggles (e.g. ['off','shadow','on']) */
  allowedValues?: string[];
}

export const ENV_CATEGORIES: Record<EnvCategory, string> = {
  server: '服务器',
  storage: '存储',
  cli: 'CLI',
  connector: '平台接入 (Telegram/飞书)',
  frontend: '前端',
  github_review: 'GitHub Review 监控',
  evidence: 'F102 记忆系统',
  quota: '额度监控',
  telemetry: '可观测性 (OTel)',
};

export const ENV_VARS: EnvDefinition[] = [
  // --- server ---
  {
    name: 'API_SERVER_PORT',
    defaultValue: '3004',
    description: 'API 服务端口',
    category: 'server',
    sensitive: false,
    runtimeEditable: false,
    exampleRecommended: true,
  },
  {
    name: 'PREVIEW_GATEWAY_PORT',
    defaultValue: '4100',
    description: 'Preview Gateway 端口（F120 独立 origin 反向代理）。修改后需重启服务生效',
    category: 'server',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'API_SERVER_HOST',
    defaultValue: '127.0.0.1',
    description: 'API 监听地址（改为 0.0.0.0 可让手机/平板通过局域网或 Tailscale 访问）。修改后需重启服务生效',
    category: 'server',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'CORS_ALLOW_PRIVATE_NETWORK',
    defaultValue: 'false',
    description:
      '允许局域网/Tailscale 设备访问（手机、平板等）。开启后，来自 192.168.x.x / 10.x.x.x / Tailscale 100.x.x.x 的浏览器可以正常连接。注意：会信任整个私网内的所有设备。修改后需重启服务生效',
    category: 'server',
    sensitive: false,
    runtimeEditable: false,
    exampleRecommended: true,
  },
  {
    name: 'UPLOAD_DIR',
    defaultValue: './uploads',
    description: '文件上传目录。修改后需重启服务生效',
    category: 'server',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'PROJECT_ALLOWED_ROOTS',
    defaultValue: '(未设置 — 使用 denylist 模式，仅拦截系统目录)',
    description:
      'Legacy allowlist 模式：设置后切换为 allowlist，仅允许列出的根目录（按系统路径分隔符分隔；配合 PROJECT_ALLOWED_ROOTS_APPEND=true 可追加默认 roots）。未设置时使用 denylist 模式（见 PROJECT_DENIED_ROOTS）。安全边界变量，不可从 Hub 修改',
    category: 'server',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'PROJECT_ALLOWED_ROOTS_APPEND',
    defaultValue: 'false',
    description:
      '设为 true 则将 PROJECT_ALLOWED_ROOTS 追加到默认根目录（home, /tmp, /workspace 等）而非覆盖。安全边界变量，不可从 Hub 修改',
    category: 'server',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'PROJECT_DENIED_ROOTS',
    defaultValue: '(平台默认系统目录)',
    description:
      'Denylist 模式下额外拦截的目录（按系统路径分隔符分隔，会合并到平台默认拦截列表）。仅在未设置 PROJECT_ALLOWED_ROOTS 时生效。安全边界变量，不可从 Hub 修改',
    category: 'server',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'FRONTEND_URL',
    defaultValue: '(自动检测)',
    description:
      '前端固定地址（有反向代理或固定域名时设置，如 https://cafe.example.com）。本机和局域网直连通常不需要改',
    category: 'server',
    sensitive: false,
    runtimeEditable: true,
    restartRequired: true,
  },
  {
    name: 'FRONTEND_PORT',
    defaultValue: '3003',
    description: '前端端口。修改后需重启服务生效',
    category: 'server',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'DEFAULT_OWNER_USER_ID',
    defaultValue: '(未设置)',
    description: '默认所有者用户 ID（信任锚点，不可从 Hub 修改）',
    category: 'server',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'PREVIEW_GATEWAY_ENABLED',
    defaultValue: '1（启用）',
    description: '设为 0 禁用 Preview Gateway（F120）。修改后需重启服务生效',
    category: 'server',
    sensitive: false,
    runtimeEditable: false,
  },

  // --- storage ---
  {
    name: 'REDIS_URL',
    defaultValue: '(未设置 → 内存模式)',
    description: 'Redis 连接地址',
    category: 'storage',
    sensitive: false,
    maskMode: 'url',
    runtimeEditable: false,
    exampleRecommended: true,
  },
  {
    name: 'REDIS_KEY_PREFIX',
    defaultValue: 'cat-cafe:',
    description: 'Redis key 命名空间前缀，用于多实例隔离',
    category: 'storage',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'MEMORY_STORE',
    defaultValue: '(未设置)',
    description: '设为 1 显式允许内存模式。修改后需重启服务生效',
    category: 'storage',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'MESSAGE_TTL_SECONDS',
    defaultValue: '604800 (7天)',
    description:
      '消息过期时间（秒）。默认 604800（7天）。设为 0 或负数 → 消息永不过期。注意：过期的 Redis 消息不影响已索引的 evidence_passages（Phase I 保证永久性）',
    category: 'storage',
    sensitive: false,
    runtimeEditable: true,
    restartRequired: true,
  },
  {
    name: 'THREAD_TTL_SECONDS',
    defaultValue: '604800 (7天)',
    description: '对话过期时间',
    category: 'storage',
    sensitive: false,
    runtimeEditable: true,
    restartRequired: true,
  },
  {
    name: 'TASK_TTL_SECONDS',
    defaultValue: '604800 (7天)',
    description: '任务过期时间',
    category: 'storage',
    sensitive: false,
    runtimeEditable: true,
    restartRequired: true,
  },
  {
    name: 'SUMMARY_TTL_SECONDS',
    defaultValue: '604800 (7天)',
    description: '摘要过期时间',
    category: 'storage',
    sensitive: false,
    runtimeEditable: true,
    restartRequired: true,
  },
  {
    name: 'BACKLOG_TTL_SECONDS',
    defaultValue: '(无过期)',
    description: 'Backlog 过期时间',
    category: 'storage',
    sensitive: false,
    runtimeEditable: true,
    restartRequired: true,
  },
  {
    name: 'DRAFT_TTL_SECONDS',
    defaultValue: '(无过期)',
    description: '草稿过期时间',
    category: 'storage',
    sensitive: false,
    runtimeEditable: true,
    restartRequired: true,
  },
  {
    name: 'TRANSCRIPT_DATA_DIR',
    defaultValue: './data/transcripts',
    description: 'Session transcript 存储目录。修改后需重启服务生效',
    category: 'storage',
    sensitive: false,
    runtimeEditable: false,
  },

  // --- cli ---
  {
    name: 'CAT_CAFE_DATA_DIR',
    defaultValue: '(未设置)',
    description: '数据目录根路径。修改后需重启服务生效',
    category: 'cli',
    sensitive: false,
    runtimeEditable: false,
  },

  // --- connector ---
  {
    name: 'WEIXIN_VOICE_ITEM_MODE',
    defaultValue: '(未设置)',
    description:
      '微信原生 voice_item 发送实验模式；未设置时音频按文件附件发送。可选 minimal / playtime / playtime-sec / playtime-encode / metadata',
    category: 'connector',
    sensitive: false,
    runtimeEditable: true,
    allowedValues: ['minimal', 'playtime', 'playtime-sec', 'playtime-encode', 'metadata'],
  },
  {
    name: 'WEIXIN_ENABLE_UNSAFE_VOICE_MODES',
    defaultValue: '0',
    description: '设为 1 时允许已知不稳定的微信原生 voice_item 实验模式（playtime-encode / metadata）',
    category: 'connector',
    sensitive: false,
    runtimeEditable: true,
    allowedValues: ['0', '1'],
  },
  {
    name: 'WEIXIN_CAPTURE_INBOUND_VOICE_MEDIA',
    defaultValue: '0',
    description: '设为 1 时将微信入站语音媒体捕获为文件附件，便于调试语音/媒体链路',
    category: 'connector',
    sensitive: false,
    runtimeEditable: true,
    allowedValues: ['0', '1'],
  },

  // --- frontend ---
  {
    name: 'THEME_CONFIG',
    defaultValue: '(未设置)',
    description: 'OKLCH 主题配置 JSON（清浏览器缓存后可从此恢复）',
    category: 'frontend',
    sensitive: false,
    runtimeEditable: true,
  },

  // --- github_review ---
  {
    name: 'GITHUB_WEBHOOK_SECRET',
    defaultValue: '(未设置 → Repo Inbox webhook 不启用)',
    description: 'GitHub Repo Inbox webhook secret（需与 GitHub 仓库 webhook 配置一致）',
    category: 'github_review',
    sensitive: true,
    runtimeEditable: true,
    exampleRecommended: true,
  },
  {
    name: 'GITHUB_SELF_LOGIN',
    defaultValue: '(未设置 → 自动使用 gh api /user 识别)',
    description: 'GitHub review feedback 自身账号 fallback；当 gh api /user 无法识别时用于防止处理自己发出的评论',
    category: 'github_review',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'GITHUB_REPO_ALLOWLIST',
    defaultValue: '(未设置)',
    description: 'GitHub Repo Inbox 监控仓库白名单（逗号分隔 owner/repo）',
    category: 'github_review',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'GITHUB_REPO_INBOX_CAT_ID',
    defaultValue: '(自动 → 第一只猫)',
    description: 'GitHub Repo Inbox 事件路由到的猫 ID',
    category: 'github_review',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'GITHUB_MCP_PAT',
    defaultValue: '(未设置)',
    description: 'GitHub Personal Access Token (MCP 用)',
    category: 'github_review',
    sensitive: true,
    runtimeEditable: true,
  },

  // --- evidence (F102 记忆系统) ---
  {
    name: 'EMBED_MODE',
    defaultValue: 'off',
    description:
      '向量检索模式 (off/shadow/on)。留空时由 console 上 Embedding 服务的开关决定（启用 → on）。' +
      '显式设了 shadow/on 会覆盖，但 EMBED_MODE=off 不会关掉已经在 console 启用的服务（防 foot-gun）。修改后需重启服务生效',
    category: 'evidence',
    sensitive: false,
    allowedValues: ['off', 'shadow', 'on'],
    runtimeEditable: false,
  },
  {
    name: 'F102_ABSTRACTIVE',
    defaultValue: 'off',
    description: 'Phase G 摘要调度器 (off/on)，on = 定时调用 Opus API 做 thread 摘要',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'F102_DURABLE_CANDIDATES',
    defaultValue: 'off',
    description: 'Phase G candidate 提取 (off/on)，on = 摘要时提取 durable knowledge 候选到 MarkerQueue',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'F102_TOPIC_SEGMENTS',
    defaultValue: 'off',
    description: 'Phase G topic 分段 (off/on)，on = 摘要按话题切分多个 segment',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
  },
  // --- F200 Recall Telemetry ---
  {
    name: 'F200_CONSUMPTION_RERANK',
    defaultValue: 'off',
    description: 'F200 consumption-weighted rerank (off/shadow/on)',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
    allowedValues: ['off', 'shadow', 'on'],
  },
  // --- F163 记忆熵减实验框架 ---
  {
    name: 'F163_AUTHORITY_BOOST',
    defaultValue: 'off',
    description: 'F163 authority 加权 rerank (off/shadow/on)',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
    allowedValues: ['off', 'shadow', 'on'],
  },
  {
    name: 'F163_ALWAYS_ON_INJECTION',
    defaultValue: 'off',
    description: 'F163 constitutional 物理注入 (off/shadow/on)',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
    allowedValues: ['off', 'shadow', 'on'],
  },
  {
    name: 'F163_RETRIEVAL_RERANK',
    defaultValue: 'off',
    description: 'F163 多轴元数据 rerank (off/shadow/on)',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
    allowedValues: ['off', 'shadow', 'on'],
  },
  {
    name: 'F163_COMPRESSION',
    defaultValue: 'off',
    description: 'F163 非替代式压缩 (off/suggest/apply)',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
    allowedValues: ['off', 'suggest', 'apply'],
  },
  {
    name: 'F163_PROMOTION_GATE',
    defaultValue: 'off',
    description: 'F163 晋升门禁 (off/suggest/apply)',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
    allowedValues: ['off', 'suggest', 'apply'],
  },
  {
    name: 'F163_CONTRADICTION_DETECTION',
    defaultValue: 'off',
    description: 'F163 矛盾检测 (off/suggest/apply)',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
    allowedValues: ['off', 'suggest', 'apply'],
  },
  {
    name: 'F163_REVIEW_QUEUE',
    defaultValue: 'off',
    description: 'F163 审计 review queue (off/suggest/apply)',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
    allowedValues: ['off', 'suggest', 'apply'],
  },
  {
    name: 'EMBED_URL',
    defaultValue: 'http://127.0.0.1:9880',
    description: 'Embedding 服务地址（独立 Python GPU 进程 scripts/embed-api.py）',
    category: 'evidence',
    sensitive: false,
  },
  {
    name: 'EVIDENCE_DB',
    defaultValue: '{repoRoot}/evidence.sqlite',
    description: 'F102 SQLite 数据库路径',
    category: 'evidence',
    sensitive: false,
  },
  {
    name: 'GLOBAL_KNOWLEDGE_DB',
    defaultValue: '~/.cat-cafe/global_knowledge.sqlite',
    description: 'F-4: 全局知识 SQLite 路径（Skills + MEMORY.md 编译产物）',
    category: 'evidence',
    sensitive: false,
  },
  {
    name: 'WORLD_DB',
    defaultValue: '{repoRoot}/world.sqlite',
    description: 'F093 World Engine SQLite 数据库路径',
    category: 'evidence',
    sensitive: false,
  },
  {
    name: 'TASK_OUTCOME_DB',
    defaultValue: '{repoRoot}/task-outcome-episodes.sqlite',
    description: 'F192 Phase G Task Outcome Episode SQLite 数据库路径',
    category: 'evidence',
    sensitive: false,
  },
  {
    name: 'EVENT_MEMORY_DB',
    defaultValue: '{repoRoot}/event-memory.sqlite',
    description: 'F227 Event Memory typed event index SQLite 数据库路径',
    category: 'evidence',
    sensitive: false,
  },
  {
    name: 'F102_API_BASE',
    defaultValue: '(未设置 → 摘要调度器不启用)',
    description: 'Phase G 摘要调度用的反代 API 地址（不是猫猫自己的 provider profile）',
    category: 'evidence',
    sensitive: false,
  },
  {
    name: 'F102_API_KEY',
    defaultValue: '(未设置)',
    description: 'Phase G 摘要调度用的反代 API Key',
    category: 'evidence',
    sensitive: true,
    runtimeEditable: true,
  },
  {
    name: 'EMBED_PORT',
    defaultValue: '9880',
    description: 'Embedding 服务端口（仅在 EMBED_URL 未设置时使用）',
    category: 'evidence',
    sensitive: false,
  },

  // --- quota ---
  {
    name: 'QUOTA_OFFICIAL_REFRESH_ENABLED',
    defaultValue: '0（默认关闭）',
    description: '设为 1 允许官方额度抓取（Claude/Codex OAuth + Kimi auth token）',
    category: 'quota',
    sensitive: false,
  },
  {
    name: 'CLAUDE_CREDENTIALS_PATH',
    defaultValue: '~/.claude/.credentials.json',
    description: 'Claude OAuth credentials 文件路径（官方额度刷新用）',
    category: 'quota',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'CODEX_CREDENTIALS_PATH',
    defaultValue: '(未设置 → ~/.codex/auth.json)',
    description: 'Codex OAuth credentials 文件路径（官方额度刷新用）',
    category: 'quota',
    sensitive: false,
    runtimeEditable: false,
  },

  // --- telemetry (F153) ---
  {
    name: 'TELEMETRY_DEBUG',
    defaultValue: '(未设置 → 关闭)',
    description:
      '设为 true 启用 ConsoleSpanExporter（UNREDACTED）。仅 NODE_ENV=development/test 生效，其他环境需额外设 TELEMETRY_DEBUG_FORCE=true',
    category: 'telemetry',
    sensitive: false,
    hubVisible: false,
    runtimeEditable: false,
  },
  {
    name: 'TELEMETRY_DEBUG_FORCE',
    defaultValue: '(未设置 → 关闭)',
    description: '生产环境强制启用 TELEMETRY_DEBUG 的安全覆写开关。仅限紧急排障',
    category: 'telemetry',
    sensitive: false,
    hubVisible: false,
    runtimeEditable: false,
  },
  {
    name: 'TELEMETRY_HMAC_SALT',
    defaultValue: '(dev/test 自动 fallback)',
    description: 'HMAC salt — 遥测系统 ID 伪名化用。生产环境必设，缺失则禁用 OTel',
    category: 'telemetry',
    sensitive: true,
    runtimeEditable: false,
  },
  {
    name: 'TELEMETRY_EXPORT_RAW_SYSTEM_IDS',
    defaultValue: '(未设置 → HMAC 伪名化)',
    description: '设为 1 跳过 HMAC，导出原始系统 ID（仅限自托管受控环境）',
    category: 'telemetry',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'PROMETHEUS_PORT',
    defaultValue: '9464',
    description: 'Prometheus /metrics 抓取端口',
    category: 'telemetry',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'OTEL_EXPORTER_OTLP_ENDPOINT',
    defaultValue: '(未设置 → 仅 Prometheus)',
    description: 'OTLP 导出端点（设置后同时推送 traces/metrics/logs 到该端点）',
    category: 'telemetry',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'OTEL_SDK_DISABLED',
    defaultValue: '(未设置 → 启用)',
    description: '设为 true 完全禁用 OTel SDK',
    category: 'telemetry',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'TELEMETRY_ALERT_ERROR_RATE',
    defaultValue: '0.3',
    description: 'Burn-rate 告警：错误率阈值（0-1）',
    category: 'telemetry',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'TELEMETRY_ALERT_P95_LATENCY_S',
    defaultValue: '120',
    description: 'Burn-rate 告警：P95 延迟阈值（秒）',
    category: 'telemetry',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'TELEMETRY_ALERT_ACTIVE_INVOCATIONS',
    defaultValue: '50',
    description: 'Burn-rate 告警：活跃 invocation 数阈值',
    category: 'telemetry',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'PROMPT_CAPTURE',
    defaultValue: 'off',
    description: 'Prompt X-Ray 开关（on=启用 canonical prompt 捕获）',
    category: 'telemetry',
    sensitive: false,
    runtimeEditable: true,
    allowedValues: ['off', 'on'],
  },
  {
    name: 'PROMPT_CAPTURE_CATS',
    defaultValue: '(未设置 → 全部猫)',
    description: 'Prompt X-Ray 白名单：逗号分隔 catId（空=全部）',
    category: 'telemetry',
    sensitive: false,
    runtimeEditable: true,
  },
];

/**
 * The explicit system-surface allowlist — only these env var names appear on
 * the "System config" page.  Hardcoded; adding a var here is the only way to
 * surface it on System Settings.
 */
export const SYSTEM_VARS: ReadonlySet<string> = new Set([
  'API_SERVER_HOST',
  'API_SERVER_PORT',
  'BACKLOG_TTL_SECONDS',
  'CAT_CAFE_DATA_DIR',
  'CORS_ALLOW_PRIVATE_NETWORK',
  'DEFAULT_OWNER_USER_ID',
  'DRAFT_TTL_SECONDS',
  'FRONTEND_PORT',
  'FRONTEND_URL',
  'MEMORY_STORE',
  'MESSAGE_TTL_SECONDS',
  'PREVIEW_GATEWAY_ENABLED',
  'PREVIEW_GATEWAY_PORT',
  'PROJECT_ALLOWED_ROOTS',
  'PROJECT_ALLOWED_ROOTS_APPEND',
  'PROJECT_DENIED_ROOTS',
  'REDIS_KEY_PREFIX',
  'REDIS_URL',
  'SUMMARY_TTL_SECONDS',
  'TASK_TTL_SECONDS',
  'THREAD_TTL_SECONDS',
  'TRANSCRIPT_DATA_DIR',
  'UPLOAD_DIR',
]);

/** Mask credentials in a URL while preserving host/port/db for debugging. */
export function maskUrlCredentials(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = url.username ? '***' : '';
      url.password = '';
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    // Not a valid URL — mask entirely to be safe
    return '***';
  }
}

function maskValue(def: EnvDefinition, raw: string): string {
  if (def.sensitive) return '***';
  if (def.maskMode === 'url') return maskUrlCredentials(raw);
  return raw;
}

function isHubVisibleEnvVar(def: EnvDefinition): boolean {
  return def.hubVisible !== false;
}

/**
 * Build env summary by reading current process.env values.
 * Sensitive values are masked. URL values have credentials masked.
 */
export function buildEnvSummary(): Array<EnvDefinition & { currentValue: string | null }> {
  return ENV_VARS.filter(isHubVisibleEnvVar).map((def) => {
    const raw = process.env[def.name];
    const currentValue = raw != null && raw !== '' ? maskValue(def, raw) : null;
    return { ...def, currentValue };
  });
}

/**
 * Build env summary filtered to the system settings surface only.
 * Uses the hardcoded SYSTEM_VARS allowlist.
 */
export function buildSystemEnvSummary(): Array<EnvDefinition & { currentValue: string | null }> {
  return ENV_VARS.filter((d) => SYSTEM_VARS.has(d.name) && isHubVisibleEnvVar(d)).map((def) => {
    const raw = process.env[def.name];
    const currentValue = raw != null && raw !== '' ? maskValue(def, raw) : null;
    return { ...def, currentValue };
  });
}

export function isEditableEnvVar(def: EnvDefinition): boolean {
  return def.runtimeEditable === true;
}

/** True if this env var is both sensitive AND explicitly opted into runtime editing. */
export function isSensitiveEditableEnvVar(def: EnvDefinition): boolean {
  return def.sensitive && def.runtimeEditable === true;
}

export function isEditableEnvVarName(name: string): boolean {
  return ENV_VARS.some((def) => def.name === name && isHubVisibleEnvVar(def) && isEditableEnvVar(def));
}

/** Check if any of the given env var names are sensitive-editable (requires owner gate). */
export function hasSensitiveEditableVars(names: Iterable<string>): boolean {
  const nameSet = new Set(names);
  return ENV_VARS.some((def) => nameSet.has(def.name) && isSensitiveEditableEnvVar(def));
}

/** Return only the sensitive-editable keys from the given names (for audit filtering). */
export function filterSensitiveEditableKeys(names: Iterable<string>): string[] {
  const nameSet = new Set(names);
  return ENV_VARS.filter((def) => nameSet.has(def.name) && isSensitiveEditableEnvVar(def)).map((def) => def.name);
}
