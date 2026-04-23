'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface SkillEntry {
  name: string;
  category: string;
  trigger: string;
}

interface SkillsResponse {
  skills: SkillEntry[];
}

export function SkillPreviewPanel() {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/skills');
        if (cancelled) return;
        if (!res.ok) return;
        const data = (await res.json()) as SkillsResponse;
        setSkills(data.skills);
      } catch {
        /* skills list unavailable */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadContent = useCallback(async (name: string) => {
    setSelectedSkill(name);
    setContent(null);
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch(`/api/rules/skill/${encodeURIComponent(name)}`);
      if (!res.ok) {
        setError(res.status === 404 ? 'SKILL.md 不存在' : '加载失败');
        return;
      }
      const data = (await res.json()) as { content: string };
      setContent(data.content);
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  }, []);

  if (skills.length === 0) return null;

  return (
    <div>
      <h3 className="text-sm font-semibold text-cafe-black mb-1">Skill 内容预览</h3>
      <p className="text-xs text-cafe-muted mb-3">查看各 Skill 的定义文件（SKILL.md）</p>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {skills.map((skill) => (
          <button
            key={skill.name}
            onClick={() => loadContent(skill.name)}
            className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
              selectedSkill === skill.name
                ? 'bg-indigo-50 border-indigo-300 text-indigo-700 font-medium'
                : 'border-cafe-border text-cafe-secondary hover:bg-cafe-surface-elevated'
            }`}
          >
            {skill.name}
          </button>
        ))}
      </div>
      {selectedSkill && (
        <div className="rounded-lg border border-cafe-border overflow-hidden">
          <div className="px-4 py-2.5 bg-cafe-surface-elevated flex items-center justify-between">
            <p className="text-sm font-medium text-cafe-black">
              {selectedSkill}
              <span className="text-cafe-muted font-normal"> / SKILL.md</span>
            </p>
          </div>
          <div className="border-t border-cafe-border">
            {loading && <p className="p-4 text-xs text-cafe-muted">加载中...</p>}
            {error && <p className="p-4 text-xs text-red-500">{error}</p>}
            {content && (
              <pre className="p-4 text-xs leading-relaxed font-mono text-cafe-secondary overflow-x-auto max-h-[400px] overflow-y-auto bg-cafe-bg whitespace-pre-wrap">
                {content}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
