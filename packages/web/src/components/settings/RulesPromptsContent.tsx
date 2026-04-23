'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface RuleFile {
  path: string;
  content: string;
  exists: boolean;
}

interface ProviderGuide extends RuleFile {
  provider: string;
}

interface RulesData {
  sharedRules: RuleFile[];
  providerGuides: ProviderGuide[];
}

const PROVIDER_LABELS: Record<string, string> = {
  claude: '布偶猫 (Claude)',
  codex: '缅因猫 (Codex)',
  gemini: '暹罗猫 (Gemini)',
};

const FILE_LABELS: Record<string, string> = {
  'cat-cafe-skills/refs/shared-rules.md': '家规（三猫共用协作规则）',
  'docs/SOP.md': '运维 SOP',
};

export function RulesPromptsContent() {
  const [data, setData] = useState<RulesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/rules');
        if (cancelled) return;
        if (!res.ok) {
          setError('规则加载失败');
          return;
        }
        setData((await res.json()) as RulesData);
      } catch {
        if (!cancelled) setError('网络错误');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p className="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{error}</p>;
  if (!data) return <p className="text-sm text-cafe-muted">加载中...</p>;

  const toggle = (path: string) => setExpandedFile((prev) => (prev === path ? null : path));

  return (
    <div className="space-y-6">
      <Section title="共享规则" description="全部成员遵循的协作规则和流程规范，注入每只猫的系统提示词">
        {data.sharedRules.map((file) => (
          <RuleFileCard
            key={file.path}
            file={file}
            expanded={expandedFile === file.path}
            onToggle={() => toggle(file.path)}
          />
        ))}
      </Section>

      <Section title="模型指南" description="每只猫的角色定义和模型特定约束">
        {data.providerGuides.map((guide) => (
          <RuleFileCard
            key={guide.path}
            file={guide}
            label={PROVIDER_LABELS[guide.provider]}
            expanded={expandedFile === guide.path}
            onToggle={() => toggle(guide.path)}
          />
        ))}
      </Section>
    </div>
  );
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-cafe-black mb-1">{title}</h3>
      <p className="text-xs text-cafe-muted mb-3">{description}</p>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function RuleFileCard({
  file,
  label,
  expanded,
  onToggle,
}: {
  file: RuleFile;
  label?: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const displayLabel = label ?? FILE_LABELS[file.path] ?? file.path;

  if (!file.exists) {
    return (
      <div className="rounded-lg border border-cafe-border p-3">
        <p className="text-sm text-cafe-muted">{displayLabel}: 文件不存在</p>
      </div>
    );
  }

  const lineCount = file.content.split('\n').length;

  return (
    <div className="rounded-lg border border-cafe-border overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-cafe-surface-elevated transition-colors"
      >
        <div>
          <p className="text-sm font-medium text-cafe-black">{displayLabel}</p>
          <p className="text-xs text-cafe-muted mt-0.5">
            {file.path} · {lineCount} 行
          </p>
        </div>
        <svg
          className={`w-4 h-4 text-cafe-muted transition-transform flex-shrink-0 ${expanded ? 'rotate-180' : ''}`}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {expanded && (
        <div className="border-t border-cafe-border">
          <pre className="p-4 text-xs leading-relaxed font-mono text-cafe-secondary overflow-x-auto max-h-[500px] overflow-y-auto bg-cafe-bg whitespace-pre-wrap">
            {file.content}
          </pre>
        </div>
      )}
    </div>
  );
}
