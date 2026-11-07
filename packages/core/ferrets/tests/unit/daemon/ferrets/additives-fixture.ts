import { ok } from '@ferretry/std';
import { targetRef } from '@ferretry/core-vault/contract';
import type { ActRunner, HoldDecision, TargetRef } from '@ferretry/kernel/contract';
import { testActRunner, TestMintedIds } from '@ferretry/kernel/testing';
import type {
  DeliveryOutcome,
  FerretRecord,
  FerretsApi,
  RunnerDelivery,
  RunnerHandle,
} from '../../../../contract/index.ts';
import {
  emptyChildEnvironment,
  fenced,
  FakeHarness,
  FakeRunner,
  ferretId,
  T0,
} from '../../../../contract/testing/index.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';

/** One recorded act: what the harness seam asked the act runner to do. */
interface ActedRecord {
  readonly target: TargetRef;
  readonly op: string;
}

/** A runner that also records every interrupt it is asked for. */
class SignalRunner extends FakeRunner {
  readonly signals: { readonly handle: RunnerHandle; readonly signal: 'interrupt' | 'terminate' }[] = [];
  override async signal(handle?: RunnerHandle, signal?: 'interrupt' | 'terminate'): Promise<void> {
    if (handle !== undefined && signal !== undefined) this.signals.push({ handle, signal });
  }
}

/**
 * A runner that, like `TmuxRunner`, guards EACH write of a delivery with `kernel.act(<its pane>, 'keys')` on the act
 * runner it was given, and rejects a delivery whose act is refused before any keys are typed.
 */
export class ActingRunner extends SignalRunner {
  /** The keys typed, in order, per delivery. */
  readonly typed: string[] = [];
  constructor(private readonly guard: () => ActRunner) {
    super();
  }
  override async deliver(handle: RunnerHandle, delivery: RunnerDelivery): Promise<DeliveryOutcome> {
    for (const write of ['load-buffer', 'paste-buffer', 'send-keys']) {
      const acted = await this.guard()(targetRef('terminal', handle), 'keys', async () => {
        this.typed.push(write);
        return { status: 'done' as const };
      });
      if (!acted.ok) throw new Error(`the pane refused the delivery: ${acted.error.refused}`);
    }
    return await super.deliver(handle, delivery);
  }
}

/**
 * The kernel's real act rules over a test host: ONE serial queue per target, then the hold decision for that target.
 * `hold` names the pane keys that are held.
 */
function queueingAct(hold: { readonly held: Set<string> } = { held: new Set() }): ActRunner {
  return testActRunner({
    holds: () => ({
      decide: (target): HoldDecision => (hold.held.has(target.key) ? { refused: 'held' } : 'allow'),
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
  readonly queueing?: { readonly held: Set<string> };
}

/** A Ferrets service over fakes, with a recording act runner that runs the write unless `refuse` says otherwise. */
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
  const actOf = (): ActRunner => ports.act as ActRunner;
  const runner = options.queueing === undefined ? new SignalRunner() : new ActingRunner(actOf);
  const harness = new FakeHarness();
  const acted: ActedRecord[] = [];
  const history: { readonly type: string; readonly data: Readonly<Record<string, unknown>> }[] = [];
  const control = { refuse: undefined as 'held' | 'quarantined' | undefined };
  const act: ActRunner = async (target, op, fn) => {
    acted.push({ target, op });
    if (control.refuse !== undefined) return { ok: false, error: { refused: control.refuse } } as never;
    return { ok: true, value: await fn({ answer: 'allow', actor: 'owner-tools' }) } as never;
  };
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
    act: options.queueing === undefined ? act : queueingAct(options.queueing),
    vault: { childEnvironment: async () => ok(emptyChildEnvironment()) },
    asks: { open: async () => [] },
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
    acted,
    history,
    control,
    /** The service as the port other plugins see. */
    api: service as FerretsApi,
  };
}
