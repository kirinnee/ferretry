/**
 * Applies ONE `setup.import` through the ordinary change path (preview, passkey where the machine asks, apply) and answers in
 * the daemon's own sentences: what each owner wrote or refused. A plugin's last import page calls it once per harness.
 */
import { type DeadlineSchedule, MachineDeadlineError, realSchedule, withDeadline } from '@ferretry/app';
import { useCallback, useState } from 'react';
import type { AccountChange } from '../../../contract/index.ts';
import type { RuntimesClient } from '../../lib/client.ts';
import { type AccountChanges, useAccountChanges } from '../fleet/shell/apply-change-panel.tsx';
import { type ChangeRecovery, type ChangeResult, readChangeRecovery } from '../fleet/shell/apply-change.ts';
import { resultSentences } from './model.ts';

/** The daemon's own words for an import that has nothing it does not already hold. */
const NOTHING_NEW = /nothing new to import/iu;

/** How an apply ended. A refusal is told through `changes.refusal` and answers `null`. */
export interface ImportApplied {
  readonly kind: 'imported' | 'already-in';
  readonly sentences: readonly string[];
}

/**
 * An import that stopped part-way: what landed on this machine and what did not, in the daemon's own words (names only).
 * The page draws both lists beside the refusal, so the person is never left to guess what the machine holds.
 */
export interface ImportPartial {
  /** The tool it was for, as the page names it. */
  readonly label: string;
  readonly landed: readonly string[];
  readonly notLanded: readonly string[];
}

export interface ApplyImport {
  readonly changes: AccountChanges;
  readonly applied: ImportApplied | null;
  /** The last import's landed / not-landed lists, when it stopped part-way; `null` otherwise. */
  readonly partial: ImportPartial | null;
  readonly apply: (change: AccountChange, label: string) => Promise<ImportApplied | null>;
}

/**
 * How long a page waits for the import to answer (C59 O5-10). An import on a real machine lands in a second or two; one
 * that has not answered in this long is stuck (an apply that never settled, a carrier that lost the answer), and the
 * page says so instead of spinning for good. Long enough for a slow disk and a cold relay dial.
 */
export const IMPORT_DEADLINE_MS = 90_000;

/** The page stopped waiting: what failed, that it may still land, and what the Try again press does. */
const importTimedOutSentence = (label: string, deadlineMs: number = IMPORT_DEADLINE_MS): string =>
  `The ${label} import did not answer within ${String(Math.round(deadlineMs / 1000))} s, so this page stopped waiting. It may still finish on this machine. Press Try again: anything already brought over is not imported twice.`;

/** After the page stopped waiting, what the machine said when it was asked once what became of the import. */
const timedOutThen = (label: string, deadlineMs: number, recovery: ChangeRecovery['kind']): string => {
  const waited = `The ${label} import did not answer within ${String(Math.round(deadlineMs / 1000))} s, so this page stopped waiting.`;
  switch (recovery) {
    case 'partial':
      return `${waited} Part of it did land on this machine, as listed here. Press Try again to bring in the rest: anything already brought over is not imported twice.`;
    case 'applying':
      return `${waited} This machine is still finishing it. Wait a moment, then press Try again: anything already brought over is not imported twice.`;
    case 'not-applied':
      return `${waited} Nothing was written on this machine. Press Try again.`;
    default:
      return importTimedOutSentence(label, deadlineMs);
  }
};

/** The time the one recovery read of a timed-out import may take before the page says what it knows instead. */
const RECOVERY_DEADLINE_MS = 15_000;

/** The sentence an import that finished while the page was not looking is shown with: the daemon's own summary was lost with the answer. */
const FINISHED_WHILE_AWAY = 'The import finished on this machine.';

/**
 * The refusal code of a machine that wants its unlock (Gate's `UNLOCK_REQUIRED_CODE`). Matched by value: Runtimes'
 * app half does not consume Gate's contract, and the shell's client hands the daemon's code over as it came.
 */
const UNLOCK_REQUIRED_CODE = 'unlock_required';

/** The machine wants its unlock and the passkey prompt was not answered: say so, and Try again asks for it again. */
export const IMPORT_UNLOCK_SENTENCE =
  'This machine is locked, so nothing was imported. Press Try again and confirm with your passkey when it asks.';

export interface ApplyImportOptions {
  /** Defaults to {@link IMPORT_DEADLINE_MS}. */
  readonly deadlineMs?: number;
  /** Test seam: the timer the deadline runs on. */
  readonly schedule?: DeadlineSchedule;
}

export function useApplyImport(client: RuntimesClient, options: ApplyImportOptions = {}): ApplyImport {
  const changes = useAccountChanges({ client });
  const [applied, setApplied] = useState<ImportApplied | null>(null);
  const [partial, setPartial] = useState<ImportPartial | null>(null);
  const deadlineMs = options.deadlineMs ?? IMPORT_DEADLINE_MS;
  const schedule = options.schedule;
  const apply = useCallback(
    async (change: AccountChange, label: string): Promise<ImportApplied | null> => {
      // One controller per attempt: the deadline aborts THIS attempt's requests (a stage that answers after the abort
      // never sends its apply), and `abandon` makes its late answer unable to touch the screen or the next attempt.
      const attempt = new AbortController();
      // The id of the change this attempt staged: kept, so a timeout can still ask the machine what became of it.
      let stagedId: string | undefined;
      let result: ChangeResult;
      setPartial(null);
      try {
        result = await withDeadline(
          changes.apply(change, {
            signal: attempt.signal,
            onStaged: id => {
              stagedId = id;
            },
          }),
          deadlineMs,
          schedule ?? realSchedule,
        );
      } catch (error) {
        // `changes.apply` never throws (a failure is a refusal), so the deadline is the only way here.
        attempt.abort();
        changes.abandon();
        if (!(error instanceof MachineDeadlineError)) {
          changes.refuse(String(error));
          return null;
        }
        // Nothing was staged yet: nothing can have landed. Otherwise ask ONCE what became of the change.
        const recovery =
          stagedId === undefined
            ? ({ kind: 'unknown' } as const)
            : await withDeadline(
                readChangeRecovery(client, stagedId),
                RECOVERY_DEADLINE_MS,
                schedule ?? realSchedule,
              ).catch((): ChangeRecovery => ({ kind: 'unknown' }));
        if (recovery.kind === 'applied') {
          const finished: ImportApplied = { kind: 'imported', sentences: [FINISHED_WHILE_AWAY] };
          setApplied(finished);
          return finished;
        }
        if (recovery.kind === 'partial') setPartial({ label, landed: recovery.landed, notLanded: recovery.notLanded });
        changes.refuse(timedOutThen(label, deadlineMs, recovery.kind));
        return null;
      }
      if (result.kind === 'refused' && result.partly !== undefined) setPartial({ label, ...result.partly });
      if (result.kind === 'refused' && result.code === UNLOCK_REQUIRED_CODE) {
        changes.refuse(IMPORT_UNLOCK_SENTENCE);
        return null;
      }
      // "Nothing new" is not a failure to show: the tool is set up as it was.
      const alreadyIn = result.kind === 'refused' && NOTHING_NEW.test(result.sentence);
      if (result.kind !== 'applied' && !alreadyIn) return null;
      if (alreadyIn) changes.clear();
      const summary =
        result.kind === 'applied' && result.outcome.outcome === 'executed'
          ? result.outcome.summary
          : alreadyIn
            ? `Nothing new to bring in from ${label}: it is already set up.`
            : 'Imported.';
      const done: ImportApplied = { kind: alreadyIn ? 'already-in' : 'imported', sentences: resultSentences(summary) };
      setApplied(done);
      return done;
    },
    [changes, client, deadlineMs, schedule],
  );
  return { changes, applied, partial, apply };
}
