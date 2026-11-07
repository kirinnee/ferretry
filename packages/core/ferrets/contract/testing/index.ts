/**
 * `@ferretry/core-ferrets/contract/testing` (§7.8): Ferrets' fakes and the conformance suites of its kinds. Terminals
 * runs its `runners:tmux` value through `runnerConformance` (including D15 `attach`); Claude Code and Codex run theirs
 * through `harnessConformance`; Logins through `loginKindConformance`. The fakes pass the same suites.
 */
import { describe, expect, test } from 'bun:test';
import { type ChildEnvironment, SECRET_REFERENCE_SOURCE } from '@ferretry/core-vault/contract';
import type { FencedPath, FerretId, FolderRefusal, WorkFolders } from '@ferretry/kernel/contract';
import { err, type Instant, instantFromEpochMs, ok, type Result } from '@ferretry/std';
import type { FerretState, FerretSummary, HarnessKey, LoginKindKey, PackId } from '../ids.ts';
import type {
  AttachRefusal,
  DeliveryOutcome,
  RunnerDelivery,
  Delivery,
  Harness,
  LaunchSpec,
  LoginKind,
  OutboundMessage,
  Runner,
  RunnerHandle,
  RunningFerret,
  RunSpec,
  StartRefusal,
  Started,
} from '../kinds.ts';
import type { FerretsApi, Sitrep, StartFailure, StartRequest } from '../port.ts';
import { type AgentControl, DEFAULT_AGENT_CONTROL, NO_AGENT_CONTROL } from '../state.ts';

/** 2026-11-07T12:00:00Z. */
export const T0: Instant = instantFromEpochMs(1_794_052_800_000);
export const ferretId = (id: string): FerretId => id as FerretId;
export const fenced = (path: string): FencedPath => path as FencedPath;
/** An opaque child environment for runner and harness tests (names only; no value). */
export const emptyChildEnvironment = (): ChildEnvironment =>
  Object.freeze({ names: [] }) as unknown as ChildEnvironment;

// ─── runner ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** An in-memory runner: handles `%1`, `%2`, …; `attach` adopts a live handle without starting anything. */
export class FakeRunner implements Runner {
  readonly key = 'tmux' as const;
  starts = 0;
  /** Every delivery made, with the handle it went to. */
  readonly deliveries: { readonly handle: RunnerHandle; readonly delivery: RunnerDelivery }[] = [];
  readonly #live = new Map<string, RunningFerret & { readonly ferret: FerretId }>();
  #next = 0;

  /** TEST ONLY: a process that was already running before this daemon (the 5.0 switch, D15). */
  adoptable(ferret: FerretId): RunnerHandle {
    this.#next += 1;
    const handle = `%${this.#next}` as RunnerHandle;
    this.#live.set(handle, { handle, pid: 1000 + this.#next, startedAt: T0, ferret });
    return handle;
  }
  async start(spec: RunSpec): Promise<Result<RunningFerret, StartRefusal>> {
    this.starts += 1;
    this.#next += 1;
    const handle = `%${this.#next}` as RunnerHandle;
    const running = { handle, pid: 1000 + this.#next, startedAt: T0 };
    this.#live.set(handle, { ...running, ferret: spec.ferret });
    return ok(running);
  }
  async stop(handle: RunnerHandle): Promise<void> {
    this.#live.delete(handle);
  }
  async resume(spec: RunSpec): Promise<Result<RunningFerret, StartRefusal>> {
    return await this.start(spec);
  }
  async attach(handle: RunnerHandle): Promise<Result<RunningFerret, AttachRefusal>> {
    const live = this.#live.get(handle);
    if (live === undefined) return err('gone');
    return ok({ handle: live.handle, ...(live.pid === undefined ? {} : { pid: live.pid }), startedAt: live.startedAt });
  }
  async alive(handle: RunnerHandle): Promise<boolean> {
    return this.#live.has(handle);
  }
  async signal(): Promise<void> {}
  async deliver(handle: RunnerHandle, delivery: RunnerDelivery): Promise<DeliveryOutcome> {
    if (!this.#live.has(handle)) throw new Error(`no pane ${handle}`);
    await delivery.beforeWrite?.();
    this.deliveries.push({ handle, delivery });
    return delivery.text.startsWith('/') ? 'handled-local' : 'turn-started';
  }
}

export interface RunnerSubject {
  readonly runner: Runner;
  readonly spec: RunSpec;
  /** A live process started outside this runner instance (a previous daemon), returned by handle. */
  adoptable(): Promise<RunnerHandle>;
  /** How many processes this runner has started (attach must not add one). */
  starts(): number;
}

/** The `runners` conformance suite, with spine D15: `attach` adopts a live handle WITHOUT restarting it. */
export function runnerConformance(name: string, make: () => RunnerSubject | Promise<RunnerSubject>): void {
  describe(`runner conformance: ${name}`, () => {
    test('a started ferret is alive until stopped', async () => {
      const subject = await make();
      const started = await subject.runner.start(subject.spec);
      if (!started.ok) throw new Error('start refused');
      expect(await subject.runner.alive(started.value.handle)).toBe(true);
      await subject.runner.stop(started.value.handle, 'now');
      expect(await subject.runner.alive(started.value.handle)).toBe(false);
    });
    test('attach adopts a live handle without starting anything (D15)', async () => {
      const subject = await make();
      const handle = await subject.adoptable();
      const before = subject.starts();
      const attached = await subject.runner.attach(handle);
      expect(attached.ok).toBe(true);
      if (attached.ok) expect(attached.value.handle).toBe(handle);
      expect(subject.starts()).toBe(before);
      expect(await subject.runner.alive(handle)).toBe(true);
    });
    test('attach to a handle with nothing behind it is refused, never a start (D15)', async () => {
      const subject = await make();
      const before = subject.starts();
      const attached = await subject.runner.attach('%99999' as RunnerHandle);
      expect(attached.ok).toBe(false);
      expect(subject.starts()).toBe(before);
    });
    test('a delivery to a live ferret lands after its beforeWrite step and answers an outcome', async () => {
      const subject = await make();
      const started = await subject.runner.start(subject.spec);
      if (!started.ok) throw new Error('start refused');
      const steps: string[] = [];
      const outcome = await subject.runner.deliver(started.value.handle, {
        text: 'hello',
        beforeWrite: async () => {
          steps.push('before');
        },
      });
      expect(['turn-started', 'handled-local']).toContain(outcome);
      expect(steps).toEqual(['before']);
      await subject.runner.stop(started.value.handle, 'now');
    });
    test('a delivery to a handle with nothing behind it rejects and starts nothing', async () => {
      const subject = await make();
      const before = subject.starts();
      await expect(subject.runner.deliver('%99999' as RunnerHandle, { text: 'hello' })).rejects.toThrow();
      expect(subject.starts()).toBe(before);
    });
    test('attach after stop is refused', async () => {
      const subject = await make();
      const handle = await subject.adoptable();
      await subject.runner.stop(handle, 'now');
      expect((await subject.runner.attach(handle)).ok).toBe(false);
    });
  });
}

// ─── harness ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A harness that names one home per ferret under its own `homes` folder (a fixture path, never a real one), writes
 * one file there, starts through the runner it is given and delivers idempotently.
 */
export class FakeHarness implements Harness {
  readonly accepts: readonly LoginKindKey[] = ['anthropic', 'api-key'];
  readonly delivered: OutboundMessage[] = [];
  /** Every launch spec this harness was handed (start and resume), so a test sees what reached it. */
  readonly launched: LaunchSpec[] = [];
  /** Every launch spec `prepareHome` was handed, in order. */
  readonly prepared: LaunchSpec[] = [];
  readonly #seen = new Set<string>();
  constructor(
    readonly key: HarnessKey = 'claude-code',
    /** This harness's own `agent-homes` folder: `homeFor` answers `<homes>/<ferret>`. */
    readonly homes: string = '/home/agent-homes',
  ) {}

  async discover() {
    return { found: true as const, binary: '/usr/bin/fake-harness', version: '1.0.0' };
  }
  async homeFor(ferret: FerretId): Promise<FencedPath> {
    if (ferret === '' || ferret.includes('/') || ferret === '.' || ferret === '..')
      throw new Error('the ferret id must be one plain name');
    return fenced(`${this.homes}/${ferret}`);
  }
  async prepareHome(spec: LaunchSpec) {
    if (spec.home !== (await this.homeFor(spec.ferret)))
      throw new Error('the launch home is not this harness’s home for the ferret');
    this.prepared.push(spec);
    return { files: [fenced(`${spec.home}/INSTRUCTIONS.md`)], args: [] };
  }
  async start(spec: LaunchSpec, runner: Runner, env: ChildEnvironment): Promise<Result<Started, StartRefusal>> {
    this.launched.push(spec);
    const running = await runner.start({ ferret: spec.ferret, command: ['fake-harness'], cwd: spec.folder, env });
    return running.ok ? ok({ running: running.value, harnessConversation: `conv-${spec.ferret}` }) : running;
  }
  async resume(spec: LaunchSpec, runner: Runner, env: ChildEnvironment, conversation: string) {
    this.launched.push(spec);
    const running = await runner.resume(
      { ferret: spec.ferret, command: ['fake-harness', '--resume'], cwd: spec.folder, env },
      conversation,
    );
    return running.ok ? ok({ running: running.value, harnessConversation: conversation }) : running;
  }
  async stop(_ferret: FerretId, handle: RunnerHandle, runner: Runner, how: 'polite' | 'now') {
    await runner.stop(handle, how);
  }
  async deliver(_ferret: FerretId, _handle: RunnerHandle, message: OutboundMessage): Promise<Delivery> {
    if (!this.#seen.has(message.id)) {
      this.#seen.add(message.id);
      this.delivered.push(message);
    }
    return { status: 'delivered', id: message.id };
  }
  readonly transcript = {
    read: async () => [],
    follow: async function* () {},
    find: async () => undefined,
  };
  readonly usage = { turns: async () => [] };
  readonly conversations = { list: async () => [] };
}

export interface HarnessSubject {
  readonly harness: Harness;
  readonly runner: Runner;
  readonly spec: LaunchSpec;
  /** How many times a message with this id reached the ferret. */
  deliveredCount(id: string): number;
  /**
   * Set for a harness that refuses every `deliver` because another subsystem owns its send path (Codex: Conversation).
   * The delivery case then holds it to refusing both attempts and reaching the ferret zero times.
   */
  readonly deliversElsewhere?: true;
}

export const sampleLaunchSpec = (harness: HarnessKey = 'claude-code'): LaunchSpec => ({
  ferret: ferretId('f1'),
  name: 'Fern',
  role: 'lead',
  harness,
  folder: fenced('/work/project'),
  home: fenced('/home/agent-homes/f1'),
  instructions: [],
  parts: [],
});

/** The `harnesses` conformance suite (§4.3): start/stop through the runner, idempotent delivery, home-only writes. */
export function harnessConformance(name: string, make: () => HarnessSubject | Promise<HarnessSubject>): void {
  describe(`harness conformance: ${name}`, () => {
    test('discover answers found or missing without starting anything', async () => {
      const { harness } = await make();
      const found = await harness.discover();
      expect(typeof found.found).toBe('boolean');
    });
    test('prepareHome writes only inside the ferret’s home', async () => {
      const { harness, spec } = await make();
      const plan = await harness.prepareHome(spec);
      for (const file of plan.files) expect(file.startsWith(`${spec.home}/`)).toBe(true);
    });
    test('S42 homeFor names one absolute home per ferret, and prepareHome refuses any other home', async () => {
      const { harness, spec } = await make();
      const own = await harness.homeFor(spec.ferret);
      const other = await harness.homeFor(ferretId(`${spec.ferret}-other`));
      expect(own).toBe(spec.home);
      expect(own.startsWith('/')).toBe(true);
      expect(other).not.toBe(own);
      expect(other.startsWith(`${own}/`) || own.startsWith(`${other}/`)).toBe(false);
      await expect(harness.prepareHome({ ...spec, home: other })).rejects.toBeDefined();
    });
    test('start runs through the runner it is given and stop ends it', async () => {
      const { harness, runner, spec } = await make();
      const started = await harness.start(spec, runner, emptyChildEnvironment());
      if (!started.ok) throw new Error('start refused');
      expect(await runner.alive(started.value.running.handle)).toBe(true);
      await harness.stop(spec.ferret, started.value.running.handle, runner, 'now');
      expect(await runner.alive(started.value.running.handle)).toBe(false);
    });
    test('deliver is idempotent by message id', async () => {
      const subject = await make();
      const started = await subject.harness.start(subject.spec, subject.runner, emptyChildEnvironment());
      if (!started.ok) throw new Error('start refused');
      const message = { id: 'm1', text: 'hello' };
      const first = await subject.harness.deliver(subject.spec.ferret, started.value.running.handle, message);
      const second = await subject.harness.deliver(subject.spec.ferret, started.value.running.handle, message);
      if (subject.deliversElsewhere === true) {
        expect([first.status, second.status]).toEqual(['refused', 'refused']);
        expect(subject.deliveredCount('m1')).toBe(0);
        return;
      }
      expect(subject.deliveredCount('m1')).toBe(1);
    });
  });
}

// ─── login ────────────────────────────────────────────────────────────────────────────────────────────────────────

export class FakeLoginKind implements LoginKind {
  readonly fields = [{ id: 'key', label: 'API key', secret: true }];
  readonly harnesses: readonly HarnessKey[] = ['claude-code'];
  constructor(readonly key: LoginKindKey = 'api-key') {}
  async signIn() {
    return { kind: 'done' as const };
  }
  async status() {
    return { state: 'signed-in' as const };
  }
  async env(login: string) {
    return { ANTHROPIC_API_KEY: `\${secret:LOGIN_${login.toUpperCase().replaceAll('-', '_')}}` };
  }
}

/** Which environment entries a login kind returns, so the suite can hold EVERY credential-bearing one to a reference. */
export interface LoginEnvFixture {
  /** Entries that carry a credential: each value must be exactly one `${secret:NAME}` reference. */
  readonly credentialEnv: readonly string[];
  /** Entries that carry no credential (a base URL, a flag). An entry in neither list is refused. */
  readonly plainEnv?: readonly string[];
}

const WHOLE_SECRET_REFERENCE = new RegExp(`^${SECRET_REFERENCE_SOURCE}$`, 'u');

/**
 * Why a login's environment fails the values-as-references rule, one sentence per entry; empty when it passes. Every
 * credential-bearing entry must be a whole `${secret:NAME}` reference with no literal material beside it, and every
 * entry must be declared, so a literal credential cannot ride along next to a reference.
 */
export function loginEnvRefusals(env: Readonly<Record<string, string>>, fixture: LoginEnvFixture): readonly string[] {
  const refusals: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (fixture.credentialEnv.includes(key)) {
      if (!WHOLE_SECRET_REFERENCE.test(value))
        refusals.push(`${key} carries a credential that is not a \${secret:NAME} reference`);
    } else if (!(fixture.plainEnv ?? []).includes(key)) refusals.push(`${key} is not a declared environment entry`);
  }
  return refusals;
}

/** The `logins` conformance suite (§4.4): secret values only as `${secret:NAME}`, fields unique, a harness named. */
export function loginKindConformance(
  name: string,
  make: () => LoginKind | Promise<LoginKind>,
  fixture: LoginEnvFixture,
): void {
  describe(`login conformance: ${name}`, () => {
    test('field ids are unique and at least one harness can spend it', async () => {
      const login = await make();
      const ids = login.fields.map(field => field.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(login.harnesses.length).toBeGreaterThan(0);
    });
    test('env carries every credential-bearing entry only as a ${secret:NAME} reference', async () => {
      const login = await make();
      for (const harness of login.harnesses) {
        const env = await login.env('work', harness);
        expect(loginEnvRefusals(env, fixture)).toEqual([]);
        if (login.fields.some(field => field.secret))
          expect(Object.keys(env).some(key => fixture.credentialEnv.includes(key))).toBe(true);
      }
    });
  });
}

// ─── the Ferrets port and work folders ────────────────────────────────────────────────────────────────────────────

/** An in-memory Ferrets port: lineage, `mayTouch`, start through nothing (records only). */
export class FakeFerrets implements FerretsApi {
  readonly #ferrets = new Map<FerretId, FerretSummary>();
  /** Every start request, stop and resume, in order, so a test can assert what reached the port. */
  readonly starts: StartRequest[] = [];
  readonly stops: { readonly ferret: FerretId; readonly how: 'polite' | 'now'; readonly reason?: string }[] = [];
  readonly resumes: { readonly ferret: FerretId; readonly message?: string }[] = [];
  #next = 0;

  add(summary: Partial<FerretSummary> & { readonly id: FerretId }): FerretSummary {
    const full: FerretSummary = {
      name: summary.id,
      role: summary.parent === undefined ? 'lead' : 'helper',
      harness: 'claude-code',
      runner: 'tmux',
      folder: '/work/project',
      state: 'idle',
      createdAt: T0,
      stateAt: T0,
      ...summary,
    };
    this.#ferrets.set(full.id, full);
    return full;
  }
  setState(ferret: FerretId, state: FerretState): void {
    const current = this.#ferrets.get(ferret);
    if (current !== undefined) this.#ferrets.set(ferret, { ...current, state });
  }
  async get(ferret: FerretId) {
    return this.#ferrets.get(ferret);
  }
  async list(filter: { readonly state?: FerretState; readonly parent?: FerretId; readonly pack?: PackId } = {}) {
    return [...this.#ferrets.values()].filter(
      f =>
        (filter.state === undefined || f.state === filter.state) &&
        (filter.parent === undefined || f.parent === filter.parent) &&
        (filter.pack === undefined || f.pack === filter.pack),
    );
  }
  mayTouch(caller: FerretId, target: FerretId): boolean {
    for (let at: FerretId | undefined = target; at !== undefined; at = this.#ferrets.get(at)?.parent)
      if (at === caller) return true;
    return false;
  }
  harnesses(): readonly HarnessKey[] {
    return ['claude-code', 'codex'];
  }
  children(ferret: FerretId): readonly FerretId[] {
    return [...this.#ferrets.values()].filter(f => f.parent === ferret).map(f => f.id);
  }
  async start(request: StartRequest): Promise<Result<FerretId, StartFailure>> {
    this.starts.push(request);
    this.#next += 1;
    const id = ferretId(`f${this.#next}`);
    // The start options the real summary carries (`summaryOf`): its model, card, label and title.
    const { model, card, label, title } = request.options ?? {};
    this.add({
      id,
      name: request.name ?? id,
      folder: request.folder,
      state: 'starting',
      ...(request.parent === undefined ? {} : { parent: request.parent }),
      ...(model === undefined ? {} : { model }),
      ...(card === undefined ? {} : { card }),
      ...(label === undefined ? {} : { label }),
      ...(title === undefined ? {} : { title }),
    });
    return ok(id);
  }
  async stop(ferret: FerretId, how: 'polite' | 'now' = 'polite', reason?: string) {
    this.stops.push({ ferret, how, ...(reason === undefined ? {} : { reason }) });
    this.setState(ferret, 'stopped');
  }
  async resume(ferret: FerretId, message?: string): Promise<Result<FerretId, StartFailure>> {
    if (!this.#ferrets.has(ferret)) return err({ code: 'failed', reason: 'no such ferret' });
    this.resumes.push({ ferret, ...(message === undefined ? {} : { message }) });
    this.setState(ferret, 'starting');
    return ok(ferret);
  }
  async workFolder(ferret: FerretId): Promise<{ readonly folder: string } | undefined> {
    const summary = this.#ferrets.get(ferret);
    return summary === undefined ? undefined : { folder: summary.folder };
  }
  readonly #handles = new Map<FerretId, RunnerHandle>();
  async attach(ferret: FerretId, handle: RunnerHandle): Promise<Result<FerretId, StartFailure>> {
    if (!this.#ferrets.has(ferret)) return err({ code: 'failed', reason: 'no such ferret' });
    this.setState(ferret, 'working');
    this.#handles.set(ferret, handle);
    return ok(ferret);
  }
  async handle(ferret: FerretId): Promise<RunnerHandle | undefined> {
    return this.#ferrets.get(ferret)?.state === 'stopped' ? undefined : this.#handles.get(ferret);
  }
  async sitrep(ferret: FerretId): Promise<Sitrep | undefined> {
    const summary = this.#ferrets.get(ferret);
    return summary === undefined ? undefined : { ferret: summary, lines: [], blockers: [] };
  }
  readonly #summaries = new Map<FerretId, string>();
  /** TEST ONLY: what a ferret's `signal done` wrote to its `summary.md`. */
  setSummary(ferret: FerretId, text: string): void {
    this.#summaries.set(ferret, text);
  }
  async summary(ferret: FerretId): Promise<string | undefined> {
    return this.#ferrets.get(ferret)?.state === 'stopped' ? this.#summaries.get(ferret) : undefined;
  }
  readonly #controls = new Map<FerretId, Partial<AgentControl>>();
  /** TEST ONLY: what one ferret may control, over today's defaults. */
  setAgentControl(ferret: FerretId, control: Partial<AgentControl>): void {
    this.#controls.set(ferret, control);
  }
  async agentControl(ferret: FerretId): Promise<AgentControl> {
    if (!this.#ferrets.has(ferret)) return NO_AGENT_CONTROL;
    return { ...DEFAULT_AGENT_CONTROL, ...this.#controls.get(ferret) };
  }
}

/** `mayTouch` conformance: itself, its helpers (transitively), never its parent, a sibling or a stranger. */
export function mayTouchConformance(
  name: string,
  make: () => { readonly ferrets: FerretsApi; add(id: FerretId, parent?: FerretId): void },
): void {
  describe(`ferret lineage conformance: ${name}`, () => {
    test('a ferret touches only its own; a lead also its helpers’', () => {
      const subject = make();
      const [lead, helper, grandHelper, sibling, stranger] = ['lead', 'helper', 'grand', 'sibling', 'stranger'].map(
        ferretId,
      ) as [FerretId, FerretId, FerretId, FerretId, FerretId];
      subject.add(lead);
      subject.add(helper, lead);
      subject.add(grandHelper, helper);
      subject.add(sibling, lead);
      subject.add(stranger);
      expect(subject.ferrets.mayTouch(lead, lead)).toBe(true);
      expect(subject.ferrets.mayTouch(lead, helper)).toBe(true);
      expect(subject.ferrets.mayTouch(lead, grandHelper)).toBe(true);
      expect(subject.ferrets.mayTouch(helper, lead)).toBe(false);
      expect(subject.ferrets.mayTouch(helper, sibling)).toBe(false);
      expect(subject.ferrets.mayTouch(stranger, lead)).toBe(false);
    });
  });
}

/** Work folders over a fixed map; refuses `..`, paths outside the folder and unknown ferrets. */
export class FakeWorkFolders implements WorkFolders {
  constructor(private readonly folders: ReadonlyMap<FerretId, string>) {}
  folderOf(ferret: FerretId): FencedPath | undefined {
    const folder = this.folders.get(ferret);
    return folder === undefined ? undefined : fenced(folder);
  }
  check(ferret: FerretId, path: string): Result<FencedPath, FolderRefusal> {
    const folder = this.folders.get(ferret);
    if (folder === undefined) return err('unknown_ferret');
    if (path.split('/').includes('..')) return err('outside');
    const absolute = path.startsWith('/') ? path : `${folder}/${path}`;
    return absolute === folder || absolute.startsWith(`${folder}/`) ? ok(fenced(absolute)) : err('outside');
  }
}

export function workFoldersConformance(
  name: string,
  make: () => { readonly folders: WorkFolders; readonly ferret: FerretId; readonly folder: string },
): void {
  describe(`work folders conformance: ${name}`, () => {
    test('a path inside the ferret’s folder is accepted; outside, `..` and an unknown ferret are refused', () => {
      const { folders, ferret, folder } = make();
      expect(folders.check(ferret, `${folder}/src/a.ts`).ok).toBe(true);
      expect(folders.check(ferret, 'src/a.ts').ok).toBe(true);
      expect(folders.check(ferret, '/etc/passwd')).toEqual(err('outside'));
      expect(folders.check(ferret, `${folder}/../other`).ok).toBe(false);
      expect(folders.check(ferretId('nobody'), `${folder}/a`)).toEqual(err('unknown_ferret'));
      expect(folders.folderOf(ferretId('nobody'))).toBeUndefined();
    });
  });
}
