/**
 * F150: Guide Flow Definitions
 *
 * Phase A: hardcoded flows. Phase B will load from YAML.
 */
import type { GuideStep } from '@/stores/guideStore';

export interface GuideFlow {
  id: string;
  name: string;
  description: string;
  steps: GuideStep[];
}

export const ADD_MEMBER_FLOW: GuideFlow = {
  id: 'add-member',
  name: '添加成员',
  description: '引导你完成新成员的创建和配置',
  steps: [
    {
      id: 'open-hub',
      targetGuideId: 'hub.trigger',
      title: '打开 Hub',
      instruction: '点击这里打开 Hub 控制台',
      expectedAction: 'click',
    },
    {
      id: 'go-to-cats',
      targetGuideId: 'cats.overview',
      title: '进入成员总览',
      instruction: '点击「总览」查看所有成员',
      expectedAction: 'click',
    },
    {
      id: 'click-add-member',
      targetGuideId: 'cats.add-member',
      title: '添加成员',
      instruction: '点击「添加成员」开始创建',
      expectedAction: 'click',
    },
    {
      id: 'select-client',
      targetGuideId: 'add-member.client',
      title: '选择 Client',
      instruction: '选择要接入的 CLI 工具或 Agent 平台',
      expectedAction: 'select',
    },
    {
      id: 'select-provider',
      targetGuideId: 'add-member.provider-profile',
      title: '选择 Provider',
      instruction: '选择或配置 API 账号',
      expectedAction: 'select',
    },
    {
      id: 'select-model',
      targetGuideId: 'add-member.model',
      title: '选择模型',
      instruction: '选择默认使用的 AI 模型',
      expectedAction: 'select',
    },
    {
      id: 'confirm-create',
      targetGuideId: 'add-member.submit',
      title: '确认创建',
      instruction: '点击「创建后继续编辑」完成成员创建',
      expectedAction: 'click',
    },
    {
      id: 'complete',
      targetGuideId: 'add-member.submit',
      title: '创建完成',
      instruction: '成员创建成功！你可以继续编辑成员的详细配置。',
      expectedAction: 'confirm',
      canSkip: true,
    },
  ],
};

export const GUIDE_FLOWS: Record<string, GuideFlow> = {
  'add-member': ADD_MEMBER_FLOW,
};
