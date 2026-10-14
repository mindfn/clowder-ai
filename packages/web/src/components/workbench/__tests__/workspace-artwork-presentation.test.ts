import { expect, it } from 'vitest';
import { createArtifactWorkPresentationState, isWorkspaceFullWindowSurface } from '../artifact-work-presentation';
import { createFileSurface, createWorkspaceModeSurface } from '../real-surface-adapters';
import { createInitialWorkbenchState } from '../workbench-initial-state';
import { projectWorkspaceWorkHost } from '../workspace-work-host-projection';

it.each([
  'cover.png',
  'clip.mp4',
  'notes.md',
  'notes.txt',
  'notes.docx',
])('v2 %s uses the existing artwork split and fullscreen controller', (path) => {
  const file = createFileSurface({ worktreeId: 'wt-a', path });
  expect(isWorkspaceFullWindowSurface(file, 'v2')).toBe(true);
  const projected = projectWorkspaceWorkHost(
    {
      threadId: 'thread-a',
      viewMode: 'single',
      isDesktop: true,
      statusPanelOpen: true,
      rightPanelMode: 'workspace',
      shellPresentation: 'v2',
    },
    createInitialWorkbenchState([file]),
    createArtifactWorkPresentationState(),
  );
  expect(projected.hostEligible).toBe(true);
  expect(projected.splitPreferenceActive).toBe(true);
  expect(isWorkspaceFullWindowSurface(file, 'classic')).toBe(false);
});

it('code files and malformed file identities keep the ordinary viewer geometry', () => {
  const code = createFileSurface({ worktreeId: 'wt-a', path: 'source.ts' });
  expect(isWorkspaceFullWindowSurface(code, 'v2')).toBe(false);
  const invalid = {
    ...createFileSurface({ worktreeId: 'wt-a', path: 'cover.png' }),
    ownerStateRef: { owner: 'other-owner', key: 'wt-a' },
  };
  expect(isWorkspaceFullWindowSurface(invalid, 'v2')).toBe(false);
});

it('projects the explicit Schedule wide session beside visible Chat and suppresses only its sidebar projection', () => {
  const schedule = createWorkspaceModeSurface('product-schedule', 'thread-a');
  const layout = createInitialWorkbenchState([schedule]);
  const input: Parameters<typeof projectWorkspaceWorkHost>[0] = {
    threadId: 'thread-a',
    viewMode: 'single',
    isDesktop: true,
    statusPanelOpen: true,
    rightPanelMode: 'workspace',
    shellPresentation: 'v2',
  };
  const attention = {
    surfaceId: schedule.id,
    presentation: { kind: 'chat-workspace' as const, threadId: 'thread-a', chatBasis: 30 },
  };
  const project = (patch: Partial<typeof input> = {}) =>
    projectWorkspaceWorkHost({ ...input, ...patch }, layout, createArtifactWorkPresentationState(), attention);
  expect(project().workspaceWideActive).toBe(true);
  expect(project().suppressCafeSidebar).toBe(true);
  expect(project().fullWindowActive).toBe(false);
  for (const patch of [
    { threadId: 'thread-b' },
    { isDesktop: false },
    { statusPanelOpen: false },
    { viewMode: 'split' as const },
    { rightPanelMode: 'status' as const },
  ]) {
    expect(project(patch).workspaceWideActive).toBe(false);
    expect(project(patch).suppressCafeSidebar).toBe(false);
  }
  expect(projectWorkspaceWorkHost(input, layout, createArtifactWorkPresentationState()).workspaceWideActive).toBe(
    false,
  );
});
