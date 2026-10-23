/**
 * CLEAN UP (docs/pack-mode.md § Clean up): the routing prompt's ONE generator — a short-lived, hidden ferret,
 * started through the session start every surface uses, on a runtime the person picked or the ready one with
 * the most quota left. It is given the owner's rough prompt and the harness inventory in files, writes its
 * rewrite to another, and signals done; the rewrite is checked against the inventory and kept with the run
 * until a person reviews it as a before/after diff.
 *
 * It runs only when a person asks (`fy guide clean-up`, the Clean up button): no timer starts one, and the
 * runtime is probed ("Reply with exactly: OK") first, like any sub-ferret, so a login out of quota is skipped
 * rather than started. A run's state is read when somebody asks for it, never polled here.
 */
import {
  PACK_CLEAN_UP_LABEL,
  type PackCleanUpJob,
  type PackCleanUpJobResult,
  type PackCleanUpRequest,
  type PackCleanUpStart,
  type PackCleanUpStatus,
  type PackCleanUpSuggestion,
  type PackConfig,
  type PackInventory,
  type PackInventoryRuntime,
  PackInventorySchema,
  type SessionView,
  type StartSessionRequest,
} from '@ferretry/protocol';
import type { CachedProbe, PackProbeRequest } from '../probe.ts';
import { checkRewrite } from './draft.ts';
import { readyByHeadroom } from './inventory.ts';
import { cleanUpBrief } from './prompt.ts';

/** The name a clean-up ferret shows under, like any ferret. */
export const CLEAN_UP_NAME = 'Routing Prompt Clean-up';

/** How many finished runs are kept; older ones (and their files) are removed when a new one starts. */
export const KEPT_RUNS = 5;

/** A session status after which no process runs. */
const FINISHED: ReadonlySet<string> = new Set(['completed', 'failed', 'stalled', 'stopped']);

/** One run as it rests: the job, and its suggestion once it has one. */
export type CleanUpRun = PackCleanUpJobResult;

/** Where runs and their files live. */
export interface CleanUpRunStore {
  save(run: CleanUpRun): Promise<void>;
  load(id: string): Promise<CleanUpRun | undefined>;
  /** Every run, newest first. */
  list(): Promise<readonly CleanUpRun[]>;
  remove(id: string): Promise<void>;
  /** Writes one of a run's files and answers its absolute path. */
  writeFile(id: string, name: string, text: string): Promise<string>;
  /** A run's file, or `undefined` when it has not been written. */
  readFile(id: string, name: string): Promise<string | undefined>;
  /** Where a run's file is, written or not. */
  pathOf(id: string, name: string): string;
}

/** A runtime as a start needs it. */
export interface CleanUpRuntime {
  readonly wrapper: string;
  readonly harness: 'claude' | 'codex';
  /** The model it launches with when none is named. */
  readonly defaultModel?: string | undefined;
}

export interface CleanUpPorts {
  inventory(): Promise<PackInventory>;
  runtime(name: string): Promise<CleanUpRuntime | undefined>;
  probeSettings(): Promise<PackConfig['probe']>;
  probe(request: PackProbeRequest, ttlMs: number): Promise<CachedProbe>;
  start(request: StartSessionRequest): Promise<SessionView>;
  /** A session's status, or `undefined` when there is no such session. */
  status(session: string): Promise<string | undefined>;
  stop(session: string, reason: string): Promise<void>;
  runs: CleanUpRunStore;
  now(): string;
  newId(): string;
  /** The folder the clean-up runs in: the Ferretry home, never a project. */
  readonly home: string;
  readonly bin: string;
}

const ROUGH_FILE = 'rough.txt';
const INVENTORY_FILE = 'inventory.json';
const DRAFT_FILE = 'draft.json';

const refused = (message: string): PackCleanUpStart => ({ outcome: 'refused', message });

export class CleanUpService {
  constructor(private readonly ports: CleanUpPorts) {}

  /** Whether Clean up can run now, on what, and the newest run. */
  async status(): Promise<PackCleanUpStatus> {
    const [inventory, runs] = await Promise.all([this.ports.inventory(), this.ports.runs.list()]);
    const ready = readyByHeadroom(inventory.runtimes).map(runtime => runtime.name);
    const job = runs[0]?.job;
    return {
      available: ready.length > 0,
      runtimes: ready,
      ...(ready.length === 0 ? { reason: noneReady(inventory.runtimes) } : {}),
      ...(job === undefined ? {} : { job }),
    };
  }

  /** Starts one clean-up ferret on the rough prompt (else the one in effect), after probing its runtime. */
  async start(request: PackCleanUpRequest): Promise<PackCleanUpStart> {
    const inventory = await this.ports.inventory();
    let order: readonly PackInventoryRuntime[];
    if (request.runtime === undefined) order = readyByHeadroom(inventory.runtimes);
    else {
      const named = inventory.runtimes.find(runtime => runtime.name === request.runtime);
      if (named === undefined) return refused(`There is no agent runtime ${request.runtime} on this machine.`);
      if (!named.ready) return refused(named.refusal?.message ?? `${named.name} cannot start a ferret now.`);
      order = [named];
    }
    if (order.length === 0) return refused(noneReady(inventory.runtimes));
    const probe = await this.ports.probeSettings();
    const failures: string[] = [];
    for (const candidate of order) {
      const runtime = await this.ports.runtime(candidate.name);
      if (runtime === undefined) continue;
      const model = request.model ?? runtime.defaultModel;
      const probed = await this.ports.probe(
        {
          wrapper: runtime.wrapper,
          harness: runtime.harness,
          ...(model === undefined ? {} : { model }),
          cwd: this.ports.home,
          timeoutMs: probe.timeoutSeconds * 1_000,
        },
        probe.cacheSeconds * 1_000,
      );
      if (!probed.outcome.ok) {
        failures.push(`${candidate.name}: ${probed.outcome.reason}`);
        continue;
      }
      return await this.launch(candidate.name, runtime, model, request.prompt ?? inventory.routing.text, inventory);
    }
    return refused(`No runtime answered a "reply OK" check (${failures.join('; ') || 'none could be resolved'}).`);
  }

  /** One run, read now: a rewrite written since is checked and kept, and its ferret is stopped. */
  async job(id: string): Promise<PackCleanUpJobResult | undefined> {
    const run = await this.ports.runs.load(id);
    if (run === undefined || run.job.status !== 'running') return run;
    const [draft, status] = await Promise.all([
      this.ports.runs.readFile(id, DRAFT_FILE),
      this.ports.status(run.job.session),
    ]);
    const finished = status === undefined || FINISHED.has(status);
    if (draft === undefined) {
      if (!finished) return run;
      return await this.settle(run, {
        status: 'failed',
        message: `The clean-up ${status ?? 'ended'} without writing a prompt.`,
      });
    }
    const checked = checkRewrite(draft, await this.shown(id));
    // A rewrite still being written does not parse yet: wait for the ferret to finish before judging it.
    if (!checked.ok)
      return finished ? await this.settle(run, { status: 'failed', message: `${checked.message}.` }) : run;
    const before = (await this.ports.runs.readFile(id, ROUGH_FILE))?.trim() || checked.prompt;
    const suggestion: PackCleanUpSuggestion = {
      suggested: { by: run.job.model ?? run.job.runtime, via: run.job.runtime, at: this.ports.now() },
      before,
      after: checked.prompt,
      notes: checked.notes,
    };
    return await this.settle(run, { status: 'suggested' }, suggestion);
  }

  /** The inventory a run's ferret was shown; one that cannot be read lists nothing, so nothing is noted. */
  private async shown(id: string): Promise<PackInventory> {
    const text = await this.ports.runs.readFile(id, INVENTORY_FILE);
    try {
      const parsed = PackInventorySchema.safeParse(JSON.parse(text ?? 'null'));
      if (parsed.success) return parsed.data;
    } catch {
      // read as empty below
    }
    return { ...(await this.ports.inventory()), runtimes: [], models: [] };
  }

  private async launch(
    name: string,
    runtime: CleanUpRuntime,
    model: string | undefined,
    rough: string,
    inventory: PackInventory,
  ): Promise<PackCleanUpStart> {
    const id = this.ports.newId();
    const roughPath = await this.ports.runs.writeFile(id, ROUGH_FILE, `${rough}\n`);
    const inventoryPath = await this.ports.runs.writeFile(
      id,
      INVENTORY_FILE,
      `${JSON.stringify(inventory, null, 2)}\n`,
    );
    const view = await this.ports.start({
      agent: runtime.wrapper,
      mode: 'auto',
      prompt: cleanUpBrief(
        { rough: roughPath, inventory: inventoryPath, draft: this.ports.runs.pathOf(id, DRAFT_FILE) },
        this.ports.bin,
      ),
      label: PACK_CLEAN_UP_LABEL,
      name: CLEAN_UP_NAME,
      cwd: this.ports.home,
      boardAccess: 'none',
      ...(model === undefined ? {} : { model }),
    });
    const job: PackCleanUpJob = {
      id,
      session: view.config.id,
      name: view.config.teammate ?? CLEAN_UP_NAME,
      runtime: name,
      ...(model === undefined ? {} : { model }),
      startedAt: this.ports.now(),
      status: 'running',
    };
    await this.ports.runs.save({ job });
    // The newest few runs are kept for review; older ones, files and all, go.
    const runs = await this.ports.runs.list();
    for (const old of runs.slice(KEPT_RUNS)) await this.ports.runs.remove(old.job.id);
    return { outcome: 'started', job };
  }

  /** Records how a run ended and stops its ferret if it is still there: it has nothing left to do. */
  private async settle(
    run: CleanUpRun,
    end: { readonly status: 'suggested' | 'failed'; readonly message?: string },
    suggestion?: PackCleanUpSuggestion,
  ): Promise<CleanUpRun> {
    const settled: CleanUpRun = {
      job: { ...run.job, status: end.status, ...(end.message === undefined ? {} : { message: end.message }) },
      ...(suggestion === undefined ? {} : { suggestion }),
    };
    await this.ports.runs.save(settled);
    const status = await this.ports.status(run.job.session);
    if (status !== undefined && !FINISHED.has(status))
      await this.ports.stop(run.job.session, 'the routing prompt it cleaned up has been read').catch(() => undefined);
    return settled;
  }
}

/** Why no runtime can run Clean up, in one sentence. */
function noneReady(runtimes: readonly PackInventoryRuntime[]): string {
  const first = runtimes[0];
  if (first === undefined) return 'There is no agent runtime on this machine to clean up with.';
  return `No runtime can start a ferret now — ${first.refusal?.message ?? `${first.name} is not ready.`}`;
}
