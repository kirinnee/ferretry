/**
 * Escape, pressed in a field that nothing else claimed, goes back from the open agenda item to the chat.
 *
 * A key the field already used (an open completion list closing, Vim leaving insert mode) arrives with its
 * default prevented, and an input method's composing key is never ours: both leave the item open.
 */
export const escapeCloses =
  (onClose: () => void) =>
  (event: {
    readonly key: string;
    readonly defaultPrevented: boolean;
    readonly nativeEvent: { readonly isComposing?: boolean };
    preventDefault(): void;
  }): void => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing === true) return;
    event.preventDefault();
    onClose();
  };
