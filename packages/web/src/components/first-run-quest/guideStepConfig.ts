import type { GuideStep } from './guideOverlayTypes';

export interface GuideStepConfigEntry {
  tip: string;
  targets: string[];
  arrow: 'left' | 'up' | 'none';
  hosts?: string[];
  nextStep: GuideStep | null;
}

export const GUIDE_STEP_CONFIG: Record<GuideStep, GuideStepConfigEntry> = {
  'preview-result': {
    tip: '看看猫猫做的效果！点击聊天中的链接打开预览',
    targets: [],
    arrow: 'none',
    nextStep: null,
  },
  'open-hub': {
    tip: '觉得有改进空间？点击 ⚙️ 设置，添加一只新猫猫来帮忙！',
    targets: ['hub-button'],
    arrow: 'left',
    nextStep: 'click-add-member',
  },
  'click-add-member': {
    tip: '点击「+ 添加成员」按钮，添加一位新的猫猫队友',
    targets: ['add-member-button'],
    arrow: 'up',
    hosts: ['hub-modal'],
    nextStep: 'fill-form',
  },
  'fill-form': {
    tip: '填写猫猫信息，选择客户端和模型，然后点击保存',
    targets: ['cat-editor'],
    arrow: 'none',
    hosts: ['hub-modal', 'cat-editor-modal'],
    nextStep: null,
  },
  done: {
    tip: '',
    targets: [],
    arrow: 'none',
    nextStep: null,
  },
  'return-to-chat': {
    tip: '关闭设置，回到聊天窗口试试和新队友互动！',
    targets: [],
    arrow: 'none',
    nextStep: null,
  },
  'mention-teammate': {
    tip: '在输入框输入 @ 加上新队友的名字，让 TA 来 review',
    targets: ['chat-input'],
    arrow: 'none',
    nextStep: null,
  },
};

export const PREVIOUS_GUIDE_STEP: Partial<Record<GuideStep, GuideStep>> = {
  'click-add-member': 'open-hub',
  'fill-form': 'click-add-member',
};

export function targetSelector(target: string) {
  return `[data-bootcamp-step="${target}"]`;
}

export function hostSelector(host: string) {
  return `[data-bootcamp-host="${host}"]`;
}

export function findGuideTarget(targets: string[]) {
  for (const target of targets) {
    const element = document.querySelector(targetSelector(target));
    if (element instanceof HTMLElement) return element;
  }
  return null;
}

export function hasAnyGuideTarget(targets: string[]) {
  return targets.some((target) => document.querySelector(targetSelector(target)));
}

export function matchesGuideTarget(element: Element, targets: string[]) {
  return targets.some((target) => element.closest(targetSelector(target)));
}
