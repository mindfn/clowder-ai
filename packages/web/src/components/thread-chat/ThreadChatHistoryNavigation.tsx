import type { ComponentProps } from 'react';
import { MessageNavigator } from '../MessageNavigator';
import { ScrollToBottomButton } from '../ScrollToBottomButton';
import { useShellPresentation } from '../shell/shell-presentation';

/** Conversation controls disappear with the history presentation; message and reading owners stay mounted. */
export function ThreadChatHistoryNavigation({
  visible,
  bottomProps,
  navigatorProps,
}: {
  visible: boolean;
  bottomProps: ComponentProps<typeof ScrollToBottomButton>;
  navigatorProps: ComponentProps<typeof MessageNavigator>;
}) {
  const presentation = useShellPresentation();
  if (!visible) return null;
  return (
    <>
      {presentation === 'v2' ? (
        // Keep the reading viewport stable when the button appears or disappears.
        // Resizing it during a jump can move the source of an open annotation.
        <div className="flex min-h-[3.125rem] shrink-0 justify-end">
          <ScrollToBottomButton {...bottomProps} placement="flow" />
        </div>
      ) : (
        <ScrollToBottomButton {...bottomProps} />
      )}
      {(presentation === 'v2' || navigatorProps.messages.length > 5) && <MessageNavigator {...navigatorProps} />}
    </>
  );
}
