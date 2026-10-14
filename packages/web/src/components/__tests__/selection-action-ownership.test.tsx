import { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type MessageActionOwnership,
  MessageActionOwnershipProvider,
  useMessageActionOwnership,
} from '../message-v2/message-action-ownership';
import { SelectionAnnotationAction } from '../SelectionAnnotationAction';
import {
  installReplyLayersActEnvironment,
  ReplyLayersHarness,
  uninstallReplyLayersActEnvironment,
} from './ChatMessage-reply-layers.harness';

describe('body selection uses readable message ownership rather than the author anchor', () => {
  let h: ReplyLayersHarness;
  let owner: MessageActionOwnership;
  const close = vi.fn();
  beforeAll(installReplyLayersActEnvironment);
  afterAll(uninstallReplyLayersActEnvironment);
  beforeEach(() => {
    h = new ReplyLayersHarness();
    close.mockClear();
    function OwnedSelection() {
      owner = useMessageActionOwnership('body-owner');
      return (
        <MessageActionOwnershipProvider value={owner}>
          <SelectionAnnotationAction
            selectedText="The visible answer remains readable."
            position={{ left: 150, top: 200 }}
            positionMode="fixed"
            actionTestId="owned-selection"
            onSave={vi.fn()}
            onClose={close}
          />
        </MessageActionOwnershipProvider>
      );
    }
    act(() => h.root.render(<OwnedSelection />));
    act(() => owner.settle(true, true));
  });
  afterEach(() => h.dispose());

  function openEditor() {
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="owned-selection"]');
    if (!trigger) throw new Error('Missing real selection trigger');
    act(() => trigger.click());
    const editor = document.querySelector<HTMLElement>('[data-testid="context-annotation-editor"]');
    if (!editor) throw new Error('Missing real selection editor');
    return editor;
  }

  it('gates pending paint, then preserves the editor when only the author anchor is unavailable', () => {
    const editor = openEditor();
    expect(editor.contains(document.activeElement)).toBe(true);
    act(() => owner.pending());
    expect(editor.hasAttribute('inert')).toBe(true);
    expect(editor.getAttribute('aria-hidden')).toBe('true');
    expect(editor.contains(document.activeElement)).toBe(false);
    act(() => owner.settle(true, false));
    expect(editor.isConnected).toBe(true);
    expect(editor.hasAttribute('data-message-action-unavailable')).toBe(false);
    expect(close).not.toHaveBeenCalled();
    const comment = editor.querySelector<HTMLTextAreaElement>('textarea');
    act(() => comment?.focus());
    expect(editor.contains(document.activeElement)).toBe(true);
  });

  it('retires the editor on message loss without retaining focus, and permits a fresh recovered selection', () => {
    const editor = openEditor();
    act(() => owner.settle(false, false));
    expect(editor.isConnected).toBe(false);
    expect(editor.contains(document.activeElement)).toBe(false);
    expect(close).toHaveBeenCalled();
    const trigger = document.querySelector<HTMLElement>('[data-testid="owned-selection"]');
    expect(trigger?.hasAttribute('inert')).toBe(true);
    act(() => owner.settle(true, false));
    const fresh = openEditor();
    expect(fresh.hasAttribute('inert')).toBe(false);
    expect(fresh.contains(document.activeElement)).toBe(true);
  });
});
