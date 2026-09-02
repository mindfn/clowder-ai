/* Clowder AI — Roadmap Tree: logical tree (single source of truth for the page)
 *
 * The visual tree is generated from this structure. Add / re-status a node here
 * and the tree grows a matching twig, fruit and explorer row on the next load.
 *
 * status: 'ripe'  = shipped and usable today
 *         'green' = growing (in progress)
 *         'bud'   = planned / spec
 *
 * Maturity is curated (2026-09) from docs/ROADMAP.md and docs/features/*.md;
 * it is a public reading of the roadmap, not a runtime probe.
 */
(function attachRoadmapTreeData(global) {
  const t = (en, zh) => ({ en, zh });
  const f = (en, zh, status) => ({ label: t(en, zh), status });

  const roots = [
    {
      id: 'identity',
      label: t('Identity', '身份'),
      items: [
        t('Persistent cat identity', '猫猫身份常量'),
        t('Session & instance boundary', '会话与实例边界'),
        t('Durable ownership', '持久归属'),
      ],
    },
    {
      id: 'authority',
      label: t('Authority', '授权'),
      items: [
        t('Least privilege', '最小权限'),
        t('Explicit approval', '明确审批'),
        t('Revocable grants', '可撤回授权'),
      ],
    },
    {
      id: 'truth',
      label: t('Truth', '真相'),
      items: [t('Provenance', 'Provenance'), t('Freshness', 'Freshness'), t('Traceable correction', '可回源纠正')],
    },
    {
      id: 'safety',
      label: t('Safety', '安全'),
      items: [
        t('Audit & kill switch', '审计与终止'),
        t('Data & privacy', '数据与隐私'),
        t('Rollback & forgetting', '回滚与遗忘'),
      ],
    },
  ];

  const trunk = {
    id: 'trunk',
    label: t('A2A / TeamAct', 'A2A / TeamAct'),
    phases: [
      {
        label: t('Read the state', '读清状态'),
        items: [
          t('Shared source of truth', '共享真相源'),
          t('Current context', '当前上下文'),
          t('Ball custody & work identity', '球权与工作身份'),
        ],
      },
      {
        label: t('Act with evidence', '行动取证'),
        items: [
          t('Owner executes autonomously', 'Owner 自主执行'),
          t('Verifiable output', '产出可验证证据'),
          t('Cross-cat verification', '跨猫交叉验证'),
        ],
      },
      {
        label: t('Judge and route', '判断路由'),
        items: [
          t('Form a verdict', '形成 Verdict'),
          t('Route / Hold', 'Route / Hold'),
          t('Close — no dangling ball', 'Close，无悬空球'),
        ],
      },
    ],
  };

  const branches = [
    {
      id: 'memory',
      color: 'memory',
      label: t('Memory & Continuity', '记忆与连续性'),
      tagline: t('Remembers — and knows when to forget', '记得住，也知道什么时候该忘'),
      limbs: [
        {
          label: t('Keep & guard', '留下与守真'),
          fruits: [
            f('Capture valuable deltas', '捕获有价值的增量', 'ripe'),
            f('Typed Truth approval', 'Typed Truth 审批', 'ripe'),
            f('Provenance, correction, forgetting', '来源、纠正与遗忘', 'ripe'),
          ],
        },
        {
          label: t('Retrieve & trace back', '检索与回源'),
          fruits: [
            f('Collections & indexes', 'Collection 与索引', 'ripe'),
            f('Hybrid search & entity anchors', '混合检索与实体锚点', 'ripe'),
            f('Drill down to the source', '沿证据下钻原文', 'ripe'),
          ],
        },
        {
          label: t('Proactive recall', '主动想起'),
          fruits: [
            f('Typed opportunities', 'Typed Opportunity', 'green'),
            f('Bounded cues, budget, expiry', '有界 Cue、预算与失效', 'green'),
            f('Feedback → autonomous action', '消费反馈 → 自主行动', 'bud'),
          ],
        },
      ],
    },
    {
      id: 'harness',
      color: 'harness',
      label: t('Harness Metabolism', 'Harness 新陈代谢'),
      tagline: t('Turns friction into a more reliable next time', '把摩擦变成下一次更可靠的能力'),
      limbs: [
        {
          label: t('Sense friction', '感知摩擦'),
          fruits: [
            f('Friction signal capture', '摩擦信号采集', 'ripe'),
            f('Trace & responsibility attribution', 'Trace 与责任归因', 'ripe'),
            f('Disposition & receipts', '责任处置与回执', 'green'),
          ],
        },
        {
          label: t('Harden rules', '规则硬化'),
          fruits: [
            f('Distill into SOP / Skill', '沉淀为 SOP / Skill', 'ripe'),
            f('Code guards & tests', '代码守卫与测试', 'ripe'),
            f('Eval verdict loop', 'Eval Verdict 闭环', 'green'),
          ],
        },
        {
          label: t('Keep or retire', '保留或退役'),
          fruits: [
            f('Reversible experiments', '可逆实验与对照', 'green'),
            f('Keep / Demote', 'Keep / Demote', 'green'),
            f('Sunset & crystallize', 'Sunset 与结晶', 'bud'),
          ],
        },
      ],
    },
    {
      id: 'capability',
      color: 'capability',
      label: t('Pluggable Capability', '插件化能力'),
      tagline: t('New models, senses and hands can all grow in', '新模型、新感官和新的手，都能长进来'),
      limbs: [
        {
          label: t('Declare & join', '声明接入'),
          fruits: [
            f('Agent Provider', 'Agent Provider', 'bud'),
            f('Plugin Manifest', 'Plugin Manifest', 'ripe'),
            f('Skills / MCP / Schedule', 'Skills / MCP / Schedule', 'ripe'),
          ],
        },
        {
          label: t('Stable execution', '稳定执行'),
          fruits: [
            f('Capability Registry', 'Capability Registry', 'green'),
            f('Typed Surface', 'Typed Surface', 'green'),
            f('Limb / World Driver', 'Limb / World Driver', 'green'),
          ],
        },
        {
          label: t('Safe governance', '安全治理'),
          fruits: [
            f('Permissions, sandbox, approval', '权限、沙箱与审批', 'ripe'),
            f('Lease, audit, replay', 'Lease、审计与回放', 'green'),
            f('Presence, health, verification', 'Presence、健康与验证', 'green'),
          ],
        },
      ],
    },
    {
      id: 'life',
      color: 'life',
      label: t('Shared Life', '共同生活'),
      tagline: t('Capability becomes companionship you can feel', '能力最终要成为可以感受到的陪伴'),
      limbs: [
        {
          label: t('Know each other', '认识彼此'),
          fruits: [
            f('First meeting & discovery', '第一次相遇与功能发现', 'ripe'),
            f('Profile / Taste', 'Profile / Taste', 'green'),
            f('People, relationships, shared history', '人物、关系与共同历史', 'green'),
          ],
        },
        {
          label: t('Manage attention', '管理注意力'),
          fruits: [
            f('Ball custody & plans visible', '球权与计划可见', 'ripe'),
            f('Unified approval center', '统一审批中心', 'green'),
            f('Effort & attention navigation', 'Effort 与注意力导航', 'bud'),
          ],
        },
        {
          label: t('Visible companionship', '可见相伴'),
          fruits: [
            f('Private time & diaries', '私人时间与日记', 'ripe'),
            f('Visible café & presence', '可见猫咖与状态', 'green'),
            f('Self-expression & co-creation', '主动表达与共同创造', 'bud'),
          ],
        },
      ],
    },
  ];

  const crown = [
    {
      label: t('Software / Products', '软件 / 产品'),
      body: t('Turn ideas into working systems', '把想法做成可用系统'),
    },
    {
      label: t('Research / Knowledge', '研究 / 知识'),
      body: t('Settle exploration into shared understanding', '把探索沉淀成共同理解'),
    },
    { label: t('Games / Stories', '游戏 / 故事'), body: t('Create worlds you can step into', '创造可进入的新世界') },
    {
      label: t('Care / Companionship', '陪伴 / 关怀'),
      body: t('Let capability reach real relationships', '让能力抵达真实关系'),
    },
    { label: t('New Forests', '新森林'), body: t('Seed new communities', '孕育新的共同体') },
  ];

  // Runtime sprites are cut from the canon character sheet (docs/design/roadmap-tree-assets.md §1).
  // face: 1 = drawn facing right, -1 = facing left, 0 = frontal (never mirrored). ratio = width / height.
  // roles map choreography poses that have no dedicated file onto a sheet pose.
  const cats = [
    {
      id: 'ragdoll',
      name: t('Ragdoll', '布偶猫'),
      family: 'opus',
      height: 96,
      sprites: {
        sit: { ratio: 0.86, face: 0, scale: 0.72 },
        walk: { ratio: 1.38, face: 1, scale: 0.62 },
        stand: { ratio: 0.53, face: 0 },
        stand2: { ratio: 0.55, face: 0 },
      },
      roles: { reach: 'stand', build: 'stand2' },
    },
    {
      id: 'maine',
      name: t('Maine Coon', '缅因猫'),
      family: 'codex',
      height: 124,
      sprites: {
        sit: { ratio: 0.83, face: 0, scale: 0.72 },
        lie: { ratio: 0.65, face: -1 },
        stand: { ratio: 0.39, face: 0 },
        stand2: { ratio: 0.45, face: -1 },
      },
      roles: { walk: 'stand', build: 'stand', reach: 'stand2' },
    },
    {
      id: 'siamese',
      name: t('Siamese', '暹罗猫'),
      family: 'gemini',
      height: 114,
      sprites: {
        sit: { ratio: 0.64, face: 0, scale: 0.72 },
        walk: { ratio: 1.66, face: -1, scale: 0.56 },
        stand: { ratio: 0.46, face: 0 },
        stand2: { ratio: 0.41, face: -1 },
      },
      roles: { build: 'stand', reach: 'stand2' },
    },
  ];

  const STATUS = ['ripe', 'green', 'bud'];

  global.ClowderRoadmapTree = { roots, trunk, branches, crown, cats, STATUS, curatedAt: '2026-09-02' };
})(typeof window !== 'undefined' ? window : globalThis);
