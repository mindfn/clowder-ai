'use client';
import { useShellCopy } from '../shell/shell-copy';
import type { HubCatEditorController } from '../useHubCatEditor';
import { MemberSaveFeedback } from './MemberSaveFeedback';
import { memberSaveCopy } from './member-save.shell-copy';

/** The action area belongs to the editor's scroll host, so it moves and hides with that editor. */
export function MemberSaveBar({
  editor,
  creating,
  onSave,
}: {
  editor: HubCatEditorController;
  creating: boolean;
  onSave: () => void;
}) {
  const copy = useShellCopy(memberSaveCopy);
  return (
    <section className="members-v2 member-save-bar" aria-label={copy.region}>
      <MemberSaveFeedback editor={editor} creating={creating} onSave={onSave} />
    </section>
  );
}
