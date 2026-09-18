'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { HubIcon } from '../hub-icons';

const DESTINATIONS = [
  {
    id: 'memory',
    label: '记忆中心',
    description: '浏览 Knowledge Feed、搜索、图谱与记忆健康。',
    icon: 'brain',
    route: '/memory',
  },
  {
    id: 'signals',
    label: '信号',
    description: '查看订阅来源、文章和研究时间线。',
    icon: 'megaphone',
    route: '/signals',
  },
  {
    id: 'mission-hub',
    label: 'Mission Hub',
    description: '查看 Feature、依赖关系与任务推进状态。',
    icon: 'target',
    route: '/mission-hub',
  },
] as const;

export function FeatureDestinationsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get('from');

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {DESTINATIONS.map((destination) => (
        <button
          key={destination.id}
          type="button"
          onClick={() => {
            const suffix = from ? `?from=${encodeURIComponent(from)}` : '';
            router.push(`${destination.route}${suffix}`);
          }}
          data-testid={`settings-destination-${destination.id}`}
          className="group flex min-h-24 items-center gap-3 rounded-xl bg-[var(--console-card-bg)] px-4 py-3 text-left shadow-[var(--console-shadow-soft)] transition hover:-translate-y-px hover:bg-[var(--console-hover-bg)]"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cafe-accent/10 text-cafe-accent">
            <HubIcon name={destination.icon} className="h-5 w-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-compact font-bold text-cafe">{destination.label}</span>
            <span className="mt-0.5 block text-xs leading-5 text-cafe-secondary">{destination.description}</span>
          </span>
          <HubIcon
            name="external-link"
            className="h-4 w-4 shrink-0 text-cafe-muted transition-colors group-hover:text-cafe-accent"
          />
        </button>
      ))}
    </div>
  );
}
