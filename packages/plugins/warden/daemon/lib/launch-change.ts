/**
 * Which `ferret.changed` payloads mean a ferret was LAUNCHED, so the liveness monitor starts its quiet clock again.
 *
 * Ferrets writes every launch the same way, whatever began it (a start, a resume, a revive, a restart or its queue, a
 * model switch, the lifecycle's own start): the record is written `starting` first (a fresh start also says
 * `started`), and `working` only once the pane is up. The one launch that never writes `starting` is an ATTACH — a
 * stopped ferret whose pane is adopted comes back `working` straight from `stopped` — so a ferret leaving `stopped`
 * is a launch too, however it got there.
 *
 * Pure: no IO, no clock.
 */

/** The part of a `ferret.changed` payload that says whether a launch happened. */
export interface FerretChangeFacts {
  readonly state: string;
  readonly previous?: string | undefined;
  readonly change?: string | undefined;
}

/** Whether this change is a ferret being launched: its quiet clock starts again at this instant. */
export function isLaunchChange(payload: FerretChangeFacts): boolean {
  return (
    payload.change === 'started' ||
    payload.state === 'starting' ||
    (payload.previous === 'stopped' && payload.state !== 'stopped')
  );
}
