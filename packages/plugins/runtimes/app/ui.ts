/** Shared browser primitives come from the app shell. */
export {
  ActionRow,
  Badge,
  BottomSheet,
  Button,
  ContextMenu,
  SelectBox,
  cn,
  Textarea,
  type MenuAnchor,
  useDialogFocus,
  useNow,
} from '@ferretry/app/ui';

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['finished', 'failed', 'stopped', 'archived']);
