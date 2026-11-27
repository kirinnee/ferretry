import type { DecideAnswer, Log, StatePort } from '@ferretry/kernel/contract';
import type { AutoResumeDecideInput, FerretId, FerretRecord } from '../../contract/index.ts';
import {
  AccountAutoResumeAvailability,
  BootExitRecorder,
  bootClaim,
  bootExitTransition,
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
  type AutoResumeCandidate,
  AutoResumeService,
  type AutoResumeSettings,
  defaultAutoResumeSettings,
} from '../lib/session/auto-resume/index.ts';
import type { BootPassGate } from '../lib/session/auto-resume/boot-gate.ts';

/** The job that records how each ferret's terminal fared across the restart and works the owed resumes off (W2-a). */
export const AUTO_RESUME_JOB = 'ferrets.auto-resume';

/**
 * How long the pass waits before asking Runtimes again when its answer did not come (a hang past the kernel's bound, a
 * throw, garbage): at boot Runtimes may still be waking, so a lost answer is "not yet", not "no". Two more asks, then the
 * pass gives up exactly as it always did (fail closed, the ferret skipped with why). Runtimes' OWN no is never asked again.
 */
const UNANSWERED_RETRY_DELAYS_MS: readonly number[] = [3_000, 9_000];

/** Whether the walk ended on a taker that gave no answer of its own (not a no it said): the only case worth asking again. */
function lostAnswer(answer: DecideAnswer): boolean {
  return answer.decision.allow === false && answer.answers.at(-1)?.outcome === 'unanswered';
}

/** What the auto-resume stands on, each through its one owner. */
export interface AutoResumeDeps extends Omit<BootExitFerrets, 'list'> {
  readonly state: Pick<StatePort, 'read' | 'write' | 'remove'>;
  readonly records: () => readonly Pick<FerretRecord, 'id' | 'state' | 'handle' | 'cause' | 'stateAt'>[];
  /**
   * When this daemon started. A ferret the 30 s sweep or the first look of the turn watch settled `terminal_gone` AFTER
   * this and before the pass looked was just as much a ferret the host restart took down: the pass finds it already
   * stopped, and resumes it all the same. Absent: only what the pass itself settles is owed (no earlier ordering).
   */
  readonly bootedAt?: string;
  readonly record: (ferret: FerretId) => FerretRecord | undefined;
  /**
   * What a sweep-first settle said the ferret was doing (the `from` of its latest `session.exited` journal event), or
   * `undefined` when the journal names none. The settle leaves the registry saying `stopped` and the document saying
   * what it said, so only the journal still knows an idle ferret from a mid-turn one. Absent: the document's status.
   */
  readonly exitedFrom?: (ferret: FerretId) => Promise<string | undefined>;
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
  /** Released the moment the pass has closed its recorder: the turn watch's observers settle nothing before it. */
  readonly bootPass?: Pick<BootPassGate, 'release'>;
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
export function buildAutoResume(rawDeps: AutoResumeDeps): AutoResume {
  const deps: AutoResumeDeps = {
    ...rawDeps,
    decide: async input => {
      let answer = await rawDeps.decide(input);
      for (const delay of UNANSWERED_RETRY_DELAYS_MS) {
        if (!lostAnswer(answer)) break;
        await rawDeps.sleep(delay);
        answer = await rawDeps.decide(input);
      }
      return answer;
    },
  };
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
  const exits = new BootExitRecorder(
    new FerretBootExits({ ...deps, list: deps.records }, () => deps.clock.nowMs()),
    deps.clock,
  );
  for (const observation of await exits.observe([]).catch(() => [])) {
    const transition = bootExitTransition(observation);
    if (transition !== undefined) await exits.settle(observation, transition).catch(() => false);
  }
  // Written down BEFORE anything is attempted: the host can go down again mid-pass, and what is owed must survive it.
  const settledNow = closeRecorder(deps, exits);
  await service
    .record([...settledNow, ...(await settledBeforePass(deps, settledNow))])
    .catch((error: unknown) =>
      deps.log.warn('the ferrets owed an auto-resume could not be recorded', { error: reasonOf(error) }),
    );
  return await service.run();
}

/**
 * The ferrets the sweep or the turn watch's first look settled `terminal_gone` between this daemon's start and this pass:
 * the pass lost the race to settle them, not the right to resume them. Only a settle of THIS process counts (a ferret
 * stopped `terminal_gone` on an earlier boot was recorded, or deliberately not, by that boot's pass).
 *
 * The boot pass gate keeps the observers quiet until the recorder is closed, so this normally finds nothing: it is the
 * backstop for any settle that slips through.
 *
 * It is owed only what the boot pass owes, and the document is read the same way (`bootClaim`, after a settle): a
 * ferret it says `completed`, `failed` or `stalled` (the registry still said working when the pane was lost), or still
 * at a limit that has not reset, is left alone. What it was told it was doing is the `from` of the settle's own journal event, so an
 * idle ferret is not given the mid-turn notice; with no such event it is the document's status.
 */
async function settledBeforePass(
  deps: AutoResumeDeps,
  already: readonly AutoResumeCandidate[],
): Promise<readonly AutoResumeCandidate[]> {
  const bootedAt = deps.bootedAt === undefined ? undefined : Date.parse(deps.bootedAt);
  if (bootedAt === undefined || !Number.isFinite(bootedAt)) return [];
  const taken = new Set(already.map(candidate => candidate.id));
  const found: AutoResumeCandidate[] = [];
  for (const record of deps.records()) {
    const settledAt = Date.parse(record.stateAt);
    if (
      record.state !== 'stopped' ||
      record.cause?.kind !== 'terminal_gone' ||
      !Number.isFinite(settledAt) ||
      settledAt <= bootedAt ||
      taken.has(record.id)
    )
      continue;
    const status = await bootClaim(deps, record.id, deps.clock.nowMs(), true);
    if (status === undefined) continue;
    const from = await deps.exitedFrom?.(record.id).catch(() => undefined);
    found.push({ id: record.id, status: from ?? status, at: record.stateAt });
  }
  return found;
}

/** Closes the recorder, and only then lets the vanished-pane observers settle: what they settle from here is not this pass's. */
function closeRecorder(deps: AutoResumeDeps, exits: BootExitRecorder): ReturnType<BootExitRecorder['close']> {
  const owed = exits.close();
  deps.bootPass?.release();
  return owed;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
