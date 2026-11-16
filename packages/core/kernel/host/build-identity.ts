import { randomUUID } from 'node:crypto';

/**
 * WHICH RUN OF THE DAEMON THIS IS, beyond its semver. Two builds can share a version yet build a projection
 * differently, and a conditional tag the app holds across such an upgrade must not be answered `304`.
 *
 * It is made ONCE, at boot, and held by the host: stable for every poll of one process (so the unchanged `304` keeps
 * saving), new on every restart, and an upgrade always restarts. It is read from no file and no clock, so it works
 * the same compiled, from source and in dev. `fixed` names it for a test or a caller that already holds one.
 */
export function bootBuild(version: string, fixed?: string): string {
  return `${version}+${fixed ?? randomUUID()}`;
}
