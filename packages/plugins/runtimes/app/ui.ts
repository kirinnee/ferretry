/** Shared browser primitives come from the app shell. */
export {
  Badge,
  BottomSheet,
  Button,
  ContextMenu,
  CopyButton,
  type ClipboardWriter,
  browserClipboardWriter,
  cn,
  Textarea,
  type MenuAnchor,
  useDialogFocus,
  useNow,
} from '@ferretry/app/ui';

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['finished', 'failed', 'stopped', 'archived']);
