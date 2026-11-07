import { ok } from '@ferretry/std';
import type { ActRunner, TargetRef } from '@ferretry/kernel/contract';
import type { FerretRecord, FerretsApi, RunnerHandle } from '../../../../contract/index.ts';
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
export interface ActedRecord {
  readonly target: TargetRef;
  readonly op: string;
}

/** A runner that also records every interrupt it is asked for. */
export class SignalRunner extends FakeRunner {
  readonly signals: { readonly handle: RunnerHandle; readonly signal: 'interrupt' | 'terminate' }[] = [];
  override async signal(handle: RunnerHandle, signal: 'interrupt' | 'terminate'): Promise<void> {
    this.signals.push({ handle, signal });
  }
}

export interface AdditivesOptions {
  /** The state the seeded ferret `fern` is in. */
  readonly state?: FerretRecord['state'];
  /** Seed no ferret at all (start tests). */
  readonly empty?: boolean;
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
  const runner = new SignalRunner();
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
    act,
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
