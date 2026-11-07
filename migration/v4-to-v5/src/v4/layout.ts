/**
 * The v4 (4.291.x) home layout, as this tool reads it. A LOCAL copy on purpose: the product has no v4 reader and
 * never will, so these names exist here and nowhere in `packages/`. Source of truth is today's code at
 * `bb89d054d` (`packages/daemon/src/lib/paths.ts`, `packages/protocol/src/lib/state-home-layout.ts`); the full
 * inventory is `docs/migration/v4-formats.md`.
 */
import { join } from 'node:path';

/** `packages/protocol/src/lib/state-home-layout.ts` `CURRENT_LAYOUT_VERSION` at 4.291.5. */
export const V4_LAYOUT_VERSION = 2;
/** The marker file at the v4 home root; its content is `"2\n"`. */
export const V4_LAYOUT_FILE = 'layout-version';

export interface V4Paths {
  readonly home: string;
  readonly layoutVersion: string;
  readonly daemonLock: string;
  readonly config: string;
  readonly fleet: string;
  readonly state: string;
  readonly sessions: string;
  readonly archivedSessions: string;
  readonly daemonIdentity: string;
}

export function v4Paths(home: string): V4Paths {
  const state = join(home, 'state');
  return {
    home,
    layoutVersion: join(home, V4_LAYOUT_FILE),
    daemonLock: join(home, 'daemon.lock'),
    config: join(home, 'config'),
    fleet: join(home, 'fleet'),
    state,
    sessions: join(state, 'sessions'),
    archivedSessions: join(state, 'archived-sessions.json'),
    daemonIdentity: join(state, 'daemon-identity.json'),
  };
}
