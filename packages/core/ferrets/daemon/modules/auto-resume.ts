import type { DecideAnswer, Log, StatePort } from '@ferretry/kernel/contract';
import type { AutoResumeDecideInput, FerretId, FerretRecord } from '../../contract/index.ts';
import {
  AccountAutoResumeAvailability,
  BootExitRecorder,
  type BootExitFerrets,
  FerretBootExits,
  owedAutoResume,
  RegistryAutoResumeRoster,
  StateAutoResumeLedger,
  StateAutoResumeSummaryStore,
  StorageAutoResumeJournal,
} from '../adapters/session/auto-resume/index.ts';
import { autoResumeVerdict } from '../lib/ferrets/auto-resume.ts';
import type { AutoResumeSummary } from '../lib/protocol/auto-resume.ts';
import {
  AutoResumeService,
  type AutoResumeSettings,
  defaultAutoResumeSettings,
} from '../lib/session/auto-resume/index.ts';
import { exitedSessionTransition } from '../lib/session/health/exit.ts';

/** The job that records how each ferret's terminal fared across the restart and works the owed resumes off (W2-a). */
export const AUTO_RESUME_JOB = 'ferrets.auto-resume';

/** What the auto-resume stands on, each through its one owner. */
export interface AutoResumeDeps extends Omit<BootExitFerrets, 'list'> {
  readonly state: Pick<StatePort, 'read' | 'write' | 'remove'>;
  readonly records: () => readonly Pick<FerretRecord, 'id' | 'state' | 'handle'>[];
  readonly record: (ferret: FerretId) => FerretRecord | undefined;
  /** The kernel's decide walk on `auto-resume.decide` (bounded on the kernel clock), with who answered what. */
  readonly decide: (input: AutoResumeDecideInput) => Promise<DecideAnswer>;
  /**
   * The ordinary resume, through the same `FerretsService.resume` (start gate, Vault/Warden holds, launch) a person's
   * resume takes; `expect` is judged under the ferret's own queue. Rejects with the reason when it was refused.
   */
  readonly resume: (
    ferret: FerretId,
    message: string | undefined,
    expect: (record: FerretRecord) => boolean,
  ) => Promise<void>;
  /** The ferret's journal (history.jsonl), on its one append chain. */
  readonly history: (ferret: FerretId, type: string, data: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly clock: { now(): string; nowMs(): number };
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly log: Pick<Log, 'warn'>;
  readonly settings?: AutoResumeSettings;
}

export interface AutoResume {
  /** One pass: settle and record the boot exits, then work the ledger off. Answers what it did, if anything. */
  readonly run: () => Promise<AutoResumeSummary | undefined>;
  readonly summary: StateAutoResumeSummaryStore;
}

/** Thrown inside the availability port so the service skips the ferret with the verdict's reason. */
class NotResumable extends Error {}

/**
 * Today's `createAutoResume` (`fyd.ts:8388–8413`) plus its `BootExitRecorder` (`:8180`), over 5.0's owners: the ledger
 * and summary in Ferrets' state, the subject from the registry, the availability from Runtimes' OWN answer on
 * `auto-resume.decide` (RULING #27 Q5, fail closed), the revive through `FerretsService.resume`, the journal through
 * the history writer. Today recorded the boot exits before serving and ran the pass after; 5.0 does both in one job
 * after the daemon serves, in the same order, so a pass never starts before what it is owed is durable.
 */
export function buildAutoResume(deps: AutoResumeDeps): AutoResume {
  const summary = new StateAutoResumeSummaryStore(deps.state);
  const service = new AutoResumeService(
    {
      ledger: new StateAutoResumeLedger(deps.state),
      roster: new RegistryAutoResumeRoster(deps.record),
      // Today's availability rule (a record that names no runtime is not resumed), asking Runtimes about THIS ferret.
      availability: {
        unavailable: async id => {
          const record = deps.record(id as FerretId);
          return await new AccountAutoResumeAvailability(
            async () => record?.runtime,
            async runtime => {
              if (record === undefined) throw new NotResumable('its record is gone');
              const verdict = autoResumeVerdict(
                await deps.decide({ ask: 'runtime', ferret: record.id, harness: record.harness, runtime }),
              );
              if (!verdict.allow) throw new NotResumable(verdict.reason);
            },
          ).unavailable(id);
        },
      },
      resumer: {
        resume: async (id, message) => await deps.resume(id as FerretId, message, owedAutoResume),
      },
      journal: new StorageAutoResumeJournal({
        append: async (id, type, data) => await deps.history(id as unknown as FerretId, type, data),
      }),
      summary,
      // The machine's switch is Runtimes' (today's `machine.autoResume`): only its own yes turns the pass on.
      setting: { enabled: async () => autoResumeVerdict(await deps.decide({ ask: 'switch' })).allow },
      clock: deps.clock,
      sleep: deps.sleep,
    },
    deps.settings ?? defaultAutoResumeSettings,
  );
  return { run: async () => await runOnce(deps, service), summary };
}

async function runOnce(deps: AutoResumeDeps, service: AutoResumeService): Promise<AutoResumeSummary | undefined> {
  // The first look after boot: only a settle that LANDED in this pass is recorded, so a second boot finds the ferrets
  // this one resumed live (or still stopped, never `working`) and owes them nothing again.
  const exits = new BootExitRecorder(new FerretBootExits({ ...deps, list: deps.records }), deps.clock);
  for (const observation of await exits.observe([]).catch(() => [])) {
    const transition = exitedSessionTransition(observation);
    if (transition !== undefined) await exits.settle(observation, transition).catch(() => false);
  }
  // Written down BEFORE anything is attempted: the host can go down again mid-pass, and what is owed must survive it.
  await service
    .record(exits.close())
    .catch((error: unknown) =>
      deps.log.warn('the ferrets owed an auto-resume could not be recorded', { error: reasonOf(error) }),
    );
  return await service.run();
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
