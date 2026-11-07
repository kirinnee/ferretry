/** Shared browser primitives come from the app shell. */
export {
  Badge,
  ChangeApplyPanel,
  type ChangeAuthority,
  BottomSheet,
  Button,
  ContextMenu,
  CopyButton,
  type ClipboardWriter,
  browserClipboardWriter,
  cn,
  Textarea,
  type MenuAnchor,
  useChangeAuthority,
  useDialogFocus,
  useNow,
} from '@ferretry/app/ui';

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['finished', 'failed', 'stopped', 'archived']);
