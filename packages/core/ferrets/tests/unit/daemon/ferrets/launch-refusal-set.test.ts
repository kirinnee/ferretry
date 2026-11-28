import { describe, expect, test } from 'bun:test';
import { factsOfKey } from '../../../support/daemon/harness-facts.ts';
import { err, ok, type Result } from '@ferretry/std';
import { ConversationIdSchema, ConversationLeaseStore } from '../../../../contract/conversation-lease.ts';
import {
  type FerretRecord,
  LaunchRefusal,
  PERSON_ORIGIN,
  type RunnerHandle,
  type RunSpec,
} from '../../../../contract/index.ts';
import type { LaunchSpec } from '../../../../contract/index.ts';
import { emptyChildEnvironment, FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import type { FerretLaunchLeases } from '../../../../daemon/lib/ferrets/launch-leases.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import {
  ConversationLeases,
  registryLeaseSessions,
} from '../../../../daemon/lib/session/lifecycle/conversation-leases.ts';
import { parseSessionId } from '../../../../daemon/lib/session-id.ts';
import { MemoryLeaseDisk } from '../../../support/daemon/memory-lease-disk.ts';
import { additivesFixture } from './additives-fixture.ts';

/**
 * PIN (C58 H5 U6a): every way a launch is refused, and exactly what each leaves behind. Written against the base BEFORE
 * the launch's lease check moves into a guard list (U6b) and its pane variables into session stores (U6c), so those
 * moves are proven to change no answer, no ordering and no side effect.
 *
 * One row per refusal (plus the one launch whose conversation the harness disproves). A row asserts what the caller is
 * told (`ok`, `code`, the whole `reason`) AND the ordered log of every port the launch touched: session files, harness,
 * vault, lease store (claim / move / release), tokens, runner, launch records and the ferret's saved record. The values
 * are inline literals: a change to any of them is a change to what a launch does, and must be made on purpose.
 */

/** What the owner is told for each closed runner refusal: the next thing to check, never a bare code. */
const UNAVAILABLE_SENTENCE =
  'the runner could not be reached on this machine, so the ferret was not started: check that it is installed and running, then try again';
const FAILED_SENTENCE =
  'the runner could not open a pane for the ferret, so it was not started: a pane with its name may still be running (stop it), or the runner refused the launch (see the daemon log), then try again';
const LIMITS_SENTENCE =
  'the machine\x27s limits left no room for the ferret, so it was not started: stop another ferret or raise the cap in limits.yaml, then try again';

const NOW = new Date('2026-11-16T10:00:00.000Z');
const OLD = 'conv-old';
const OTHER = parseSessionId('mw7bp89h-61f11260');

type Started = Awaited<ReturnType<FakeHarness['start']>>;

/** A runner that logs every pane it opens or stops, can hide the pane's pid, and can fail to stop. */
class LoggedRunner extends FakeRunner {
  hidePid = false;
  failStop = false;
  constructor(private readonly log: string[]) {
    super();
  }
  override async start(spec: RunSpec) {
    this.log.push('runner.start');
    const started = await super.start(spec);
    if (!started.ok || !this.hidePid) return started;
    const { pid: _pid, ...rest } = started.value;
    return ok(rest);
  }
  override async stop(handle: RunnerHandle): Promise<void> {
    this.log.push('runner.stop');
    if (this.failStop) throw new Error('tmux is unreachable');
    await super.stop(handle);
  }
}

/** A harness that logs what it is asked, and can disprove a conversation or refuse to start. */
class LoggedHarness extends FakeHarness {
  refuse: 'real_harness' | 'unavailable' | 'failed' | 'limits' | undefined;
  prepareFails: 'refusal' | undefined;
  declare hasConversation: ((spec: LaunchSpec, conversation: string) => Promise<boolean | undefined>) | undefined;
  constructor(private readonly log: string[]) {
    super();
  }
  override async prepareHome(spec: LaunchSpec) {
    this.log.push('harness.prepareHome');
    if (this.prepareFails === 'refusal') throw new LaunchRefusal('the home of this ferret is not safe to write');
    return await super.prepareHome(spec);
  }
  override async start(...args: Parameters<FakeHarness['start']>): Promise<Started> {
    this.log.push('harness.start');
    if (this.refuse !== undefined) return err(this.refuse);
    return await super.start(...args);
  }
  override async resume(...args: Parameters<FakeHarness['resume']>) {
    this.log.push(`harness.resume(${args[3]})`);
    if (this.refuse !== undefined) return err(this.refuse);
    return await super.resume(...args);
  }
}

interface Options {
  /** The seeded ferret has a conversation to resume (`conv-old`). */
  readonly resumable?: boolean;
  /** Seed no ferret (a start). */
  readonly empty?: boolean;
  /** The seeded ferret is on a login. */
  readonly login?: boolean;
}

function rig(options: Options = {}) {
  const log: string[] = [];
  const base = additivesFixture({ ...(options.empty === true ? { empty: true } : {}) });
  const seeded = base.registry.get(base.id) as FerretRecord | undefined;
  if (seeded !== undefined)
    base.registry.put({
      ...seeded,
      ...(options.resumable === true ? { harnessConversation: OLD } : {}),
      ...(options.login === true ? { login: 'work' } : {}),
    });
  const runner = new LoggedRunner(log);
  const harness = new LoggedHarness(log);
  const disk = new MemoryLeaseDisk();
  const store = new ConversationLeaseStore(disk, () => NOW);
  const real = new ConversationLeases(
    store,
    registryLeaseSessions(base.registry, async () => ({ status: 'running' }), factsOfKey),
    4000,
  );
  /** The real leases, logged; a row can make any call fail, or let another writer in between two calls. */
  const control: {
    claimFails: boolean;
    afterClaim: (() => Promise<void>) | undefined;
    boundBreaks: boolean;
    stampFails: boolean;
    prepareFails: boolean;
    cutOffAtPrepare: boolean;
  } = {
    claimFails: false,
    afterClaim: undefined,
    boundBreaks: false,
    stampFails: false,
    prepareFails: false,
    cutOffAtPrepare: false,
  };
  const leases: FerretLaunchLeases = {
    claimConversation: async (ferret, conversation) => {
      log.push(`lease.claim(${conversation})`);
      if (control.claimFails) throw new Error('the lease folder is unreadable at /secret/path');
      await real.claimConversation(ferret, conversation);
      await control.afterClaim?.();
    },
    moveConversationToPane: async (ferret, conversation, pid) => {
      log.push(`lease.move(${conversation},${pid})`);
      await real.moveConversationToPane(ferret, conversation, pid);
    },
    release: async ferret => {
      log.push('lease.release');
      await real.release(ferret);
    },
  };
  const ports: FerretsPorts = {
    ...base.ports,
    harness: () => harness,
    runner: () => runner,
    leases,
    save: async record => {
      log.push(`save(${record.state})`);
    },
    saveTokens: async entries => {
      log.push(`saveTokens(${entries.length})`);
    },
    endWait: async () => {
      log.push('endWait');
    },
    bindFolder: async () =>
      ok({
        insideStateHome: false,
        verify: async (): Promise<Result<void, string>> => {
          log.push('bound.verify');
          return control.boundBreaks ? err('the launch folder is not the one that was checked') : ok(undefined);
        },
      }),
    vault: {
      childEnvironment: async () => {
        log.push('vault.childEnvironment');
        return ok(emptyChildEnvironment());
      },
    },
    launchEnvironment: {
      write: async () => {
        log.push('launchEnvironment.write');
      },
    },
    launchSections: {
      write: async () => {
        log.push('launchSections.write');
      },
      forget: async () => {
        log.push('launchSections.forget');
      },
    },
    session: {
      prepare: async () => {
        log.push('session.prepare');
        if (control.prepareFails) throw new Error('the folder is /secret/path');
        if (control.cutOffAtPrepare) base.tokens.cutOff(base.id, NOW as never);
      },
      stamp: async () => {
        log.push('session.stamp');
        if (control.stampFails) throw new Error('the stamp is at /secret/path');
      },
      carry: async () => {
        log.push('session.carry');
      },
    },
  };
  const service = () => new FerretsService(base.registry, base.tokens, ports);
  return { ...base, log, runner, harness, disk, control, ports, leases, real, service };
}
type Rig = ReturnType<typeof rig>;

/** Another live session writes `conversation`. */
const holdByOther = async (f: Rig, conversation: string) =>
  await f.disk.write(
    'claude',
    ConversationIdSchema.parse(conversation),
    `${JSON.stringify({
      v: 1,
      harness: 'claude',
      conversation,
      holder: { pid: 9, start: 1, session: OTHER },
      since: '2026-11-16T09:00:00.000Z',
    })}\n`,
  );

interface Row {
  readonly name: string;
  readonly options?: Options;
  readonly kind: 'resume' | 'start';
  readonly start?: { readonly harnessConversation?: string };
  readonly arrange?: (f: Rig) => void | Promise<void>;
  readonly answer: { readonly ok: true } | { readonly ok: false; readonly code: string; readonly reason: string };
  /** Every port call the launch made, in order, joined by ` > ` (empty: none). */
  readonly log: string;
  /** What else is true afterwards: the ferret's own state and who holds the conversation. */
  readonly state: FerretRecord['state'];
  /** The ferret still names its pane (a running pane, or one that could not be stopped, is never forgotten). */
  readonly handleKept?: true;
  readonly holder?: { readonly conversation: string; readonly session: string | undefined };
}

const ROWS: readonly Row[] = [
  // ── the lease check ────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: 'lease held by another live writer (a resume)',
    options: { resumable: true },
    kind: 'resume',
    arrange: async f => await holdByOther(f, OLD),
    answer: {
      ok: false,
      code: 'refused',
      reason:
        'conversation conv-old is being written by session mw7bp89h-61f11260 since 2026-11-16 09:00 UTC: stop or resume session mw7bp89h-61f11260 instead; only one writer may hold a conversation at a time',
    },
    log: 'save(starting) > session.prepare > session.carry > saveTokens(1) > harness.prepareHome > vault.childEnvironment > launchEnvironment.write > bound.verify > lease.claim(conv-old) > saveTokens(1) > save(stopped) > endWait > lease.release',
    state: 'stopped',
    holder: { conversation: OLD, session: OTHER },
  },
  {
    name: 'lease held by another live writer (a start bound to a conversation)',
    options: { empty: true },
    kind: 'start',
    start: { harnessConversation: 'conv-bound' },
    arrange: async f => await holdByOther(f, 'conv-bound'),
    answer: {
      ok: false,
      code: 'refused',
      reason:
        'conversation conv-bound is being written by session mw7bp89h-61f11260 since 2026-11-16 09:00 UTC: stop or resume session mw7bp89h-61f11260 instead; only one writer may hold a conversation at a time',
    },
    log: 'save(starting) > session.prepare > session.stamp > saveTokens(1) > harness.prepareHome > vault.childEnvironment > launchEnvironment.write > bound.verify > lease.claim(conv-bound) > saveTokens(1) > save(stopped) > endWait > lease.release',
    state: 'stopped',
    holder: { conversation: 'conv-bound', session: OTHER },
  },
  {
    name: 'lease store throws on the claim (its own text is never quoted)',
    options: { resumable: true },
    kind: 'resume',
    arrange: f => {
      f.control.claimFails = true;
    },
    answer: {
      ok: false,
      code: 'failed',
      reason: 'the ferret was not started: whether another session is writing its conversation could not be checked',
    },
    log: 'save(starting) > session.prepare > session.carry > saveTokens(1) > harness.prepareHome > vault.childEnvironment > launchEnvironment.write > bound.verify > lease.claim(conv-old) > saveTokens(1) > save(stopped) > endWait > lease.release',
    state: 'stopped',
  },
  {
    name: 'pane hides its pid: stopped and released, never left writing an unleased conversation',
    options: { resumable: true },
    kind: 'resume',
    arrange: f => {
      f.runner.hidePid = true;
    },
    answer: {
      ok: false,
      code: 'failed',
      reason:
        'the ferret was stopped: its conversation could not be kept for it, and a second writer on it would corrupt it',
    },
    log: 'save(starting) > session.prepare > session.carry > saveTokens(1) > harness.prepareHome > vault.childEnvironment > launchEnvironment.write > bound.verify > lease.claim(conv-old) > harness.resume(conv-old) > runner.start > lease.move(conv-old,undefined) > saveTokens(1) > runner.stop > save(stopped) > endWait > lease.release',
    state: 'stopped',
  },
  {
    name: 'pane hides its pid AND cannot be stopped: the lease stays held',
    options: { resumable: true },
    kind: 'resume',
    arrange: f => {
      f.runner.hidePid = true;
      f.runner.failStop = true;
    },
    answer: {
      ok: false,
      code: 'runner_unavailable',
      reason: 'the failed launch still has a process that could not be stopped',
    },
    log: 'save(starting) > session.prepare > session.carry > saveTokens(1) > harness.prepareHome > vault.childEnvironment > launchEnvironment.write > bound.verify > lease.claim(conv-old) > harness.resume(conv-old) > runner.start > lease.move(conv-old,undefined) > saveTokens(1) > runner.stop > save(starting)',
    state: 'starting',
    handleKept: true,
    holder: { conversation: OLD, session: 'fern' },
  },
  {
    name: 'another writer takes the conversation between the claim and the move',
    options: { resumable: true },
    kind: 'resume',
    arrange: f => {
      f.control.afterClaim = async () => await holdByOther(f, OLD);
    },
    answer: {
      ok: false,
      code: 'refused',
      reason:
        'conversation conv-old is being written by session mw7bp89h-61f11260 since 2026-11-16 09:00 UTC: stop or resume session mw7bp89h-61f11260 instead; only one writer may hold a conversation at a time',
    },
    log: 'save(starting) > session.prepare > session.carry > saveTokens(1) > harness.prepareHome > vault.childEnvironment > launchEnvironment.write > bound.verify > lease.claim(conv-old) > harness.resume(conv-old) > runner.start > lease.move(conv-old,1001) > saveTokens(1) > runner.stop > save(stopped) > endWait > lease.release',
    state: 'stopped',
    holder: { conversation: OLD, session: OTHER },
  },
  {
    name: 'a conversation the harness disproves is not claimed: a new one starts and is moved onto the pane',
    options: { resumable: true },
    kind: 'resume',
    arrange: f => {
      f.harness.hasConversation = async () => false;
    },
    answer: { ok: true },
    log: 'save(starting) > session.prepare > session.carry > saveTokens(1) > harness.prepareHome > vault.childEnvironment > launchEnvironment.write > bound.verify > harness.start > runner.start > lease.move(conv-fern,1001) > launchSections.write > save(working)',
    state: 'working',
    handleKept: true,
    holder: { conversation: 'conv-fern', session: 'fern' },
  },
  // ── refused before the lease is asked ──────────────────────────────────────────────────────────────────────────
  {
    name: 'the launch folder is not the one that was checked (the claim is never made)',
    options: { resumable: true },
    kind: 'resume',
    arrange: f => {
      f.control.boundBreaks = true;
    },
    answer: { ok: false, code: 'refused', reason: 'the launch folder is not the one that was checked' },
    log: 'save(starting) > session.prepare > session.carry > saveTokens(1) > harness.prepareHome > vault.childEnvironment > launchEnvironment.write > bound.verify > saveTokens(1) > save(stopped) > endWait > lease.release',
    state: 'stopped',
  },
  {
    name: 'the owner cut the ferret off while the launch was starting',
    options: { resumable: true },
    kind: 'resume',
    arrange: f => {
      f.control.cutOffAtPrepare = true;
    },
    answer: {
      ok: false,
      code: 'refused',
      reason: 'the owner cut off this ferret; a confirmed owner resume is required',
    },
    log: 'save(starting) > session.prepare > session.carry > save(stopped) > endWait > lease.release',
    state: 'stopped',
  },
  {
    name: 'the harness is off',
    options: { resumable: true },
    kind: 'resume',
    arrange: f => {
      f.ports.harness = () => undefined;
    },
    answer: { ok: false, code: 'harness_unavailable', reason: 'claude-code is off' },
    log: 'save(starting) > session.prepare > session.carry > save(stopped) > endWait > lease.release',
    state: 'stopped',
  },
  {
    name: 'the login environment cannot be read',
    options: { resumable: true, login: true },
    kind: 'resume',
    arrange: f => {
      f.ports.loginEnv = async () => err('the login work has no environment file, so the ferret was not started');
    },
    answer: {
      ok: false,
      code: 'login_unavailable',
      reason: 'the login work has no environment file, so the ferret was not started',
    },
    log: 'save(starting) > session.prepare > session.carry > save(stopped) > endWait > lease.release',
    state: 'stopped',
  },
  {
    name: 'the login launch environment cannot be read',
    options: { resumable: true, login: true },
    kind: 'resume',
    arrange: f => {
      f.ports.loginLaunchEnv = async () => err('the login work has no store, so the ferret was not started');
    },
    answer: {
      ok: false,
      code: 'login_unavailable',
      reason: 'the login work has no store, so the ferret was not started',
    },
    log: 'save(starting) > session.prepare > session.carry > save(stopped) > endWait > lease.release',
    state: 'stopped',
  },
  {
    name: 'the login credential is unavailable',
    options: { resumable: true, login: true },
    kind: 'resume',
    arrange: f => {
      f.ports.loginCredential = async () => ({
        kind: 'unavailable',
        sentence: 'the login work has no sign-in file, so the ferret was not started',
      });
    },
    answer: {
      ok: false,
      code: 'login_unavailable',
      reason: 'the login work has no sign-in file, so the ferret was not started',
    },
    log: 'save(starting) > session.prepare > session.carry > save(stopped) > endWait > lease.release',
    state: 'stopped',
  },
  {
    name: 'a required launch part throws (its text is never quoted)',
    options: { resumable: true },
    kind: 'resume',
    arrange: f => {
      f.ports.launchParts = () => [
        {
          required: true,
          parts: async () => {
            throw new Error('the pinned file is at /secret/path');
          },
        },
      ];
    },
    answer: {
      ok: false,
      code: 'failed',
      reason: 'a part of this launch that must be checked could not be read, so the ferret was not started',
    },
    log: 'save(starting) > session.prepare > session.carry > saveTokens(1) > saveTokens(1) > save(stopped) > endWait > lease.release',
    state: 'stopped',
  },
  {
    name: 'the harness refuses to prepare the home with a sentence',
    options: { resumable: true },
    kind: 'resume',
    arrange: f => {
      f.harness.prepareFails = 'refusal';
    },
    answer: { ok: false, code: 'failed', reason: 'the home of this ferret is not safe to write' },
    log: 'save(starting) > session.prepare > session.carry > saveTokens(1) > harness.prepareHome > saveTokens(1) > save(stopped) > endWait > lease.release',
    state: 'stopped',
  },
  {
    name: 'a secret the launch names is unknown',
    options: { resumable: true },
    kind: 'resume',
    arrange: f => {
      f.ports.vault = { childEnvironment: async () => err({ unknown: ['API_KEY', 'DB_URL'] }) as never };
    },
    answer: { ok: false, code: 'login_unavailable', reason: 'unknown secrets: API_KEY, DB_URL' },
    log: 'save(starting) > session.prepare > session.carry > saveTokens(1) > harness.prepareHome > saveTokens(1) > save(stopped) > endWait > lease.release',
    state: 'stopped',
  },
  {
    name: 'the ferret session folder cannot be prepared (a resume)',
    options: { resumable: true },
    kind: 'resume',
    arrange: f => {
      f.control.prepareFails = true;
    },
    answer: {
      ok: false,
      code: 'failed',
      reason: "the ferret's private session folder could not be made private, so it was not started",
    },
    log: 'save(starting) > session.prepare > save(stopped) > endWait > lease.release',
    state: 'stopped',
  },
  {
    name: 'the spawn stamp cannot be written (a start)',
    options: { empty: true },
    kind: 'start',
    arrange: f => {
      f.control.stampFails = true;
    },
    answer: {
      ok: false,
      code: 'failed',
      reason: 'where this ferret came from could not be recorded, so it was not started',
    },
    log: 'save(starting) > session.prepare > session.stamp > save(stopped) > endWait > lease.release',
    state: 'stopped',
  },
  {
    name: 'no runner is on',
    options: { resumable: true },
    kind: 'resume',
    arrange: f => {
      f.ports.runner = () => undefined;
    },
    answer: { ok: false, code: 'runner_unavailable', reason: 'no runner plugin is on' },
    log: 'save(starting) > session.prepare > session.carry > save(stopped) > endWait > lease.release',
    state: 'stopped',
  },
  // ── refused by the harness itself (the lease was claimed first and is freed with the stop) ─────────────────────
  {
    name: 'a test-mode daemon refused a real harness',
    options: { resumable: true },
    kind: 'resume',
    arrange: f => {
      f.harness.refuse = 'real_harness';
    },
    answer: {
      ok: false,
      code: 'refused',
      reason:
        'test mode refused to launch a real claude/codex: a test must put a fake claude/codex first on the daemon PATH, and set no PATH of its own, before it starts a session',
    },
    log: 'save(starting) > session.prepare > session.carry > saveTokens(1) > harness.prepareHome > vault.childEnvironment > launchEnvironment.write > bound.verify > lease.claim(conv-old) > harness.resume(conv-old) > saveTokens(1) > save(stopped) > endWait > lease.release',
    state: 'stopped',
  },
  {
    name: 'the harness cannot reach its runner',
    options: { resumable: true },
    kind: 'resume',
    arrange: f => {
      f.harness.refuse = 'unavailable';
    },
    answer: { ok: false, code: 'runner_unavailable', reason: UNAVAILABLE_SENTENCE },
    log: 'save(starting) > session.prepare > session.carry > saveTokens(1) > harness.prepareHome > vault.childEnvironment > launchEnvironment.write > bound.verify > lease.claim(conv-old) > harness.resume(conv-old) > saveTokens(1) > save(stopped) > endWait > lease.release',
    state: 'stopped',
  },
  {
    name: 'the runner could not open a pane (a bare failed)',
    options: { resumable: true },
    kind: 'resume',
    arrange: f => {
      f.harness.refuse = 'failed';
    },
    answer: { ok: false, code: 'failed', reason: FAILED_SENTENCE },
    log: 'save(starting) > session.prepare > session.carry > saveTokens(1) > harness.prepareHome > vault.childEnvironment > launchEnvironment.write > bound.verify > lease.claim(conv-old) > harness.resume(conv-old) > saveTokens(1) > save(stopped) > endWait > lease.release',
    state: 'stopped',
  },
  {
    name: 'the runner refused the launch for the machine\x27s limits',
    options: { resumable: true },
    kind: 'resume',
    arrange: f => {
      f.harness.refuse = 'limits';
    },
    answer: { ok: false, code: 'failed', reason: LIMITS_SENTENCE },
    log: 'save(starting) > session.prepare > session.carry > saveTokens(1) > harness.prepareHome > vault.childEnvironment > launchEnvironment.write > bound.verify > lease.claim(conv-old) > harness.resume(conv-old) > saveTokens(1) > save(stopped) > endWait > lease.release',
    state: 'stopped',
  },
];

describe('every way a launch is refused is told the same, in the same order, leaving the same behind', () => {
  for (const row of ROWS)
    test(`should answer and log as pinned: ${row.name}`, async () => {
      // Arrange
      const f = rig(row.options);
      await row.arrange?.(f);
      const service = f.service();

      // Act
      const answer =
        row.kind === 'resume'
          ? await service.resume(f.id, undefined, { origin: PERSON_ORIGIN })
          : await service.start({ by: 'owner', folder: '/work', harness: 'claude-code', ...row.start }, PERSON_ORIGIN);

      // Assert
      expect(answer.ok ? { ok: true } : { ok: false, ...answer.error }).toEqual(row.answer);
      expect(f.log.join(' > ')).toBe(row.log);
      expect(f.registry.get(f.id)?.state).toBe(row.state);
      expect(f.registry.get(f.id)?.handle !== undefined).toBe(row.handleKept === true);
      if (row.holder !== undefined)
        expect(f.disk.lease('claude', row.holder.conversation)?.holder.session).toBe(row.holder.session);
    });
});
