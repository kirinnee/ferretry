import { ok } from '@ferretry/std';
import { targetRef } from '@ferretry/core-vault/contract';
import type { ActRunner, HoldDecision } from '@ferretry/kernel/contract';
import { testActRunner, TestMintedIds } from '@ferretry/kernel/testing';
import type {
  DeliveryOutcome,
  FerretRecord,
  FerretsApi,
  RunnerDelivery,
  RunnerHandle,
  RunnerStop,
  RunnerStopOutcome,
} from '../../../../contract/index.ts';
import {
  emptyChildEnvironment,
  fenced,
  FakeHarness,
  FakeRunner,
  FakeRunnerFailure,
  ferretId,
  T0,
} from '../../../../contract/testing/index.ts';
import { type FerretSessionPort, FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';

/** A runner that also records every interrupt it is asked for. */
class SignalRunner extends FakeRunner {
  readonly signals: { readonly handle: RunnerHandle; readonly signal: 'interrupt' | 'terminate' }[] = [];
  override async signal(handle?: RunnerHandle, signal?: 'interrupt' | 'terminate'): Promise<void> {
    if (handle !== undefined && signal !== undefined) this.signals.push({ handle, signal });
  }
}

/**
 * A runner that, like `TmuxRunner`, guards EACH write of a delivery and its one stop keystroke with
 * `kernel.act(<its pane>, 'keys')` on the act runner it was given, and rejects a write whose act is refused before any
 * keys are typed with the contract's closed `held` failure, carrying the act's code.
 */
export class ActingRunner extends SignalRunner {
  /** The keys typed, in order, per delivery. */
  readonly typed: string[] = [];
  constructor(private readonly guard: ActRunner) {
    super();
  }
  async #write(handle: RunnerHandle, write: string): Promise<void> {
    const acted = await this.guard(targetRef('terminal', handle), 'keys', async () => {
      this.typed.push(write);
      return { status: 'done' as const };
    });
    if (!acted.ok) throw new FakeRunnerFailure({ kind: 'held', code: acted.error.refused });
  }
  override async deliver(handle: RunnerHandle, delivery: RunnerDelivery): Promise<DeliveryOutcome> {
    for (const write of ['load-buffer', 'paste-buffer', 'send-keys']) await this.#write(handle, write);
    return await super.deliver(handle, delivery);
  }
  override async stopTurn(handle: RunnerHandle, stop: RunnerStop): Promise<RunnerStopOutcome> {
    if (this.working || stop.whenIdle) await this.#write(handle, `send-keys ${stop.key}`);
    return await super.stopTurn(handle, stop);
  }
}

/**
 * The kernel's real act rules over a test host: ONE serial queue per target, then the hold decision for that target.
 * `hold` names the pane keys that are held.
 */
function queueingAct(hold: AdditivesOptions['queueing'] = { held: new Set() }): ActRunner {
  return testActRunner({
    holds: () => ({
      decide: (target): HoldDecision => (hold.held.has(target.key) ? { refused: hold.code ?? 'held' } : 'allow'),
    }),
    actor: () => 'owner-tools',
    minted: new TestMintedIds(),
  });
}

export interface AdditivesOptions {
  /** The state the seeded ferret `fern` is in. */
  readonly state?: FerretRecord['state'];
  /** Seed no ferret at all (start tests). */
  readonly empty?: boolean;
  /** Bind a QUEUEING act runner (one serial queue per pane) and a runner that acts per write, as the real ones do. */
  readonly queueing?: { readonly held: Set<string>; readonly code?: 'held' | 'quarantined' | 'input_pending' };
  /** The ferret's session files, when a test binds them (unbound by default, as before). */
  readonly session?: FerretSessionPort;
}

/** A Ferrets service over fakes; with `queueing`, a runner that acts per write on the kernel's real act rules. */
export function additivesFixture(options: AdditivesOptions = {}) {
  const id = ferretId('fern');
  const record: FerretRecord = {
    format: 1,
    id,
    name: 'fern',
    role: 'lead',
    harness: 'claude-code',
    runner: 'tmux',
    folder: '/work',
    state: options.state ?? 'stopped',
    createdAt: T0,
    stateAt: T0,
  };
  const registry = new FerretRegistry(options.empty === true ? [] : [record]);
  const tokens = new FerretTokenDirectory();
  // The act runner the RUNNER guards its own writes with (Ferrets holds none: the seam never acts itself).
  const act = options.queueing === undefined ? undefined : queueingAct(options.queueing);
  const runner = act === undefined ? new SignalRunner() : new ActingRunner(act);
  const harness = new FakeHarness();
  const history: { readonly type: string; readonly data: Readonly<Record<string, unknown>> }[] = [];
  const ports: FerretsPorts = {
    now: () => T0,
    newId: () => id,
    newName: () => 'fern',
    save: async () => {},
    saveTokens: async () => {},
    harness: () => harness,
    harnessKeys: () => ['claude-code'],
    runner: () => runner,
    decide: async () => ({ allow: true }),
    launchParts: () => [],
    sitrepSources: () => [],
    instructions: () => [],
    folder: path => ok(fenced(path)),
    changed: () => {},
    history: async (_ferret, type, data) => {
      history.push({ type, data });
    },
    vault: { childEnvironment: async () => ok(emptyChildEnvironment()) },
    asks: { open: async () => [] },
    ...(options.session === undefined ? {} : { session: options.session }),
  };
  const service = new FerretsService(registry, tokens, ports);
  return {
    id,
    registry,
    tokens,
    runner,
    harness,
    ports,
    service,
    history,
    /** The queueing act runner the runner writes through, when `queueing` was asked for. */
    act,
    /** The service as the port other plugins see. */
    api: service as FerretsApi,
  };
}
