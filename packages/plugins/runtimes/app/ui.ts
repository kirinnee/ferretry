/**
 * THE ONE SEAM to the app shell's shared UI (NEEDS-APP-SHELL.txt). Every component in this half takes its
 * primitives from here and from nowhere else, so when the shell lands this file is the only line to point at it.
 * Names are today's PWA primitives (`shell/primitives.tsx`, `shell/context-menu.tsx`, `lib/class-names.ts`,
 * `hooks/use-dialog-focus.ts`, `shell/status-mark.tsx`, `onboarding/copy-button.tsx`), unchanged.
 */

export {
  Badge,
  browserClipboardWriter,
  Button,
  type ClipboardWriter,
  ContextMenu,
  CopyButton,
  cn,
  type MenuAnchor,
  TERMINAL_STATUSES,
  useDialogFocus,
} from '@ferretry/app/ui';
