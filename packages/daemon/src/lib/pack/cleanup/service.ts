/**
 * THE BUILDER (docs/pack-mode.md § Clean up, § Write it for me): the routing prompt's ONE generator — a
 * short-lived, hidden ferret, started through the session start every surface uses, on a runtime the person
 * picked or the ready one with the most quota left. One builder, two modes: `clean-up` rewrites the owner's
 * rough prompt, `generate` writes a whole one from a short idea (which may be empty). It is given the
 * owner's text and the harness inventory in files, writes its result to another, and signals done; the
 * result is checked against the inventory and kept with the run until a person reviews it as a before/after
 * diff (just "after" when there was nothing before).
 *
 * It runs only when a person asks (`fy guide clean-up`/`write`, the buttons): no timer starts one, and the
 * runtime is probed ("Reply with exactly: OK") first, like any sub-ferret, so a login out of quota is skipped
 * rather than started. A run's state is read when somebody asks for it, never polled here.
 */
import {
  PACK_CLEAN_UP_LABEL,
  type PackBuilderMode,
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
import { cleanUpBrief, generateBrief } from './prompt.ts';

/** The name a clean-up ferret shows under, like any ferret. */
export const CLEAN_UP_NAME = 'Routing Prompt Clean-up';

/** The name a write-it-for-me ferret shows under. */
export const GENERATE_NAME = 'Routing Prompt Writer';

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
const IDEA_FILE = 'idea.txt';
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

  /**
   * Starts one builder ferret after probing its runtime. `clean-up`: on the rough prompt, else the one in
   * effect. `generate`: on the idea and the owner's current prompt (the one given, else the one saved, else
   * none — a default is not the owner's to build on).
   */
  async start(request: PackCleanUpRequest): Promise<PackCleanUpStart> {
    const mode = request.mode ?? 'clean-up';
    const inventory = await this.ports.inventory();
    const rough =
      request.prompt ?? (mode === 'generate' && inventory.routing.source === 'default' ? '' : inventory.routing.text);
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
      return await this.launch({ mode, idea: request.idea ?? '', rough }, candidate.name, runtime, model, inventory);
    }
    return refused(`No runtime answered a "reply OK" check (${failures.join('; ') || 'none could be resolved'}).`);
  }

  /** One run, read now: a rewrite written since is checked and kept, and its ferret is stopped. */
  async job(id: string): Promise<PackCleanUpJobResult | undefined> {
    const run = await this.ports.runs.load(id);
    if (run === undefined || run.job.status !== 'running') return run;
    const mode = run.job.mode ?? 'clean-up';
    const [draft, status] = await Promise.all([
      this.ports.runs.readFile(id, DRAFT_FILE),
      this.ports.status(run.job.session),
    ]);
    const finished = status === undefined || FINISHED.has(status);
    if (draft === undefined) {
      if (!finished) return run;
      return await this.settle(run, {
        status: 'failed',
        message: `The ${mode === 'generate' ? 'writer' : 'clean-up'} ${status ?? 'ended'} without writing a prompt.`,
      });
    }
    const checked = checkRewrite(draft, await this.shown(id));
    // A rewrite still being written does not parse yet: wait for the ferret to finish before judging it.
    if (!checked.ok)
      return finished ? await this.settle(run, { status: 'failed', message: `${checked.message}.` }) : run;
    const given = (await this.ports.runs.readFile(id, ROUGH_FILE))?.trim() ?? '';
    // A clean-up with nothing on file compares the rewrite to itself; a generate had no prompt to build on.
    const before = given === '' && mode === 'clean-up' ? checked.prompt : given;
    const suggestion: PackCleanUpSuggestion = {
      suggested: {
        by: run.job.model ?? run.job.runtime,
        via: run.job.runtime,
        at: this.ports.now(),
        ...(mode === 'generate' ? { mode } : {}),
      },
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
    input: { readonly mode: PackBuilderMode; readonly idea: string; readonly rough: string },
    name: string,
    runtime: CleanUpRuntime,
    model: string | undefined,
    inventory: PackInventory,
  ): Promise<PackCleanUpStart> {
    const { mode, idea, rough } = input;
    const id = this.ports.newId();
    const roughPath = await this.ports.runs.writeFile(id, ROUGH_FILE, rough === '' ? '' : `${rough}\n`);
    const inventoryPath = await this.ports.runs.writeFile(
      id,
      INVENTORY_FILE,
      `${JSON.stringify(inventory, null, 2)}\n`,
    );
    const files = { rough: roughPath, inventory: inventoryPath, draft: this.ports.runs.pathOf(id, DRAFT_FILE) };
    const prompt =
      mode === 'generate'
        ? generateBrief(
            { ...files, idea: await this.ports.runs.writeFile(id, IDEA_FILE, idea === '' ? '' : `${idea}\n`) },
            this.ports.bin,
          )
        : cleanUpBrief(files, this.ports.bin);
    const view = await this.ports.start({
      agent: runtime.wrapper,
      mode: 'auto',
      prompt,
      label: PACK_CLEAN_UP_LABEL,
      name: mode === 'generate' ? GENERATE_NAME : CLEAN_UP_NAME,
      cwd: this.ports.home,
      boardAccess: 'none',
      ...(model === undefined ? {} : { model }),
    });
    const job: PackCleanUpJob = {
      id,
      session: view.config.id,
      name: view.config.teammate ?? (mode === 'generate' ? GENERATE_NAME : CLEAN_UP_NAME),
      ...(mode === 'generate' ? { mode } : {}),
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
      await this.ports
        .stop(
          run.job.session,
          `the routing prompt it ${run.job.mode === 'generate' ? 'wrote' : 'cleaned up'} has been read`,
        )
        .catch(() => undefined);
    return settled;
  }
}

/** Why no runtime can run Clean up, in one sentence. */
function noneReady(runtimes: readonly PackInventoryRuntime[]): string {
  const first = runtimes[0];
  if (first === undefined) return 'There is no agent runtime on this machine to clean up with.';
  return `No runtime can start a ferret now — ${first.refusal?.message ?? `${first.name} is not ready.`}`;
}
