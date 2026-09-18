import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeatureDestinationsContent } from '../FeatureDestinationsContent';
import { SETTINGS_SECTIONS } from '../settings-nav-config';

const mocks = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(),
}));

describe('F190 Settings feature destinations', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.push.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('places the converged destinations inside Settings', () => {
    expect(SETTINGS_SECTIONS.find((section) => section.id === 'destinations')?.label).toBe('功能入口');
  });

  it.each([
    ['memory', '/memory'],
    ['signals', '/signals'],
    ['mission-hub', '/mission-hub'],
  ])('opens %s from Settings', (id, route) => {
    act(() => root.render(<FeatureDestinationsContent />));

    act(() => {
      container.querySelector<HTMLButtonElement>(`[data-testid="settings-destination-${id}"]`)?.click();
    });

    expect(mocks.push).toHaveBeenCalledWith(route);
  });
});
