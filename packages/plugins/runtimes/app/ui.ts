/** Shared browser primitives come from the app shell. */
export {
  Badge,
  BottomSheet,
  Button,
  ContextMenu,
  cn,
  Textarea,
  type MenuAnchor,
  useDialogFocus,
  useNow,
} from '@ferretry/app/ui';

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['finished', 'failed', 'stopped', 'archived']);
