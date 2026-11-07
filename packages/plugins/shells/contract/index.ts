/**
 * @ferretry/plugin-shells/contract — wire schemas, port + token, events, state and config declarations, words.
 * Shells owns the `shell` item kind (§4.9): a locked flake reference or a package list on a pinned nixpkgs, built once
 * and cached by narHash.
 */
import { defineConfig, defineEvent, definePort, defineState, type Loosens, type Word } from '@ferretry/kernel/contract';
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { configDef } from './core.ts';
import {
  type NixFacts,
  NarHashSchema,
  ShellItemSchema,
  ShellLockSchema,
  ShellNameSchema,
  type ShellItem,
  type ShellLock,
  type ShellName,
  type ShellSummary,
} from './wire.ts';

export * from './wire.ts';

export const SHELLS_WORDS: readonly Word[] = [
  { word: 'shell', means: 'the set of tools a ferret works in (a nix shell)', insteadOf: ['devshell', 'env'] },
];

// ─── port ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What others (Runtimes, Projects, the app) may read. The shell a ferret enters is contributed through `launch.parts`. */
export interface ShellsApi {
  list(): Promise<readonly ShellSummary[]>;
  get(name: ShellName): Promise<{ readonly item: ShellItem; readonly lock: ShellLock | undefined } | undefined>;
  nix(): Promise<NixFacts>;
}
export const ShellsPort = definePort<ShellsApi>('shells');
export const SHELLS_READ_MODELS = ['list', 'get', 'nix'] as const;

// ─── events ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A shell was added, re-locked or removed (after its write). */
export const ShellsChanged = defineEvent('shells.changed', z.strictObject({ name: ShellNameSchema }));
/** A shell finished building. */
export const ShellBuilt = defineEvent(
  'shells.built',
  z.strictObject({ name: ShellNameSchema, narHash: NarHashSchema, builtAt: InstantSchema }),
);

// ─── state (§9.2) ────────────────────────────────────────────────────────────────────────────────────────────────

export const SHELLS_LOCKS = defineState({
  name: 'locks',
  path: 'locks/*.json',
  store: 'json',
  format: 1,
  schema: ShellLockSchema,
});

/** A built shell by narHash. Content-addressed, so a damaged entry is simply rebuilt. */
export const SHELLS_CACHE = defineState({ name: 'cache', path: 'cache/*', store: 'opaque', format: 1 });

// ─── config (§9.2, §7.2) ─────────────────────────────────────────────────────────────────────────────────────────

const describe = (item: ShellItem): string =>
  item.flake !== undefined ? item.flake : `packages ${(item.packages ?? []).join(', ')}`;

/**
 * A shell runs a nix build the next time a ferret starts in it, so a shell nobody had, a different source, or a
 * switch to `floating` is held for the owner (§3.2). New in 5.0: there is no rule of today's to copy.
 */
export const shellLoosens: Loosens<ShellItem> = (before, after) => {
  if (before === undefined) return [`a new shell will build ${describe(after)}`];
  const sentences: string[] = [];
  if (describe(before) !== describe(after)) sentences.push(`the shell now builds ${describe(after)}`);
  if (!before.floating && after.floating) sentences.push('the shell may now resolve to a different build each time');
  return sentences;
};

/** `config/shells/<name>.yaml`. */
export const SHELLS_CONFIG = configDef(
  defineConfig({
    collection: 'shells',
    name: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
    schema: ShellItemSchema,
    axis: 'configure',
    loosens: shellLoosens,
  }),
);

// ─── audit kinds this plugin records (Gate's log; `fleet.configured` with the action as detail) ──────────────────────

export const SHELLS_AUDIT = {
  add: 'fleet.configured:shell-add',
  relock: 'fleet.configured:shell-relock',
  build: 'fleet.configured:shell-build',
  remove: 'fleet.configured:shell-remove',
} as const;
