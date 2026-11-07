/**
 * THE ONE SEAM to the app shell's shared UI (NEEDS-APP-SHELL.txt). Every component in this half takes its
 * primitives from here and from nowhere else. A plugin half may not import the app package (`context-imports`),
 * and the shell offers a plugin half no primitives yet (GAP(app-shell)): until it does, these are placeholders that
 * say so when used. Names are today's PWA primitives, unchanged.
 */

type Primitive = (props: Record<string, unknown>) => unknown;

const missing =
  (name: string): Primitive =>
  () => {
    throw new Error(`The app shell does not provide ${name} to plugin halves yet.`);
  };

export const Badge: Primitive = missing('Badge');
export const Button: Primitive = missing('Button');
export const ContextMenu: Primitive = missing('ContextMenu');
export const CopyButton: Primitive = missing('CopyButton');
export const useDialogFocus = missing('useDialogFocus');

export interface MenuAnchor {
  readonly x: number;
  readonly y: number;
}

export type ClipboardWriter = (text: string) => Promise<boolean>;
export const browserClipboardWriter = (): ClipboardWriter => async () => false;

export const cn = (...parts: readonly (string | false | null | undefined)[]): string =>
  parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['finished', 'failed', 'stopped', 'archived']);
