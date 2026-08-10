import type { RuntimeModelChoice, SessionView } from '@ferretry/protocol';
import type { CoreAccount } from '../../../../src/lib/core/inventory.ts';
import { CodexRuntimeCatalogCache } from '../../../../src/lib/session/harness/codex-catalog-cache.ts';
import type { CodexPickerDrivePort, CodexPickerFrame } from '../../../../src/lib/session/harness/picker-drive.ts';
import type {
  RuntimeLaunchTarget,
  RuntimePaneObservation,
  RuntimeQuarantinePatch,
  RuntimeReference,
  RuntimeRepository,
} from '../../../../src/lib/session/runtime-control/types.ts';
import type { SessionId } from '../../../../src/lib/session-id.ts';
import type { InjectionOutcome } from '../../../../src/lib/tmux/delivery.ts';
import { sessionView } from '../../runtime/mounts/support.ts';

/**
 * Fakes for the runtime control service, and nothing from `src/adapters`.
 *
 * That exclusion is load-bearing rather than tidy: the unit ledger refuses a coverage path outside
 * `src/lib`, so one adapter import here would fail the whole tier. It is also the point of the
 * extraction — every collaborator below is a port the domain declared, so the decisions can be
 * proved without a pane, a process or a disk.
 */

export const NOW = '2026-08-06T00:00:00.000Z';

/** One journal or state write, in the order it happened. The ORDER is the assertion. */
export type RepositoryCall =
  | { readonly kind: 'quarantine'; readonly patch: RuntimeQuarantinePatch }
  | { readonly kind: 'journal'; readonly event: string; readonly data: Readonly<Record<string, unknown>> };

export interface FakeRepositoryOptions {
  readonly views?: readonly SessionView[];
  readonly launch?: RuntimeLaunchTarget | undefined;
  /** Anything not in here is a well-formed id nobody holds. `!` prefixes an unusable reference. */
  readonly held?: readonly string[];
}

export class FakeRuntimeRepository implements RuntimeRepository {
  readonly calls: RepositoryCall[] = [];
  #reads = 0;

  constructor(private readonly options: FakeRepositoryOptions = {}) {}

  /** `!` marks a reference that is not a usable id at all, which is a different refusal. */
  find(reference: string): RuntimeReference {
    if (reference.startsWith('!')) return { kind: 'invalid' };
    const held = this.options.held ?? ['s1'];
    return held.includes(reference) ? { kind: 'session', id: reference as SessionId } : { kind: 'missing' };
  }

  /** Successive reads answer successive views, so "re-read, never projected" is provable. */
  async view(): Promise<SessionView | undefined> {
    const views = this.options.views ?? [sessionView('s1')];
    const answer = views[Math.min(this.#reads, views.length - 1)];
    this.#reads += 1;
    return answer;
  }

  async launch(): Promise<RuntimeLaunchTarget | undefined> {
    return 'launch' in this.options
      ? this.options.launch
      : { tmuxSession: 'fy-s1', agent: '/opt/codex-auto', cwd: '/work/ferretry' };
  }

  async journal(_id: SessionId, event: string, data: Readonly<Record<string, unknown>>): Promise<void> {
    this.calls.push({ kind: 'journal', event, data });
  }

  async quarantine(_id: SessionId, patch: RuntimeQuarantinePatch): Promise<void> {
    this.calls.push({ kind: 'quarantine', patch });
  }
}

export class FakeRuntimePane {
  readonly stopped: string[] = [];
  constructor(
    private readonly observation: RuntimePaneObservation = { alive: true, dead: false, promptReady: true },
    private readonly stopFailure?: Error,
  ) {}

  async state(): Promise<RuntimePaneObservation> {
    return this.observation;
  }

  async stop(tmuxSession: string): Promise<void> {
    this.stopped.push(tmuxSession);
    if (this.stopFailure !== undefined) throw this.stopFailure;
  }
}

export class FakeRuntimeInjector {
  readonly delivered: [string, string][] = [];
  constructor(
    private readonly outcome: InjectionOutcome | Error = 'handled-local',
    private readonly onDeliver?: () => void,
  ) {}

  async deliver(tmuxSession: string, command: string): Promise<InjectionOutcome> {
    this.delivered.push([tmuxSession, command]);
    this.onDeliver?.();
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

/** A picker transport that records the keys it was asked for and can refuse at any stage. */
export class FakePickerTransport implements CodexPickerDrivePort {
  readonly keys: string[] = [];
  opens = 0;

  constructor(
    private readonly frames: readonly Partial<CodexPickerFrame>[] = [],
    private readonly openOutcome: InjectionOutcome = 'handled-local',
  ) {}

  async openPicker(): Promise<InjectionOutcome> {
    this.opens += 1;
    return this.openOutcome;
  }

  async readPane(): Promise<CodexPickerFrame> {
    const frame = this.frames[Math.min(this.keys.length, this.frames.length - 1)] ?? {};
    return { alive: true, dead: false, promptReady: false, visible: '', ...frame };
  }

  async sendKey(key: string): Promise<void> {
    this.keys.push(key);
  }
}

export const account = (overrides: Partial<CoreAccount> = {}): CoreAccount =>
  ({
    agent: 'claude-auto',
    available: true,
    defaultModel: 'opus',
    models: [{ id: 'opus', displayName: 'Opus', available: true }],
    ...overrides,
  }) as CoreAccount;

export class FakeAccounts {
  constructor(private readonly answer: readonly CoreAccount[] | Error = [account()]) {}
  async accounts(): Promise<readonly CoreAccount[]> {
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

/** A catalog cache over a probe the test controls, so a broken account is one line. */
export const catalogCache = (probe: () => Promise<readonly RuntimeModelChoice[]>): CodexRuntimeCatalogCache =>
  new CodexRuntimeCatalogCache(async () => await probe());

/**
 * A real per-key queue that also records overlap.
 *
 * It genuinely serialises rather than merely counting, because the assertion this exists for — two
 * concurrent first attempts must not both reach the harness — is only true if the queue holds. A
 * counter over a fake that ran everything at once would report `peak: 2` and blame the service for
 * the test double's own behaviour.
 */
export class RecordingSerial {
  depth = 0;
  peak = 0;
  entered = 0;
  readonly #tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const mine = previous.then(async () => {
      this.entered += 1;
      this.depth += 1;
      this.peak = Math.max(this.peak, this.depth);
      try {
        return await work();
      } finally {
        this.depth -= 1;
      }
    });
    this.#tails.set(
      key,
      mine.catch(() => undefined),
    );
    return await mine;
  }

  async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    return await work();
  }
}

export const CODEX_VIEW = (state: Readonly<Record<string, unknown>> = {}): SessionView =>
  sessionView('s1', { harness: 'codex', agent: 'codex-auto' }, { status: 'running', promptReady: true, ...state });

export const CLAUDE_VIEW = (state: Readonly<Record<string, unknown>> = {}): SessionView =>
  sessionView('s1', { harness: 'claude', agent: 'claude-auto' }, { status: 'running', promptReady: true, ...state });
