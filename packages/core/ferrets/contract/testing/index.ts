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
import {
  type AttachRefusal,
  type DeliveryOutcome,
  HARNESS_STOP_KEYS,
  type HarnessLaunchSettings,
  type HarnessStop,
  type HarnessTailRecord,
  type HarnessTranscriptStamp,
  type HarnessTranscriptTail,
  type RunnerDelivery,
  type RunnerDeliveryFailure,
  type Delivery,
  type Harness,
  type LaunchSpec,
  type LoginKind,
  type OutboundMessage,
  type QueueOutcome,
  type Runner,
  type RunnerHandle,
  runnerDeliveryFailure,
  type RunnerComposerCleared,
  type RunnerComposerSubmitted,
  type RunnerHeldAt,
  type RunnerLook,
  type RunnerPaneObservation,
  type RunnerStop,
  type RunnerStopOutcome,
  type RunningFerret,
  type RunSpec,
  shouldPressStopKey,
  type StartRefusal,
  type Started,
} from '../kinds.ts';
import type { FerretsApi, ManagedWorktreeSummary, ResumeOptions, Sitrep, StartFailure, StartRequest } from '../port.ts';
import { type AgentControl, DEFAULT_AGENT_CONTROL, NO_AGENT_CONTROL } from '../state.ts';

/** 2026-11-07T12:00:00Z. */
export const T0: Instant = instantFromEpochMs(1_794_052_800_000);
export const ferretId = (id: string): FerretId => id as FerretId;
export const fenced = (path: string): FencedPath => path as FencedPath;
/** An opaque child environment for runner and harness tests (names only; no value). */
export const emptyChildEnvironment = (): ChildEnvironment =>
  Object.freeze({ names: [] }) as unknown as ChildEnvironment;

// ─── runner ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A runner rejection carrying the contract's closed failure, as a real runner's errors carry it. */
export class FakeRunnerFailure extends Error {
  constructor(readonly deliveryFailure: RunnerDeliveryFailure) {
    super(`the fake runner: ${deliveryFailure.kind}`);
    this.name = 'FakeRunnerFailure';
  }
}

/** An in-memory runner: handles `%1`, `%2`, …; `attach` adopts a live handle without starting anything. */
export class FakeRunner implements Runner {
  readonly key = 'tmux' as const;
  starts = 0;
  /** Every delivery made, with the handle it went to. */
  readonly deliveries: { readonly handle: RunnerHandle; readonly delivery: RunnerDelivery }[] = [];
  /** Every message queued, with the handle it went to. */
  readonly queued: { readonly handle: RunnerHandle; readonly text: string }[] = [];
  /** What the next `queue` proves: `held` unless a test says otherwise. */
  queueOutcome: QueueOutcome = 'held';
  /** Every turn stop asked for, and every key one actually pressed (only ever a harness stop key). */
  readonly stops: { readonly handle: RunnerHandle; readonly stop: RunnerStop }[] = [];
  readonly pressed: { readonly handle: RunnerHandle; readonly key: string }[] = [];
  /** Whether the pane shows active work, as `stopTurn` reads it before deciding. */
  working = true;
  /** Set by a test: the closed failure the next `deliver` / `queue` / `stopTurn` rejects with, instead of writing. */
  fail: RunnerDeliveryFailure | undefined;
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
    this.#fail();
    if (!this.#live.has(handle)) throw new FakeRunnerFailure({ kind: 'not_ready', why: 'exited' });
    await delivery.beforeWrite?.();
    this.deliveries.push({ handle, delivery });
    return delivery.text.startsWith('/') ? 'handled-local' : 'turn-started';
  }
  async queue(handle: RunnerHandle, text: string): Promise<QueueOutcome> {
    this.#fail();
    if (!this.#live.has(handle)) throw new FakeRunnerFailure({ kind: 'not_ready', why: 'exited' });
    this.queued.push({ handle, text });
    return this.queueOutcome;
  }
  async stopTurn(handle: RunnerHandle, stop: RunnerStop): Promise<RunnerStopOutcome> {
    this.#fail();
    if (!this.#live.has(handle)) throw new FakeRunnerFailure({ kind: 'not_ready', why: 'exited' });
    this.stops.push({ handle, stop });
    if (!shouldPressStopKey(this.working, stop)) return { pressed: false, working: this.working };
    this.pressed.push({ handle, key: stop.key });
    return { pressed: true, working: false };
  }
  /**
   * The send path's pane look and composer acts (additive). A test sets what the pane shows (`pane`, `held`), and sees
   * every composer message cleared or submitted and every stop-and-wait. A handle with nothing live behind it observes
   * nothing, and a write to it rejects `not_ready`/`exited`, as `deliver` does.
   */
  pane: RunnerPaneObservation = { alive: true, dead: false, promptReady: true, activeWork: false };
  /** What `heldAt` answers; `'throw'` is a pane that cannot be read. */
  held: RunnerHeldAt | undefined | 'throw' = undefined;
  /** What the next `clearComposer` / `submitComposer` answers. */
  clearOutcome: RunnerComposerCleared = 'cleared';
  submitOutcome: RunnerComposerSubmitted = 'submitted';
  readonly cleared: { readonly handle: RunnerHandle; readonly text: string }[] = [];
  readonly submitted: { readonly handle: RunnerHandle; readonly text: string; readonly strict: boolean }[] = [];
  readonly stoppedActive: { readonly handle: RunnerHandle; readonly stop: RunnerStop }[] = [];
  async observe(handle: RunnerHandle): Promise<RunnerPaneObservation | undefined> {
    return this.#live.has(handle) ? this.pane : undefined;
  }
  async heldAt(handle: RunnerHandle, text: string): Promise<RunnerHeldAt | undefined> {
    void text;
    if (!this.#live.has(handle) || this.held === 'throw') throw new Error('the fake runner could not read the pane');
    return this.held;
  }
  async clearComposer(handle: RunnerHandle, text: string): Promise<RunnerComposerCleared> {
    this.#fail();
    if (!this.#live.has(handle)) throw new FakeRunnerFailure({ kind: 'not_ready', why: 'exited' });
    this.cleared.push({ handle, text });
    return this.clearOutcome;
  }
  async submitComposer(handle: RunnerHandle, text: string, strict = false): Promise<RunnerComposerSubmitted> {
    this.#fail();
    if (!this.#live.has(handle)) throw new FakeRunnerFailure({ kind: 'not_ready', why: 'exited' });
    this.submitted.push({ handle, text, strict });
    return this.submitOutcome;
  }
  async stopActiveTurn(handle: RunnerHandle, stop: RunnerStop): Promise<RunnerPaneObservation | undefined> {
    this.#fail();
    if (!this.#live.has(handle)) throw new FakeRunnerFailure({ kind: 'not_ready', why: 'exited' });
    this.stoppedActive.push({ handle, stop });
    if (shouldPressStopKey(this.working, stop)) this.pressed.push({ handle, key: stop.key });
    return this.pane;
  }
  /**
   * What `look` sees on each live handle's pane, set by a test (`frame` is the screen's identity); a live handle
   * with none set shows an idle prompt on frame `idle`. A handle with nothing live behind it shows nothing.
   */
  readonly screens = new Map<RunnerHandle, RunnerLook>();
  /** Every handle `look` was asked about, in order. */
  readonly looked: RunnerHandle[] = [];
  async look(handle: RunnerHandle): Promise<RunnerLook | undefined> {
    this.looked.push(handle);
    if (!this.#live.has(handle)) return undefined;
    return this.screens.get(handle) ?? { frame: 'idle', working: false, atPrompt: true, permission: false };
  }
  /**
   * What `gone` answers for a ferret with nothing live: `true` (proven gone), `false` (nothing proven), or a throw, set by
   * a test. A ferret with a live pane is never gone.
   */
  goneAnswer: boolean | 'throw' = true;
  /** Every ferret `gone` was asked about, in order. */
  readonly goneAsked: FerretId[] = [];
  async gone(ferret: FerretId): Promise<boolean> {
    this.goneAsked.push(ferret);
    if ([...this.#live.values()].some(live => live.ferret === ferret)) return false;
    if (this.goneAnswer === 'throw') throw new Error('the fake runner could not ask');
    return this.goneAnswer;
  }
  /** TEST ONLY: the host went down and took the runner's server with it: every pane is gone. */
  reboot(): void {
    this.#live.clear();
  }
  #fail(): void {
    const failure = this.fail;
    this.fail = undefined;
    if (failure !== undefined) throw new FakeRunnerFailure(failure);
  }
}

export interface RunnerSubject {
  readonly runner: Runner;
  readonly spec: RunSpec;
  /** A live process started outside this runner instance (a previous daemon), returned by handle. */
  adoptable(): Promise<RunnerHandle>;
  /** How many processes this runner has started (attach must not add one). */
  starts(): number;
  /**
   * Required of a runner that offers `stopTurn`: lets the suite set whether the pane behind a handle shows active work,
   * and see every key that actually reached it, so "only under the rule" is checked against the pane, not the answer.
   */
  readonly stopPane?: {
    working(handle: RunnerHandle, working: boolean): void | Promise<void>;
    keys(handle: RunnerHandle): readonly string[] | Promise<readonly string[]>;
  };
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
    test('harness-refusals: a handle with nothing behind it is answered as nothing typed, never as typed-unconfirmed', async () => {
      const subject = await make();
      const failure = await subject.runner.deliver('%99999' as RunnerHandle, { text: 'hello' }).then(
        () => undefined,
        (error: unknown) => runnerDeliveryFailure(error),
      );
      // A runner may leave the rejection unclassified; one that classifies it must say nothing was typed.
      if (failure !== undefined) expect(failure.kind).not.toBe('unconfirmed');
    });
    test('harness-refusals shouldPressStopKey: a turn stop presses only a harness stop key, and only under the rule', async () => {
      const subject = await make();
      const stopTurn = subject.runner.stopTurn?.bind(subject.runner);
      if (stopTurn === undefined) return;
      const pane = subject.stopPane;
      if (pane === undefined) throw new Error('a runner with stopTurn must give the suite stopPane to check the rule');
      const started = await subject.runner.start(subject.spec);
      if (!started.ok) throw new Error('start refused');
      const handle = started.value.handle;
      // Idle, with a key that is not harmless there (Codex quits on it): never pressed, and the pane got no key.
      await pane.working(handle, false);
      expect(await stopTurn(handle, { key: 'Escape', whenIdle: false })).toMatchObject({ pressed: false });
      expect(await pane.keys(handle)).toEqual([]);
      // Idle, with a key harmless there: pressed once.
      expect(await stopTurn(handle, { key: 'Escape', whenIdle: true })).toMatchObject({ pressed: true });
      expect(await pane.keys(handle)).toEqual(['Escape']);
      // Working: pressed once even when the key is not harmless at an idle prompt.
      await pane.working(handle, true);
      expect(await stopTurn(handle, { key: 'Escape', whenIdle: false })).toMatchObject({ pressed: true });
      const keys = await pane.keys(handle);
      expect(keys).toEqual(['Escape', 'Escape']);
      for (const key of keys) expect(HARNESS_STOP_KEYS).toContain(key as (typeof HARNESS_STOP_KEYS)[number]);
      await subject.runner.stop(handle, 'now');
    });
    test('harness-refusals: a turn stop at a handle with nothing behind it is not_ready/exited and starts nothing', async () => {
      const subject = await make();
      const stopTurn = subject.runner.stopTurn?.bind(subject.runner);
      if (stopTurn === undefined) return;
      const before = subject.starts();
      const gone = await stopTurn('%99999' as RunnerHandle, { key: 'Escape', whenIdle: true }).then(
        () => 'resolved' as const,
        (error: unknown) => runnerDeliveryFailure(error),
      );
      expect(gone).toEqual({ kind: 'not_ready', why: 'exited' });
      expect(subject.starts()).toBe(before);
    });
    test('a queue into a live ferret answers held, typed or left; to a handle with nothing behind it, rejects', async () => {
      const subject = await make();
      // Optional on the kind: a runner that cannot queue has nothing to prove here.
      if (subject.runner.queue === undefined) return;
      const started = await subject.runner.start(subject.spec);
      if (!started.ok) throw new Error('start refused');
      expect(['held', 'typed', 'left']).toContain(await subject.runner.queue(started.value.handle, 'hello'));
      const before = subject.starts();
      await expect(subject.runner.queue('%99999' as RunnerHandle, 'hello')).rejects.toThrow();
      expect(subject.starts()).toBe(before);
      await subject.runner.stop(started.value.handle, 'now');
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
  /** The harness's turn stop; a test sets it to `undefined` for a harness that names none. */
  turnStop: HarnessStop | undefined = { key: 'Escape', safeWhenIdle: true };
  /** The transcript this fake proves for a ferret (U5): a test sets one to prove it; a ferret with none has no transcript. */
  readonly transcripts = new Map<FerretId, { stamp: HarnessTranscriptStamp; records: readonly HarnessTailRecord[] }>();
  /** How many times each half of the transcript was asked for, so a test sees what a sample cost. */
  readonly stamped: FerretId[] = [];
  readonly tailed: FerretId[] = [];
  /**
   * What `launchSettings` answers for a ferret (W2-c): a test sets one, or an `Error` to make the harness throw. A ferret
   * with none is `unknown`. Set `launchSettings` itself to `undefined` for a harness that offers no comparison.
   */
  readonly launchAnswers = new Map<FerretId, HarnessLaunchSettings | Error>();
  /** Every ferret `launchSettings` was asked about, in order. */
  readonly launchAsked: FerretId[] = [];
  launchSettings: Harness['launchSettings'] = async (ferret: FerretId): Promise<HarnessLaunchSettings> => {
    this.launchAsked.push(ferret);
    const answer = this.launchAnswers.get(ferret);
    if (answer instanceof Error) throw answer;
    return answer ?? { kind: 'unknown' };
  };
  async transcriptStamp(ferret: FerretId): Promise<HarnessTranscriptStamp | undefined> {
    this.stamped.push(ferret);
    return this.transcripts.get(ferret)?.stamp;
  }
  async transcriptTail(ferret: FerretId, limit: number): Promise<HarnessTranscriptTail> {
    this.tailed.push(ferret);
    const found = this.transcripts.get(ferret);
    return found === undefined ? { kind: 'unresolved' } : { kind: 'read', records: found.records.slice(-limit) };
  }
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
    test('harness-refusals: a harness’s turn stop, when it names one, is a closed stop key — never C-c', async () => {
      const { harness } = await make();
      if (harness.turnStop === undefined) return;
      expect(HARNESS_STOP_KEYS).toContain(harness.turnStop.key);
      expect(harness.turnStop.key).not.toBe('C-c');
      expect(typeof harness.turnStop.safeWhenIdle).toBe('boolean');
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
  async resume(
    ferret: FerretId,
    message: string | undefined,
    _options: ResumeOptions,
  ): Promise<Result<FerretId, StartFailure>> {
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
  #worktrees: readonly ManagedWorktreeSummary[] = [];
  /** TEST ONLY: the managed worktree registry `managedWorktrees()` answers. */
  setManagedWorktrees(rows: readonly ManagedWorktreeSummary[]): void {
    this.#worktrees = rows;
  }
  async managedWorktrees(): Promise<readonly ManagedWorktreeSummary[]> {
    return this.#worktrees;
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
