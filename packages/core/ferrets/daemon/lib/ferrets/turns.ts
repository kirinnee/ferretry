import type { FerretId, FerretPrompt, FerretState, FerretTurnAuthor, FerretTurns } from '../../../contract/index.ts';
import { queuedPayloadFile } from '../protocol/turn-handoff.ts';
import type { FerretsCore } from './core.ts';

/**
 * A ferret's turn documents, bound to that ferret (`FerretsApi.turns`). The same `mayTouch` rule as `harness`: a
 * ferret reads only its own and its helpers', so no agent reads another's turns. Unbound session files: none.
 */
export async function turns(
  { registry, ports, requireMayTouch }: FerretsCore,
  ferret: FerretId,
  caller?: FerretId,
): Promise<FerretTurns | undefined> {
  await ports.ready?.();
  if (registry.get(ferret) === undefined) return undefined;
  requireMayTouch(caller, ferret);
  const session = ports.session;
  const writeTurn = session?.writeTurn?.bind(session);
  const queued = session?.queued?.bind(session);
  const clearMarkers = session?.clearMarkers?.bind(session);
  return {
    list: async options => (await session?.turns?.(ferret, { strict: options?.strict === true })) ?? [],
    // Unbound session files: no member, so a caller that needs one answers its own "cannot write" (never an inline paste).
    ...(writeTurn === undefined
      ? {}
      : {
          write: async (request: { readonly document: string; readonly by?: FerretTurnAuthor }) =>
            await writeTurn(ferret, request.document, request.by),
        }),
    ...(queued === undefined
      ? {}
      : {
          writeQueued: async (sendId: string, payload: string) => {
            if (queuedPayloadFile(sendId) === undefined)
              throw new Error('a send id outside the queued-message grammar names no file');
            return await queued(ferret, payload, sendId);
          },
        }),
    ...(clearMarkers === undefined ? {} : { clearMarkers: async () => await clearMarkers(ferret) }),
  };
}

/**
 * What the ferret's pane is asking right now (`FerretsApi.prompt`), masked. The same `mayTouch` rule as `harness`.
 * `undefined` for a ferret this daemon does not know; `{}` when nothing is recorded or it could not be read.
 */
export async function prompt(
  { registry, ports, requireMayTouch }: FerretsCore,
  ferret: FerretId,
  caller?: FerretId,
): Promise<FerretPrompt | undefined> {
  await ports.ready?.();
  if (registry.get(ferret) === undefined) return undefined;
  requireMayTouch(caller, ferret);
  return (await ports.promptState?.(ferret).catch(() => undefined)) ?? {};
}

/**
 * The ferret's stored last screen (`FerretsApi.lastSnapshot`), masked again on this read. The same `mayTouch` rule as
 * `harness`, checked BEFORE the file is touched. `undefined` for a ferret this daemon does not know, with no stored
 * screen, or when it cannot be read or masked (fail closed: never the raw text).
 */
export async function lastSnapshot(
  { registry, ports, requireMayTouch }: FerretsCore,
  ferret: FerretId,
  caller?: FerretId,
): Promise<string | undefined> {
  await ports.ready?.();
  if (registry.get(ferret) === undefined) return undefined;
  requireMayTouch(caller, ferret);
  return await ports.storedLastSnapshot?.(ferret).catch(() => undefined);
}

/**
 * The turn watch recorded a turn change (U4): a `working` turn makes the ferret `working`, a `your-turn` or a
 * `needs-input` makes it `idle`, and `ferret.changed {change: 'state'}` follows the durable write (what
 * Conversation's `turn.ended` reads). Only a ferret that is already `working` or `idle` moves: a start's
 * `starting` is the start's to settle, and a stop has the last word. On the ferret's own lane, so it never races a
 * start, stop or resume; its handle stays as it was.
 */
export async function turnObserved(
  { registry, ports, serial, write }: FerretsCore,
  ferret: FerretId,
  turn: 'working' | 'your-turn' | 'needs-input',
): Promise<void> {
  await serial.run(ferret, async () => {
    const record = registry.get(ferret);
    if (record === undefined || (record.state !== 'working' && record.state !== 'idle')) return;
    const state: FerretState = turn === 'working' ? 'working' : 'idle';
    if (record.state === state) return;
    await write({ ...record, state, stateAt: ports.now() }, record.state, 'state');
  });
}
