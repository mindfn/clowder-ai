---
title: "多 Agent 协作范式 — 文档族导航（原 v5 合稿已拆分）"
doc_kind: index
version: 6
feature_ids: [F117, F167, F224, F233, F254]
topics: [multi-agent, a2a, teamact, coordination, paradigm, index]
created: 2026-07-25
status: superseded-by-split
author: "宪宪/claude-fable-5"
source_thread: thread_mruayc4owlyzazbx
provenance: >
  v1-v5 是三合一合稿（sol 五轮 review APPROVE，merge dd23ebb3b）。
  co-creator 指出三份文档目标不同不应合并（2026-07-25），v6 起拆分为文档族，
  本文件保留为导航页以维持既有 anchor 与引用稳定。规范内容以拆分后文档为准。
---

# 多 Agent 协作范式 — 文档族导航

原合稿（v5）已按受众与生命周期拆分为三份，各自演进：

| 文档 | 目标 | 受众 / 生命周期 |
|------|------|---------------|
| **[teamact-v2-paradigm.md](./teamact-v2-paradigm.md)** | **责任协调模型（设计思考，normative）**：问题定义、实体、协作回合、上下文传递、记忆管理、职责交接、不变量、账本、治理——回答"需要怎样"，不描述现状 | 家里 + 深度读者 / 稳定 |
| **[teamact-v2-gap-migration.md](./teamact-v2-gap-migration.md)** | 差距与改造（descriptive + 计划）：**实测失效记录**、现状映射、差距矩阵、shadow 迁移路径、maintainer 沟通要点——实现坐标与运行数据都在这里 | 工程 / 活文档 |
| **[teamact-v2-tech-article.md](./teamact-v2-tech-article.md)** | 对外交流发布稿：面向用过多 agent 框架的读者，概念场景 + 设计判断 + 行业对照 + 适用判据与局限 | 外部读者 / 发布定稿 |

阅读顺序：责任协调模型是后两份的基础。前两份的插图（图 1–5 / 图 A–B）由 codex 按文中 FIGURE spec 绘制中。历史合稿（v5，五轮 review 收敛全程）见本文件 git 历史（`2ef2bc959` / merge `dd23ebb3b`）。
