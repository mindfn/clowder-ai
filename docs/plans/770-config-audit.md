# #770 全量配置审计（direct+间接 consumer + 归属）

> 228 vars。refs=代码中该 name 的引用文件数（任何访问方式）。


## 删 REMOVE (14)

| var | cat | refs | inventory note |
|---|---|---|---|
| ANTHROPIC_PROXY_DEBUG | proxy | 0 | 测试/调试专用 |
| CAT_CAFE_REPO_ROOT | server | 0 | 部署/内部专用 |
| GITHUB_AUTHORITATIVE_REVIEW_LOGINS | github_review | 1 | [DEPRECATED] F140 cutover，description 已标废弃；PR-E 只做 |
| GITHUB_REVIEW_IMAP_HOST | github_review | 0 | [DEPRECATED] IMAP 邮件监控通道已在 v0.9.0 (#596) 移除；PR rev |
| GITHUB_REVIEW_IMAP_PASS | github_review | 0 | [DEPRECATED] IMAP 邮件监控通道已在 v0.9.0 (#596) 移除；PR rev |
| GITHUB_REVIEW_IMAP_PORT | github_review | 0 | [DEPRECATED] IMAP 邮件监控通道已在 v0.9.0 (#596) 移除；PR rev |
| GITHUB_REVIEW_IMAP_PROXY | github_review | 0 | [DEPRECATED] IMAP 邮件监控通道已在 v0.9.0 (#596) 移除；PR rev |
| GITHUB_REVIEW_IMAP_USER | github_review | 0 | [DEPRECATED] IMAP 邮件监控通道已在 v0.9.0 (#596) 移除；PR rev |
| GITHUB_REVIEW_POLL_INTERVAL_MS | github_review | 0 | [DEPRECATED] IMAP 邮件监控通道已在 v0.9.0 (#596) 移除；PR rev |
| HYPERFOCUS_THRESHOLD_MS | server | 0 | 部署/内部专用 |
| MCP_SERVER_PORT | server | 1 | 部署/内部专用 |
| MODE_SWITCH_REQUIRES_APPROVAL | cli | 0 | [DEPRECATED] Mode consumer 在 registry backfill (b5 |
| REDIS_DEV_PORT | server | 0 | Redis 端口由部署/脚本管理 |
| REDIS_PORT | server | 1 | Redis 端口由部署/脚本管理 |

## 收敛→app_data_dir (9)

| var | cat | refs | inventory note |
|---|---|---|---|
| EMBED_PORT | evidence | 3 | 服务/数据库路径，内部 |
| EMBED_URL | evidence | 2 | 服务/数据库路径，内部 |
| EVENT_MEMORY_DB | evidence | 1 | 服务/数据库路径，内部 |
| EVIDENCE_DB | evidence | 1 | 服务/数据库路径，内部 |
| GLOBAL_KNOWLEDGE_DB | evidence | 1 | 服务/数据库路径，内部 |
| LISTEN_MODE_DB | tts | 1 | 听读模式状态数据库（文件路径，非目录）；不进通用 projection |
| OPENCODE_DB | cli | 1 | 服务/数据库路径，内部 |
| TASK_OUTCOME_DB | evidence | 1 | 服务/数据库路径，内部 |
| WORLD_DB | evidence | 1 | 服务/数据库路径，内部 |

## 保留System (28)

| var | cat | refs | inventory note |
|---|---|---|---|
| ANNOTATION_DATA_DIR | storage | 1 | 系统级存储路径，保留在 System view |
| API_SERVER_HOST | server | 4 | 已在 SYSTEM_VARS / System Settings 中 |
| API_SERVER_PORT | server | 10 | 已在 SYSTEM_VARS / System Settings 中 |
| BACKLOG_TTL_SECONDS | storage | 1 | 已在 SYSTEM_VARS 中 |
| CAT_CAFE_DATA_DIR | cli | 11 | 已在 SYSTEM_VARS 中 |
| CLI_TIMEOUT_MS | cli | 7 | 已在 SYSTEM_VARS 中 |
| CORS_ALLOW_PRIVATE_NETWORK | server | 3 | 已在 SYSTEM_VARS / System Settings 中 |
| DEFAULT_OWNER_USER_ID | server | 16 | owner/trust-anchor，security group，只读，restartRequir |
| DOCS_ROOT | storage | 1 | 系统级文档根目录，保留在 System view |
| DRAFT_TTL_SECONDS | storage | 1 | 已在 SYSTEM_VARS 中 |
| FRONTEND_PORT | server | 4 | 已在 SYSTEM_VARS / System Settings 中 |
| FRONTEND_URL | server | 1 | 已在 SYSTEM_VARS / System Settings 中 |
| LOG_LEVEL | server | 1 | 已在 SYSTEM_VARS / System Settings 中 |
| MAX_A2A_DEPTH | budget | 6 | A2A 预算阈值，保留在 System view |
| MEMORY_STORE | storage | 2 | 已在 SYSTEM_VARS 中 |
| MESSAGE_TTL_SECONDS | storage | 2 | 已在 SYSTEM_VARS 中 |
| PREVIEW_GATEWAY_ENABLED | server | 1 | 已在 SYSTEM_VARS / System Settings 中 |
| PREVIEW_GATEWAY_PORT | server | 3 | 已在 SYSTEM_VARS / System Settings 中 |
| PROJECT_ALLOWED_ROOTS | server | 2 | 已在 SYSTEM_VARS / System Settings 中 |
| PROJECT_ALLOWED_ROOTS_APPEND | server | 1 | 已在 SYSTEM_VARS / System Settings 中 |
| PROJECT_DENIED_ROOTS | server | 1 | 已在 SYSTEM_VARS / System Settings 中 |
| REDIS_KEY_PREFIX | storage | 6 | 已在 SYSTEM_VARS 中 |
| REDIS_URL | storage | 29 | 已在 SYSTEM_VARS 中 |
| SUMMARY_TTL_SECONDS | storage | 1 | 已在 SYSTEM_VARS 中 |
| TASK_TTL_SECONDS | storage | 2 | 已在 SYSTEM_VARS 中 |
| THREAD_TTL_SECONDS | storage | 3 | 已在 SYSTEM_VARS 中 |
| TRANSCRIPT_DATA_DIR | storage | 1 | 已在 SYSTEM_VARS 中 |
| UPLOAD_DIR | server | 14 | 已在 SYSTEM_VARS / System Settings 中 |

## 保留System·运行时 (3)

| var | cat | refs | inventory note |
|---|---|---|---|
| AUDIT_LOG_DIR | cli | 2 | 审计日志路径；不进通用 projection |
| CLI_RAW_ARCHIVE_DIR | cli | 2 | 原始 CLI 归档路径；不进通用 projection |
| LOG_DIR | server | 3 | 日志目录；不进通用 projection |

## 保留System·需重启 (1)

| var | cat | refs | inventory note |
|---|---|---|---|
| PROMETHEUS_PORT | telemetry | 1 | 部署级可观测性配置 |

## 模块单一入口(已有UI) (32)

| var | cat | refs | inventory note |
|---|---|---|---|
| ANTHROPIC_API_KEY | server | 7 | 由统一账户/凭证系统管理；env 仅作 bootstrap/fallback |
| CAT_CAFE_CODEX_CARRIER | codex | 6 | per-cat carrier 可由 Hub 成员编辑器覆盖；env 仅作 bootstrap/fa |
| CAT_CODEX_APPROVAL_POLICY | codex | 2 | per-cat/全局 Codex 行为配置，已有 HubCatEditor + ConfigStor |
| CAT_CODEX_SANDBOX_MODE | codex | 2 | per-cat/全局 Codex 行为配置，已有 HubCatEditor + ConfigStor |
| CODEX_AUTH_MODE | codex | 4 | per-cat/全局 Codex 行为配置，已有 HubCatEditor + ConfigStor |
| DEFAULT_CAT_ID | cli | 3 | 默认猫选择，已有 DefaultCatSelector UI 覆盖；env 仅作 bootstrap |
| EMBED_MODE | evidence | 2 | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| F102_ABSTRACTIVE | evidence | 2 | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| F102_API_BASE | evidence | 1 | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| F102_API_KEY | evidence | 1 | future accounts migration 是目标，但 summarizer 当前仍直接读  |
| F102_DURABLE_CANDIDATES | evidence | 1 | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| F102_TOPIC_SEGMENTS | evidence | 1 | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| F163_ALWAYS_ON_INJECTION | evidence | 1 | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| F163_AUTHORITY_BOOST | evidence | 2 | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| F163_COMPRESSION | evidence | 2 | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| F163_CONTRADICTION_DETECTION | evidence | 2 | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| F163_PROMOTION_GATE | evidence | 1 | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| F163_RETRIEVAL_RERANK | evidence | 1 | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| F163_REVIEW_QUEUE | evidence | 2 | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| F200_CONSUMPTION_RERANK | evidence | 1 | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| GITHUB_MCP_PAT | github_review | 3 | 已由 GitHub plugin manifest 覆盖，清出 System 避免双入口 |
| GITHUB_SETUP_NOISE_BOT_LOGINS | github_review | 4 | 已由 GitHub plugin manifest 覆盖，清出 System 避免双入口 |
| GITHUB_TOKEN | github_review | 4 | 已由 GitHub plugin manifest 覆盖，清出 System 避免双入口 |
| GOOGLE_API_KEY | gemini | 3 | 由统一账户/凭证系统管理；env 仅作 bootstrap/fallback |
| MOONSHOT_API_KEY | kimi | 5 | 由统一账户/凭证系统管理；env 仅作 bootstrap/fallback |
| OPENAI_API_KEY | codex | 5 | 由统一账户/凭证系统管理；env 仅作 bootstrap/fallback |
| PROMPT_CAPTURE | telemetry | 2 | Prompt X-Ray 开关；已有专用模块 UI，不进通用 projection |
| PROMPT_CAPTURE_CATS | telemetry | 2 | Prompt X-Ray 开关；已有专用模块 UI，不进通用 projection |
| THEME_CONFIG | frontend | 1 | F056 主题系统已有完整 UI 覆盖，当前 runtimeEditable=true，但由模块 U |
| VAPID_PRIVATE_KEY | push | 4 | 已有 PushServiceConfig UI 覆盖 |
| VAPID_PUBLIC_KEY | push | 4 | 已有 PushServiceConfig UI 覆盖 |
| VAPID_SUBJECT | push | 4 | 已有 PushServiceConfig UI 覆盖 |

## 进模块·组件补齐 (19)

| var | cat | refs | inventory note |
|---|---|---|---|
| ANTIGRAVITY_AUTO_APPROVE | antigravity | 1 | Antigravity 执行策略，内部/高级 |
| ANTIGRAVITY_AUTO_RESUME | antigravity | 1 | Antigravity 执行策略，内部/高级 |
| ANTIGRAVITY_YOLO_RUN_COMMAND | antigravity | 1 | Antigravity 执行策略，内部/高级 |
| AUDIT_LOG_INCLUDE_PROMPT_SNIPPETS | cli | 2 | 审计日志隐私开关；需专用组件 UI，不进通用 projection |
| CAT_CAFE_SIGNAL_USER | signal | 5 | Signal MCP 运行身份绑定，身份锚点类；比照 DEFAULT_OWNER 处理原则，暂不给  |
| CHARACTER_VOICE_DIR | tts | 1 | 服务端点/缓存目录，服务生命周期 UI 可配置端口/模型，但 URL/dir 级 env 暂无 UI |
| CONNECTOR_MEDIA_DIR | connector | 2 | connector 媒体下载目录；不进通用 projection |
| GENSHIN_VOICE_DIR | tts | 1 | 服务端点/缓存目录，服务生命周期 UI 可配置端口/模型，但 URL/dir 级 env 暂无 UI |
| GITHUB_REPO_ALLOWLIST | github_review | 3 | GitHub Repo Inbox 配置；需专用组件 UI，不进通用 projection |
| GITHUB_REPO_INBOX_CAT_ID | github_review | 3 | GitHub Repo Inbox 配置；需专用组件 UI，不进通用 projection |
| GITHUB_WEBHOOK_SECRET | github_review | 1 | GitHub Repo Inbox 配置；需专用组件 UI，不进通用 projection；SECR |
| NEXT_PUBLIC_WHISPER_URL | frontend | 2 | 服务端点/缓存目录；不进通用 projection |
| SIGNALS_ROOT_DIR | signal | 2 | Signal 插件/信号源配置，暂无 UI |
| TRANSCRIPT_DIR | audio | 1 | 服务端点/缓存目录；不进通用 projection |
| TTS_CACHE_DIR | tts | 1 | 服务端点/缓存目录；不进通用 projection |
| WEB_PUSH_TIMEOUT_MS | budget | 1 | Web Push 超时；不进通用 projection |
| WEIXIN_CAPTURE_INBOUND_VOICE_MEDIA | connector | 1 | 微信连接器实验开关；不进通用 projection |
| WEIXIN_ENABLE_UNSAFE_VOICE_MODES | connector | 1 | 微信连接器实验开关；不进通用 projection |
| WEIXIN_VOICE_ITEM_MODE | connector | 1 | 微信连接器实验开关；不进通用 projection |

## 进模块·待决策 (4)

| var | cat | refs | inventory note |
|---|---|---|---|
| AUDIO_SERVICE_URL | audio | 2 | 远程/自托管 sidecar 音频服务端点；是否继续支持待产品决策，当前不进任何 projectio |
| NEXT_PUBLIC_LLM_POSTPROCESS_URL | frontend | 2 | 远程/自托管 sidecar LLM 后处理端点；是否继续支持待产品决策，当前不进任何 projec |
| TTS_URL | tts | 3 | 远程/自托管 sidecar TTS 端点；是否继续支持待产品决策，当前不进任何 projectio |
| WHISPER_URL | stt | 4 | 远程/自托管 sidecar STT 端点；是否继续支持待产品决策，当前不进任何 projectio |

## hide (118)

| var | cat | refs | inventory note |
|---|---|---|---|
| ALLOWED_WORKSPACE_DIRS | server | 10 | 部署/内部专用 |
| ALL_PROXY | proxy | 3 | 上游配置/HTTP_PROXY 等部署级 |
| ANTHROPIC_PROXY_ENABLED | proxy | 1 | 部署级网络拓扑选择，与其余 proxy vars 一致，issue #770 allowlist 未 |
| ANTHROPIC_PROXY_PORT | proxy | 3 | 部署级网络拓扑选择，与其余 proxy vars 一致 |
| ANTHROPIC_PROXY_UPSTREAMS_PATH | proxy | 1 | 上游配置/HTTP_PROXY 等部署级 |
| ANTIGRAVITY_BRAIN_HOME | cli | 1 | CLI home/brain 目录，内部 |
| ANTIGRAVITY_CSRF_TOKEN | antigravity | 1 | 部署/内部专用 |
| ANTIGRAVITY_NATIVE_EXECUTOR | antigravity | 1 | Antigravity 执行策略，内部/高级 |
| ANTIGRAVITY_PORT | antigravity | 1 | 自动发现，通常无需配置 |
| ANTIGRAVITY_RUN_COMMAND_TIMEOUT_MS | antigravity | 1 | Antigravity 内部路径/端口 |
| ANTIGRAVITY_TLS | antigravity | 1 | 自动发现，通常无需配置 |
| ANTIGRAVITY_TRACE_RAW | antigravity | 1 | 测试/调试专用 |
| CAT_BRANCH_ROLLBACK_RETRY_DELAYS_MS | cli | 1 | CLI 内部/调试/路径配置 |
| CAT_CAFE_AGENT_KEY_ALLOW_MEMORY_SIDECAR | server | 2 | 部署/内部专用 |
| CAT_CAFE_AGENT_KEY_BOUND_CAT_ID | server | 2 | 运行时注入（agent-key 绑定身份） |
| CAT_CAFE_AGENT_KEY_FILE | server | 6 | 部署/内部专用 |
| CAT_CAFE_AGENT_KEY_FILES | server | 11 | 部署/内部专用 |
| CAT_CAFE_AGENT_KEY_SECRET | server | 4 | 部署/内部专用 |
| CAT_CAFE_AGENT_KEY_SIDECAR_DISABLED | server | 1 | 部署/内部专用 |
| CAT_CAFE_AGY_CWD_ROOT | gemini | 1 | AGY profile/cwd 隔离根目录，内部路径 |
| CAT_CAFE_AGY_PROFILE_ROOT | gemini | 1 | AGY profile/cwd 隔离根目录，内部路径 |
| CAT_CAFE_API_URL | cli | 27 | 运行时注入 |
| CAT_CAFE_AUTH_TOMBSTONE_GC_TTL_MS | server | 1 | 部署/内部专用（auth tombstone GC TTL） |
| CAT_CAFE_CALLBACK_FETCH_TIMEOUT_MS | cli | 1 | callback outbox 内部调优 |
| CAT_CAFE_CALLBACK_OUTBOX_DIR | cli | 1 | callback outbox 内部调优 |
| CAT_CAFE_CALLBACK_OUTBOX_ENABLED | cli | 1 | callback outbox 内部调优 |
| CAT_CAFE_CALLBACK_OUTBOX_MAX_ATTEMPTS | cli | 1 | callback outbox 内部调优 |
| CAT_CAFE_CALLBACK_OUTBOX_MAX_FLUSH_BATCH | cli | 1 | callback outbox 内部调优 |
| CAT_CAFE_CALLBACK_RETRY_DELAYS_MS | cli | 1 | callback outbox 内部调优 |
| CAT_CAFE_CALLBACK_TOKEN | cli | 12 | 每 invocation 注入的 callback auth secret，内部运行时身份凭证，不进 |
| CAT_CAFE_CAT_ID | cli | 16 | 运行时注入 |
| CAT_CAFE_CODEX_APP_SERVER_IDLE_TTL_MS | codex | 1 | app-server 内部调优 |
| CAT_CAFE_CODEX_APP_SERVER_MAX_WARM_HOSTS | codex | 1 | app-server 内部调优 |
| CAT_CAFE_CODEX_OAUTH_TRANSPORT | codex | 2 | per-cat/全局 Codex 行为配置（OAuth transport）；运行行为类，非账号凭证 |
| CAT_CAFE_CONFIG_ROOT | server | 4 | 部署/内部专用 |
| CAT_CAFE_CREDENTIAL_FILE | cli | 7 | 运行时注入 |
| CAT_CAFE_DESKTOP_MODE | server | 3 | 部署/内部专用 |
| CAT_CAFE_DIAGNOSTICS | cli | 1 | 测试/调试专用 |
| CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT | cli | 1 | 测试/调试专用 |
| CAT_CAFE_ENABLE_LEGACY_PINCHTAB_BRIDGE | server | 1 | 部署/内部专用 |
| CAT_CAFE_EXECUTION_ID | cli | 2 | 运行时注入（execution id） |
| CAT_CAFE_F255_AWAKENED_LEASE_MS | server | 2 | 部署/内部专用 |
| CAT_CAFE_GLOBAL_CONFIG_ROOT | server | 7 | 部署/内部专用 |
| CAT_CAFE_GPT_PRO_AGENT_KEY_FILE | server | 1 | 部署/内部专用 |
| CAT_CAFE_HOME | server | 2 | 部署/内部专用 |
| CAT_CAFE_INVOCATION_ID | cli | 14 | 运行时注入 |
| CAT_CAFE_INVOCATION_REGISTRY | server | 3 | 运行时注入 |
| CAT_CAFE_MCP_CREDS_DIR | server | 1 | 部署/内部专用 |
| CAT_CAFE_MCP_SERVER_PATH | cli | 9 | MCP 路径/凭证目录，内部运行时配置 |
| CAT_CAFE_PERSONAL_CHROME_PAIRING_SECRET | server | 2 | 部署/内部专用（personal chrome 配对密钥） |
| CAT_CAFE_PERSONAL_CHROME_SOCKET | server | 2 | 部署/内部专用（personal chrome socket） |
| CAT_CAFE_PERSONAL_CHROME_WEB_STORE_URL | server | 1 | 部署/内部专用（personal chrome web store） |
| CAT_CAFE_PREFLIGHT_TIMEOUT_MS | cli | 1 | 部署/内部专用 |
| CAT_CAFE_PROCESS_EXECUTION_OWNER | cli | 1 | 运行时注入（execution owner） |
| CAT_CAFE_PROCESS_OWNER_ID | cli | 3 | 运行时注入（process owner） |
| CAT_CAFE_PROVISION_GLOBAL_SIDECAR | server | 3 | 部署/内部专用 |
| CAT_CAFE_READONLY | antigravity | 11 | 部署/内部专用 |
| CAT_CAFE_REDIS_TEST_ISOLATED | server | 5 | 测试/调试专用 |
| CAT_CAFE_REMOTE_PORT | server | 1 | 部署/内部专用 |
| CAT_CAFE_REMOTE_TOKEN | server | 1 | 部署/内部专用 |
| CAT_CAFE_REPO_FULL_NAME | server | 2 | 部署/内部专用 |
| CAT_CAFE_RIPGREP_PATH | antigravity | 1 | Antigravity 内部路径/端口 |
| CAT_CAFE_RUNTIME_ROOT | server | 8 | 部署/内部专用 |
| CAT_CAFE_RUNTIME_SESSION_SEAL_REAPER_INTERVAL_MS | antigravity | 1 | 部署/内部专用 |
| CAT_CAFE_SERVICES_CONFIG | server | 1 | 部署/内部专用 |
| CAT_CAFE_SKIP_HOMEDIR_MIGRATION | server | 1 | 测试/调试专用 |
| CAT_CAFE_SUPERVISOR_KILL_GRACE_MS | cli | 3 | CLI 内部/调试/路径配置 |
| CAT_CAFE_SUPERVISOR_PARENT_PID | cli | 2 | 运行时注入 |
| CAT_CAFE_SUPERVISOR_POLL_MS | cli | 1 | CLI 内部/调试/路径配置 |
| CAT_CAFE_SUPERVISOR_SOCKET_DIR | cli | 2 | CLI 内部/调试/路径配置（supervisor socket dir） |
| CAT_CAFE_TEST_REAL_HOME | server | 1 | 测试/调试专用 |
| CAT_CAFE_TEST_SANDBOX | server | 1 | 测试/调试专用 |
| CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT | server | 1 | 测试/调试专用 |
| CAT_CAFE_THREAD_ID | cli | 10 | 运行时注入 |
| CAT_CAFE_TMUX_AGENT | cli | 2 | CLI 内部/调试/路径配置 |
| CAT_CAFE_TMUX_PATH | cli | 1 | CLI 内部/调试/路径配置 |
| CAT_CAFE_USER_ID | server | 20 | 部署/内部专用 |
| CAT_CAFE_VERDICT_REPO_FULL_NAME | server | 2 | 部署/内部专用（verdict repo 绑定） |
| CAT_CAFE_WORKSPACE_ROOT | server | 9 | 部署/内部专用 |
| CAT_TEMPLATE_PATH | cli | 7 | 成员/模板默认值；不进通用 projection |
| CDP_DEBUG | cli | 1 | 测试/调试专用 |
| CHROME_EXECUTABLE_PATH | server | 1 | 部署/内部专用 |
| CLAUDE_CREDENTIALS_PATH | quota | 1 | credentials 文件路径，内部 |
| CODEX_CREDENTIALS_PATH | quota | 1 | credentials 文件路径，内部 |
| CODEX_HOME | cli | 4 | CLI home/brain 目录，内部 |
| COMMUNITY_NARRATOR_THREAD_ID | server | 2 | 部署/内部专用 |
| COMMUNITY_PUBLISH_DEFAULT_REPO | server | 1 | 部署/内部专用 |
| COMMUNITY_PUBLISH_REPO_ALLOWLIST | server | 1 | 部署/内部专用 |
| CONNECTOR_GATEWAY_AUTOSTART | connector | 5 | runtime 入口授权开关，不能由用户配置 |
| DEBUG | server | 1 | 测试/调试专用 |
| F233_BALL_CUSTODY_PROBE_INTERVAL_MS | server | 1 | 部署/内部专用 |
| GAME_NARRATOR_ENABLED | server | 1 | 测试/调试专用 |
| GEMINI_ADAPTER | gemini | 1 | Gemini 适配器选择；不进通用 projection |
| GITHUB_SELF_LOGIN | github_review | 1 | GitHub / Repo Inbox 配置；不进通用 projection |
| HTTPS_PROXY | proxy | 4 | 上游配置/HTTP_PROXY 等部署级 |
| HTTP_PROXY | proxy | 4 | 上游配置/HTTP_PROXY 等部署级 |
| KIMI_AUTH_TOKEN | quota | 2 | 额度抓取 token，敏感，建议通过 accounts 注入 |
| KIMI_CONFIG_FILE | kimi | 1 | kimi-cli 内部路径 |
| KIMI_QUOTA_API_FALLBACK_ENABLED | quota | 2 | credentials 文件路径，内部 |
| KIMI_SHARE_DIR | kimi | 2 | kimi-cli 内部路径 |
| NEXT_PUBLIC_API_URL | frontend | 6 | 构建时/前端起始地址，部署级 |
| NEXT_PUBLIC_DEBUG_SKIP_FILE_CHANGE_UI | frontend | 1 | Next.js 构建期或调试开关 |
| NEXT_PUBLIC_PROJECT_ROOT | frontend | 1 | Next.js 构建期或调试开关 |
| OTEL_EXPORTER_OTLP_ENDPOINT | telemetry | 1 | 部署级可观测性配置 |
| OTEL_SDK_DISABLED | telemetry | 2 | 部署级可观测性配置 |
| PINCHTAB_CDP_PORT | antigravity | 1 | 部署/内部专用 |
| QUOTA_OFFICIAL_REFRESH_ENABLED | quota | 1 | 官方额度刷新总开关，运维级 |
| RUNTIME_REPO_PATH | server | 1 | 部署/内部专用 |
| TELEMETRY_ALERT_ACTIVE_INVOCATIONS | telemetry | 1 | 部署级可观测性配置 |
| TELEMETRY_ALERT_ERROR_RATE | telemetry | 2 | 部署级可观测性配置 |
| TELEMETRY_ALERT_P95_LATENCY_S | telemetry | 1 | 部署级可观测性配置 |
| TELEMETRY_DEBUG | telemetry | 1 | 调试遥测，仅限 dev/test |
| TELEMETRY_DEBUG_FORCE | telemetry | 1 | 调试遥测，仅限 dev/test |
| TELEMETRY_EXPORT_RAW_SYSTEM_IDS | telemetry | 1 | 部署级可观测性配置 |
| TELEMETRY_HMAC_SALT | telemetry | 2 | 部署级可观测性配置 |
| VISIBILITY_CURSOR_V2 | storage | 1 | 部署级 activation gate |
| WEB_PUBLIC_DIR | server | 1 | 部署/内部专用 |
| WORKSPACE_LINKED_ROOTS | server | 1 | 部署/内部专用 |
