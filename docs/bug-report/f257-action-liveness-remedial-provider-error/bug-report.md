---
feature_ids: [F257]
topics: [hold-ball, action-liveness, routing-guard, provider-error]
doc_kind: bug-report
created: 2026-07-15
---

# F257 action-liveness remedial provider error misclassification

| 栏位 | 内容 |
| --- | --- |
| **1. 现象** | 第一次纯文本成功响应触发 bounded remedial 后，若补救 invocation 返回 provider error，错误事件会发给客户端，但路由状态仍按成功处理并追加 `action-liveness-guard-failure` notice。期望只有 provider error 终态，不把它误报成第二次无动作。 |
| **2. 证据** | `runGuardRemedial` 处理补救流时没有同步外层 `hadError` / `hadProviderError` / `collectedErrorText`；补救结束后的 failure-notice 分支因此看到 `hadError === false`。复现测试：`provider error during the bounded remedial is not mislabeled as an action-liveness failure`。 |
| **3. 根因** | 补救流复制了主 invocation 的消息聚合逻辑，但漏掉 error-state 聚合，导致可见 stream event 与持久化/终态状态机分叉。 |
| **4. 诊断策略** | 用真实 `routeSerial` 集成测试构造“纯文本首轮 → error 补救轮”，同时断言 error 仍可见且无 action-liveness failure notice。 |
| **5. 超时策略** | 若单一 error-state 同步不能使测试转绿，停止局部补丁，抽取主轮/补救轮共享的 error accumulator。 |
| **6. 预警策略** | 若修复需要第三套 error 标志或改变普通 invocation 路径，说明状态聚合坐标系错误，应重构而非继续加分支。 |
| **7. 用户可见交互修正** | provider 故障只显示真实 provider error，不再额外出现误导性的“猫再次没有动作”警告。 |
| **8. 验收** | 新回归测试先红后绿；随后复跑 action-liveness 与既有 routing-guard 集成套件。 |
