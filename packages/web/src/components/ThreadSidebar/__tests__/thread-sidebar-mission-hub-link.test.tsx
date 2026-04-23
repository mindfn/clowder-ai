import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createThreadSidebarHarness,
  installThreadSidebarGlobals,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
  type ThreadSidebarHarness,
} from './thread-sidebar-test-helpers';

describe('ThreadSidebar mission-hub compact link', () => {
  let harness: ThreadSidebarHarness;

  beforeAll(() => {
    installThreadSidebarGlobals();
  });

  beforeEach(() => {
    resetThreadSidebarMocks();
    harness = createThreadSidebarHarness();
  });

  afterEach(() => {
    harness.cleanup();
  });

  afterAll(() => {
    resetThreadSidebarGlobals();
  });

  it('renders a compact Mission Hub link above the thread list', async () => {
    await harness.render();
    const link = harness.container.querySelector('[data-testid="sidebar-mission-hub"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain('Mission Hub');
  });
});
