'use client';

interface BootcampGuideOverlayProps {
  catName?: string;
  phase: string;
}

const PHASE_TIPS: Record<string, (catName: string) => string> = {
  'phase-1-intro': (cat) => `在下方输入框输入 @${cat} 你好  开始训练营`,
  'phase-2-env-check': (cat) => `${cat} 正在检查你的开发环境...`,
  'phase-3-config-help': (cat) => `跟着 ${cat} 的指引完成配置`,
};

/**
 * Full-screen overlay for bootcamp onboarding.
 * Covers everything (sidebar, header, status panel).
 * The ChatInput must be rendered with z-[70] to punch through.
 */
export function BootcampGuideOverlay({ catName, phase }: BootcampGuideOverlayProps) {
  const cat = catName ?? '猫猫';
  const tipFn = PHASE_TIPS[phase];
  if (!tipFn) return null;
  const tip = tipFn(cat);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col justify-end bg-black/30" style={{ pointerEvents: 'auto' }}>
      {/* Floating tip above input area */}
      <div className="pointer-events-none mx-auto mb-20 rounded-xl border border-amber-300 bg-amber-50 px-5 py-3 shadow-xl">
        <div className="flex items-center gap-2">
          <span className="text-lg">👇</span>
          <span className="text-sm font-medium text-amber-800">{tip}</span>
        </div>
      </div>
    </div>
  );
}
