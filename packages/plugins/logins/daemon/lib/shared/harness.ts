import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import { z } from 'zod';

/**
 * Which harness a login signs in, as the code reasons about it: `claude` or `codex`. These are also the keys of the
 * `claude:` / `codex:` halves of a login, a preset and a model catalog, which stay in those data files. The harness
 * PLUGIN keys (`claude-code`, `codex`) are what the wire and `logins/<id>.yaml` carry, and {@link harnessKey} /
 * {@link harnessKind} convert at exactly that boundary.
 */
export const HarnessKindSchema = z.enum(['claude', 'codex']);
export type HarnessKind = z.infer<typeof HarnessKindSchema>;

/** The harness plugin's key for a kind. */
export const harnessKey = (kind: HarnessKind): HarnessKey => (kind === 'claude' ? 'claude-code' : 'codex');

/** The kind a harness plugin's key names. */
export const harnessKind = (key: HarnessKey): HarnessKind => (key === 'claude-code' ? 'claude' : 'codex');
