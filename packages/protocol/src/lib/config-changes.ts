import { z } from 'zod';
import { NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';
import { type ConfigFileAddress, classifyConfigPath } from './config-files.ts';

/**
 * CONFIGURATION CHANGES, AS ONE LIVE FACT — what an open app is told when the machine's configuration
 * moved, so a screen that read it once is never left showing a login, a runtime or a setting that has
 * since changed (docs/config-files.md "Live changes").
 *
 * ONE OWNER. The daemon keeps one revision per boot and bumps it whenever anything a screen reads as
 * configuration changes — a configuration file (whoever wrote it: this app, another paired device,
 * `fy`, an agent, or a hand edit the watcher found), a login's state, a speed-up. Each bump names the
 * KINDS that moved, so a reader refetches only what it shows.
 *
 * THE STREAM IS `/v1/events?topic=config`. It replays nothing: its first frame is the revision in
 * effect, which is how a reader that was disconnected learns it missed something — the revision moved
 * — without the daemon keeping a history of changes nobody needs.
 *
 * A REVISION IS PER BOOT. `epoch` names the boot that counts it, so a restarted daemon's revision `3`
 * is never mistaken for the previous boot's `3`.
 */

/** Every kind of configuration a screen can show, as the change frame names it. */
export const CONFIG_CHANGE_KINDS = [
  /** The files themselves: the list, a file's text, what is broken and what waits for confirmation. */
  'files',
  /** `machine.yaml`: agent permissions, the default runtime, What agents may control. */
  'machine',
  /** Logins: their files, and their state — signed in, refresh due, checked. */
  'credentials',
  'components',
  'profiles',
  'runtimes',
  /** Speed-ups: which providers are ready, the tools installed. */
  'speedups',
  'warden',
  'learning',
  'voice',
  'presets',
  /** `pack.yaml` and `models-guide.yaml`: Pack mode's settings and its routing prompt. */
  'pack',
] as const;
export const ConfigChangeKindSchema = z.enum(CONFIG_CHANGE_KINDS);
export type ConfigChangeKind = z.infer<typeof ConfigChangeKindSchema>;

/** The query a reader asks `/v1/events` for this stream with: `?topic=config`. */
export const CONFIG_CHANGE_TOPIC = 'config' as const;

/**
 * What a file of each kind can change on screen. A login is part of every runtime that uses it; a
 * component is part of every profile and runtime that layers it; a profile of every runtime on it.
 */
const KINDS_BY_FILE: Readonly<Record<ConfigFileAddress['kind'], readonly ConfigChangeKind[]>> = {
  machine: ['machine', 'runtimes'],
  login: ['credentials', 'runtimes'],
  component: ['components', 'profiles', 'runtimes'],
  profile: ['profiles', 'runtimes'],
  runtime: ['runtimes'],
  warden: ['warden'],
  learning: ['learning'],
  voice: ['voice'],
  pack: ['pack'],
  modelsGuide: ['pack'],
  preset: ['presets', 'credentials'],
  models: ['runtimes', 'pack'],
};

/**
 * The kinds a change to these files moved: always `files`, and whatever each file's kind feeds. A
 * path that is not a configuration file still moved the file list, so it still answers `files`.
 */
export function configChangeKindsForPaths(paths: Iterable<string>): readonly ConfigChangeKind[] {
  const kinds = new Set<ConfigChangeKind>(['files']);
  for (const path of paths) {
    const address = classifyConfigPath(path);
    if (address !== undefined) for (const kind of KINDS_BY_FILE[address.kind]) kinds.add(kind);
  }
  return CONFIG_CHANGE_KINDS.filter(kind => kinds.has(kind));
}

/** One boot's revision: who counts it, and how far it has counted. */
export const ConfigRevisionSchema = z.strictObject({
  /** The boot that counts this revision; a new boot is a new epoch. */
  epoch: z.string().min(1).max(64),
  /** Moves forward on every change in this epoch; `0` before the first. */
  revision: NonNegativeIntegerSchema,
});
export type ConfigRevision = z.infer<typeof ConfigRevisionSchema>;

/**
 * One frame on the configuration stream.
 *
 * `config` carries a revision and what moved to reach it. The first frame of every connection names no
 * kinds: it says where the revision stands, and a reader compares it with the last one it saw. `idle`
 * is the same keep-alive proof the session stream sends, so a reader can tell quiet from broken.
 */
export const ConfigChangeFrameSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...ConfigRevisionSchema.shape,
    kind: z.literal('config'),
    kinds: z.array(ConfigChangeKindSchema).max(CONFIG_CHANGE_KINDS.length),
  }),
  z.strictObject({ ...ConfigRevisionSchema.shape, kind: z.literal('idle'), idleSeconds: PositiveIntegerSchema }),
]);
export type ConfigChangeFrame = z.infer<typeof ConfigChangeFrameSchema>;
