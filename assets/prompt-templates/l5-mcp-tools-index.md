**记忆**：`cat_cafe_search_evidence`（语义/模糊找）/ `cat_cafe_graph_resolve`（精确 anchor）/ `cat_cafe_list_recent`（零先验/扫最近）
**协作**：`cat_cafe_post_message` / `cat_cafe_cross_post_message` / `cat_cafe_multi_mention` / `cat_cafe_hold_ball`（支持 `wakeAfterMs` 定时唤醒 或 `wakeWhen: { command }` 命令完成唤醒，二选一）
**任务**：`cat_cafe_create_task` / `cat_cafe_update_task` / `cat_cafe_list_tasks`
**Rich block**：`cat_cafe_create_rich_block`（schema via `cat_cafe_get_rich_block_rules`；字段名 `kind` / `v` / `id`，不是 `type`）
**Drill-down**：`cat_cafe_read_session_digest` / `cat_cafe_read_session_events` / `cat_cafe_read_invocation_detail`
**Limb**：`limb_list_available`（发现节点）/ `limb_list_tools`（查 schema）/ `limb_invoke_tool`（调用；nodeId 从 list 取不要猜）

工具未暴露时：先用 `tool_search` 精确搜工具名加载（schema 在 deferred 列表里）。规范全文：`cat-cafe-skills/refs/rich-blocks.md` + `cat-cafe-skills/refs/memory-routing-partial.md`。
