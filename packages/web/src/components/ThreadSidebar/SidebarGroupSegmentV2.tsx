import type { ReactNode } from 'react';

/** Separate visual segments retain a continuous Group boundary even in the virtual list. */
export function SidebarGroupSegmentV2({
  segment,
  children,
}: {
  segment: 'start' | 'middle' | 'end' | 'only';
  children: ReactNode;
}) {
  const first = segment === 'start' || segment === 'only';
  const last = segment === 'end' || segment === 'only';
  return (
    <div
      data-sidebar-group-segment={segment}
      className={`relative mx-2 min-w-0 ${first ? 'pt-1' : ''} ${last ? 'pb-1' : ''}`}
    >
      <div
        className={`min-w-0 border-x [--sidebar-group-lift:35%] dark:[--sidebar-group-lift:3%] ${first ? 'rounded-t-[10px] border-t' : ''} ${last ? 'rounded-b-[10px] border-b' : ''}`}
        style={{
          background: 'color-mix(in srgb, white var(--sidebar-group-lift), var(--shell-frame))',
          borderColor: 'var(--shell-hairline)',
        }}
      >
        {children}
      </div>
    </div>
  );
}
