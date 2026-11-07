/**
 * What the fixture plugins were asked to do, counted where the work would happen (redesign §10.5, §9.6).
 *
 * The three witnesses of "nothing was attempted" are the client's own record, the daemon's hit here, and the plugin
 * code that never started (`builds`). This module is the second and third. It is a module singleton on purpose: the
 * fixture halves import it by absolute path, and so does the test, so both see the same instance.
 */

export type FixtureId = 'alpha' | 'beta' | 'gamma' | 'delta';
export const FIXTURE_IDS: readonly FixtureId[] = ['alpha', 'beta', 'gamma', 'delta'];

export interface Hits {
  /** A route handler ran. */
  route: number;
  /** A socket was accepted and opened. */
  socket: number;
  /** An agent tool ran. */
  tool: number;
}

/** Plugin code that started: the daemon half built, the app half built, the CLI half built. */
export interface Builds {
  daemon: number;
  app: number;
  cli: number;
}

export const hits: Record<FixtureId, Hits> = {
  alpha: { route: 0, socket: 0, tool: 0 },
  beta: { route: 0, socket: 0, tool: 0 },
  gamma: { route: 0, socket: 0, tool: 0 },
  delta: { route: 0, socket: 0, tool: 0 },
};

export const builds: Record<FixtureId, Builds> = {
  alpha: { daemon: 0, app: 0, cli: 0 },
  beta: { daemon: 0, app: 0, cli: 0 },
  gamma: { daemon: 0, app: 0, cli: 0 },
  delta: { daemon: 0, app: 0, cli: 0 },
};

/** Total daemon-side work done for one fixture plugin. */
export const hitTotal = (id: FixtureId): number => hits[id].route + hits[id].socket + hits[id].tool;

/** Zeroes every counter. A test calls it before the act it is about to measure. */
export function resetCounters(): void {
  for (const id of FIXTURE_IDS) {
    Object.assign(hits[id], { route: 0, socket: 0, tool: 0 });
    Object.assign(builds[id], { daemon: 0, app: 0, cli: 0 });
  }
}
