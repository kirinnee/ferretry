import type { Log } from '@ferretry/kernel/contract';
import { jsonObject } from '@ferretry/std';
import type { FerretId, FerretRecord } from '../../contract/index.ts';
import type { DaemonStorage } from '../adapters/storage/session-storage.ts';
import type { SerialExecutor } from '../lib/ports.ts';
import { MOVE_INTENT_KEY, settleInterruptedMove } from '../lib/session/resume/unrevived-relaunch.ts';
import { type SessionId } from '../lib/session-id.ts';

/** The journal event a ferret's history says its interrupted move was put right with. */
const INTERRUPTED_MOVE_EVENT = 'session.move_reconciled';

/** What the pass stands on, each through its one owner. */
interface InterruptedMovesDeps {
  readonly storage: Pick<DaemonStorage, 'listSessions' | 'readConfig' | 'updateConfig'>;
  /** The ONE per-session queue every start, stop and resume takes (`SessionFiles.serial`). */
  readonly serial: Pick<SerialExecutor, 'run'>;
  /** The registry's record of a ferret: the runtime its pane was launched on is the truth the document is put back to. */
  readonly record: (ferret: FerretId) => Pick<FerretRecord, 'runtime'> | undefined;
  /** When this process booted: a move begun at or after it is this process's own, still in flight. */
  readonly bootedAtMs: number;
  /** The ferret's journal (history.jsonl), on its one append chain. */
  readonly history: (ferret: FerretId, type: string, data: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly log: Pick<Log, 'warn'>;
}

interface InterruptedMoves {
  /** One pass: every config.json a crash left naming a move's target while its ferret is on the source is put back. */
  readonly run: () => Promise<{ readonly rolledBack: readonly string[] }>;
}

/**
 * Settles the moves a crash cut in half.
 *
 * A move restamps config.json (the runtime, model, incarnation and move history) BEFORE it retargets the record
 * (ferret.json) and relaunches, and the two files cannot be written together. A crash between the two leaves config.json
 * naming the target while the record and the live pane are still on the source, and a later Restart keeps the stale
 * `agent`, so the runtime's own account is resolved from the wrong login.
 *
 * WHY AN INTENT AND NOT A DERIVATION: the record carries the runtime but not the model, the effort or the launch settings
 * the move restamped, so config.json cannot be rebuilt from it. The move therefore writes what it is about to overwrite
 * into config.json IN THE SAME WRITE as the restamp (`MOVE_INTENT_KEY`), which leaves no window to crash in, and this pass
 * reads it: the record still on the source puts config.json back to the source (the pane's truth), the record on the
 * target only drops the intent. A move that completed leaves its intent behind and is dropped here the same way.
 *
 * Each document is re-decided under the ferret's own queue and inside the write, so a move begun since the look is not
 * undone, and a ferret whose record cannot be read is left as it is.
 */
export function buildInterruptedMoves(deps: InterruptedMovesDeps): InterruptedMoves {
  return {
    run: async () => {
      const rolledBack: string[] = [];
      for (const indexed of deps.storage.listSessions()) {
        const id: SessionId = indexed.id;
        const ferret = id as unknown as FerretId;
        await deps.serial
          .run(id, async () => {
            const read = jsonObject(await deps.storage.readConfig(id));
            if (read === undefined || !(MOVE_INTENT_KEY in read)) return;
            const serving = deps.record(ferret)?.runtime;
            const said: { put?: { from: string; to: string } } = {};
            await deps.storage.updateConfig(id, current => {
              delete said.put;
              const document = jsonObject(current) ?? {};
              const verdict = settleInterruptedMove(document, serving, deps.bootedAtMs);
              if (verdict.kind === 'none') return current;
              if (verdict.kind === 'rolled_back') said.put = { from: verdict.from, to: verdict.to };
              return verdict.document;
            });
            const put = said.put;
            if (put === undefined) return;
            rolledBack.push(id);
            await deps
              .history(ferret, INTERRUPTED_MOVE_EVENT, {
                from: put.from,
                to: put.to,
                reason:
                  'a crash interrupted the move, so the session document was put back to the runtime its pane is on',
              })
              .catch(() => undefined);
          })
          .catch((error: unknown) =>
            deps.log.warn('an interrupted move could not be settled', {
              session: id,
              error: error instanceof Error ? error.name : 'unknown',
            }),
          );
      }
      if (rolledBack.length > 0)
        deps.log.warn('moves a crash interrupted were put back to the runtime their ferret is on', {
          ferrets: rolledBack.length,
        });
      return { rolledBack };
    },
  };
}
