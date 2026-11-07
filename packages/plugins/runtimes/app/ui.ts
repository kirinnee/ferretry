/** Shared browser primitives come from the app shell. */
export {
  Badge,
  Button,
  ContextMenu,
  CopyButton,
  type ClipboardWriter,
  browserClipboardWriter,
  cn,
  type MenuAnchor,
  useDialogFocus,
} from '@ferretry/app/ui';

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['finished', 'failed', 'stopped', 'archived']);
