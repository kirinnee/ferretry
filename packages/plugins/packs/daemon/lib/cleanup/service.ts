/**
 * THE BUILDER (docs/pack-mode.md § Clean up, § Write it for me): the routing prompt's ONE generator — a
 * short-lived, hidden ferret, started through the ferret start every surface uses, on a runtime the person
 * picked or the ready one with the most quota left. One builder, two modes: `clean-up` rewrites the owner's
 * rough prompt, `generate` writes a whole one from a short idea (which may be empty). It is given the
 * owner's text and the harness inventory in files, writes its result to another, and signals done; the
 * result is checked against the inventory and kept with the run until a person reviews it as a before/after
 * diff (just "after" when there was nothing before).
 *
 * It runs only when a person asks (`fy guide clean-up`/`write`, the buttons): no timer starts one, and the
 * runtime is checked first (`../probe.ts`), so one that cannot start is skipped rather than started. On this base the
 * check is the weaker one: the runtime resolves, is switched on and its login is signed in. Today's check also ran the
 * launcher once and asked the model to "reply OK", which caught a login out of quota; that needs a one-shot harness
 * run Ferrets or Runtimes does not offer yet (ports-pending). A run's state is read when somebody asks for it, never
 * polled here.
 */
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import type { Instant } from '@ferretry/std';
import {
  PACK_CLEAN_UP_PACK,
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
} from '../../../contract/index.ts';
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

/** A ferret state after which no process runs. */
const FINISHED: ReadonlySet<string> = new Set(['stopped']);

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
  writeFile(id: string, name: string, text: string): Promise<void>;
  /** A run's file, or `undefined` when it has not been written. */
  readFile(id: string, name: string): Promise<string | undefined>;
}

/** A runtime as a start needs it. */
export interface CleanUpRuntime {
  readonly wrapper: string;
  readonly harness: HarnessKey;
  /** The model it launches with when none is named. */
  readonly defaultModel?: string | undefined;
}

/** What the builder ferret is started with: the runtime's launcher, the brief, a pack id that hides it, the Ferretry home. */
export interface CleanUpStartRequest {
  readonly runtime: string;
  readonly wrapper: string;
  readonly harness: HarnessKey;
  readonly mode: 'auto';
  readonly prompt: string;
  readonly pack: string;
  readonly name: string;
  readonly cwd: string;
  readonly model?: string;
}

export interface CleanUpPorts {
  inventory(): Promise<PackInventory>;
  runtime(name: string): Promise<CleanUpRuntime | undefined>;
  probeSettings(): Promise<PackConfig['probe']>;
  probe(request: PackProbeRequest, ttlMs: number): Promise<CachedProbe>;
  /** Starts the builder ferret and answers its id and the name it shows under. */
  start(request: CleanUpStartRequest): Promise<{ readonly id: string; readonly name?: string | undefined }>;
  /** A ferret's state, or `undefined` when there is no such ferret. */
  status(ferret: string): Promise<string | undefined>;
  /** What a finished ferret handed back with `signal done`, or `undefined` when it gave nothing. */
  result(ferret: string): Promise<string | undefined>;
  stop(ferret: string, reason: string): Promise<void>;
  runs: CleanUpRunStore;
  now(): string;
  newId(): string;
  /**
   * The folder the clean-up runs in: today's is the Ferretry home, never a project. `undefined` when no port gives it
   * (none does on this base: the Ferretry home is not a folder a plugin is handed), and Clean up then refuses to start.
   */
  readonly home: string | undefined;
  readonly bin: string;
}

const ROUGH_FILE = 'rough.txt';
const IDEA_FILE = 'idea.txt';
const INVENTORY_FILE = 'inventory.json';
const DRAFT_FILE = 'draft.json';

const refused = (message: string): PackCleanUpStart => ({ outcome: 'refused', message });

/** Why Clean up cannot start where no folder for its ferret is known. */
export const NO_CLEAN_UP_FOLDER =
  'Clean up has no folder to run its ferret in on this machine yet (the Ferretry home is not handed to Pack mode), so nothing was started. Edit config/packs.yaml by hand meanwhile.';

export class CleanUpService {
  constructor(private readonly ports: CleanUpPorts) {}

  /** Whether Clean up can run now, on what, and the newest run. */
  async status(): Promise<PackCleanUpStatus> {
    const [inventory, runs] = await Promise.all([this.ports.inventory(), this.ports.runs.list()]);
    const ready = readyByHeadroom(inventory.runtimes).map(runtime => runtime.name);
    const job = runs[0]?.job;
    const reason =
      this.ports.home === undefined
        ? NO_CLEAN_UP_FOLDER
        : ready.length === 0
          ? noneReady(inventory.runtimes)
          : undefined;
    return {
      available: reason === undefined,
      runtimes: ready,
      ...(reason === undefined ? {} : { reason }),
      ...(job === undefined ? {} : { job }),
    };
  }

  /**
   * Starts one builder ferret after probing its runtime. `clean-up`: on the rough prompt, else the one in
   * effect. `generate`: on the idea and the owner's current prompt (the one given, else the one saved, else
   * none — a default is not the owner's to build on).
   */
  async start(request: PackCleanUpRequest): Promise<PackCleanUpStart> {
    const home = this.ports.home;
    if (home === undefined) return refused(NO_CLEAN_UP_FOLDER);
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
          cwd: home,
          timeoutMs: probe.timeoutSeconds * 1_000,
        },
        probe.cacheSeconds * 1_000,
      );
      if (!probed.outcome.ok) {
        failures.push(`${candidate.name}: ${probed.outcome.reason}`);
        continue;
      }
      return await this.launch(
        { mode, idea: request.idea ?? '', rough, home },
        candidate.name,
        runtime,
        model,
        inventory,
      );
    }
    return refused(`No runtime passed the start check (${failures.join('; ') || 'none could be resolved'}).`);
  }

  /** One run, read now: a rewrite written since is checked and kept, and its ferret is stopped. */
  async job(id: string): Promise<PackCleanUpJobResult | undefined> {
    const run = await this.ports.runs.load(id);
    if (run === undefined || run.job.status !== 'running') return run;
    const mode = run.job.mode ?? 'clean-up';
    const status = await this.ports.status(run.job.ferret);
    const finished = status === undefined || FINISHED.has(status);
    // The rewrite is the message of the ferret's `signal done`; one already kept with the run wins.
    const draft =
      (await this.ports.runs.readFile(id, DRAFT_FILE)) ??
      (finished ? await this.ports.result(run.job.ferret).catch(() => undefined) : undefined);
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
        at: this.ports.now() as Instant,
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
    input: { readonly mode: PackBuilderMode; readonly idea: string; readonly rough: string; readonly home: string },
    name: string,
    runtime: CleanUpRuntime,
    model: string | undefined,
    inventory: PackInventory,
  ): Promise<PackCleanUpStart> {
    const { mode, idea, rough, home } = input;
    const id = this.ports.newId();
    // What the run was shown is kept with it: the rough prompt is the "before" of the review, the inventory is what
    // the rewrite is checked against.
    const shown = `${JSON.stringify(inventory, null, 2)}\n`;
    await this.ports.runs.writeFile(id, ROUGH_FILE, rough === '' ? '' : `${rough}\n`);
    await this.ports.runs.writeFile(id, INVENTORY_FILE, shown);
    if (mode === 'generate') await this.ports.runs.writeFile(id, IDEA_FILE, idea === '' ? '' : `${idea}\n`);
    const inputs = { rough, inventory: shown };
    const prompt =
      mode === 'generate' ? generateBrief({ ...inputs, idea }, this.ports.bin) : cleanUpBrief(inputs, this.ports.bin);
    const started = await this.ports.start({
      runtime: name,
      wrapper: runtime.wrapper,
      harness: runtime.harness,
      mode: 'auto',
      prompt,
      pack: PACK_CLEAN_UP_PACK,
      name: mode === 'generate' ? GENERATE_NAME : CLEAN_UP_NAME,
      cwd: home,
      ...(model === undefined ? {} : { model }),
    });
    const job: PackCleanUpJob = {
      id,
      ferret: started.id,
      name: started.name ?? (mode === 'generate' ? GENERATE_NAME : CLEAN_UP_NAME),
      ...(mode === 'generate' ? { mode } : {}),
      runtime: name,
      ...(model === undefined ? {} : { model }),
      startedAt: this.ports.now() as Instant,
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
    const status = await this.ports.status(run.job.ferret);
    if (status !== undefined && !FINISHED.has(status))
      await this.ports
        .stop(
          run.job.ferret,
          `the routing prompt it ${run.job.mode === 'generate' ? 'wrote' : 'cleaned up'} has been read`,
        )
        .catch(() => undefined);
    return settled;
  }
}

/** Why no runtime can run Clean up, in one sentence. */
function noneReady(runtimes: readonly PackInventoryRuntime[]): string {
  const first = runtimes[0];
  if (first === undefined)
    return 'Pack mode lists no agent runtime on this machine to clean up with (Runtimes does not offer Pack mode its catalog yet).';
  return `No runtime can start a ferret now — ${first.refusal?.message ?? `${first.name} is not ready.`}`;
}
