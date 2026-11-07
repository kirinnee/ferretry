/**
 * THE ONE SEAM to the app shell's shared UI (NEEDS-APP-SHELL.txt). Every component in this half takes its primitives
 * from here and from nowhere else. A plugin half may not import the app package (`context-imports`), and the shell offers
 * a plugin half no primitives yet (GAP(app-shell)): until it does, these are placeholders that say so when used. Names
 * are today's PWA primitives, unchanged.
 */

type Primitive = (props: Record<string, unknown>) => unknown;

const missing =
  (name: string): Primitive =>
  () => {
    throw new Error(`The app shell does not provide ${name} to plugin halves yet.`);
  };

export type BadgeTone = 'ok' | 'warn' | 'err' | 'accent' | 'pend' | 'neutral';

export const Badge: Primitive = missing('Badge');
export const Button: Primitive = missing('Button');
export const RouteLink: Primitive = missing('RouteLink');
/** Markdown with the reference grammar proved (`:name`, `&card`, `@file`), as the chat draws it. */
export const Markdown: Primitive = missing('Markdown');
/** The proved-reference options a `Markdown` is given (`useReferenceSurface` in today's chat). */
export const useReferenceSurface = (): Record<string, unknown> => ({});
/** A peer's name as a proved `:name` reference. */
export const PeerName: Primitive = missing('PeerName');
/** The small time footer under a message. */
export const MessageFooter: Primitive = missing('MessageFooter');
/** The collapsed tool-call group of a transcript row. */
export const ToolGroup: Primitive = missing('ToolGroup');

export const cn = (...parts: readonly (string | false | null | undefined)[]): string =>
  parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');

/**
 * The shell's clock and timers (a plugin half reaches time only through the shell: `banned-globals`). `after` and `every`
 * return the function that cancels them.
 */
export interface ShellClock {
  now(): number;
  after(ms: number, run: () => void): () => void;
  every(ms: number, run: () => void): () => void;
}

const unavailableClock: ShellClock = {
  now: missing('the clock') as unknown as () => number,
  after: missing('timers') as unknown as ShellClock['after'],
  every: missing('timers') as unknown as ShellClock['every'],
};

export const useShellClock = (): ShellClock => unavailableClock;

import type { ConfigFiles } from './lib/pack-config.ts';

const unavailableFiles: ConfigFiles = {
  text: {
    read: missing('the configuration files') as unknown as ConfigFiles['text']['read'],
    edit: missing('the configuration files') as unknown as ConfigFiles['text']['edit'],
  },
  read: missing('the configuration files') as unknown as ConfigFiles['read'],
  write: missing('the configuration files') as unknown as ConfigFiles['write'],
};

/** The configuration-file routes and the YAML editor, as the shell's settings frame has them. */
export const useConfigFiles = (): ConfigFiles => unavailableFiles;
