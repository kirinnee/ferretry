import type { FerretsApi, FerretSummary } from '@ferretry/core-ferrets/contract';
import { ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type {
  InputRaise,
  InputRequestId,
  InputTargetAdapter,
  SecretName,
  VaultApi,
} from '@ferretry/core-vault/contract';
import { FakeInputHolds, FakeRedaction } from '@ferretry/core-vault/contract/testing';
import type { FerretId } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { ok } from '@ferretry/std';
import { buildTerminals, type TerminalsOverrides } from '../../../daemon/index.ts';
import type { TerminalRecord, TerminalRuntimePort } from '../../../daemon/lib/terminal/contracts.ts';
import type { TerminalCapture } from '../../../daemon/lib/terminal/redraw.ts';
import type { TmuxCommandPort, TmuxCommandResult } from '../../../daemon/lib/tmux/contracts.ts';
import manifest from '../../../manifest.ts';

/**
 * Terminals' whole daemon half on the kernel's test host, with the tmux server and the terminals' runtime faked and
 * the Vault's contract fakes for holds and redaction ("with: vault" rows are tested against Vault's contract fake).
 */

export const FERRET = 'f-hadi' as FerretId;
export const SECRET = 'hunter2';

/** Terminals as a ferret's tools see them: a screen per terminal, and every byte typed into one. */
export class FakeTerminalRuntime implements TerminalRuntimePort {
  readonly records: TerminalRecord[] = [];
  readonly screens = new Map<string, string>();
  readonly typed: { readonly id: string; readonly text: string }[] = [];
  foregroundProgram = 'bash';
  /** Runs when a capture is taken, before it answers (a hold can begin there). */
  onCapture: (() => void) | undefined;

  async list(): Promise<readonly TerminalRecord[]> {
    return this.records;
  }
  async create(input: Parameters<TerminalRuntimePort['create']>[0]): Promise<TerminalRecord> {
    const record: TerminalRecord = {
      id: input.id,
      ownerId: input.ownerId,
      title: input.title,
      root: input.cwd,
      tmuxSession: `fy-webterm-${input.id}`,
      paneId: `%${String(this.records.length + 1)}`,
      createdAtMs: 0,
      lastActivityAtMs: 0,
      cols: input.size.cols,
      rows: input.size.rows,
      ...(input.openedBy === undefined ? {} : { openedBy: input.openedBy }),
      ...(input.name === undefined ? {} : { name: input.name }),
    };
    this.records.push(record);
    this.screens.set(record.id, '$ ');
    return record;
  }
  async rename(): Promise<void> {}
  async resize(): Promise<void> {}
  async write(record: TerminalRecord, bytes: Uint8Array): Promise<void> {
    this.typed.push({ id: record.id, text: new TextDecoder().decode(bytes) });
  }
  async capture(record: TerminalRecord): Promise<TerminalCapture> {
    this.onCapture?.();
    const lines = (this.screens.get(record.id) ?? '').split('\n');
    return { lines, cols: record.cols, rows: lines.length, cursorX: 0, cursorY: 0, historySize: 0 };
  }
  async text(record: TerminalRecord): Promise<string> {
    return this.screens.get(record.id) ?? '';
  }
  async foreground(): Promise<string> {
    return this.foregroundProgram;
  }
  async kill(record: TerminalRecord): Promise<void> {
    this.records.splice(this.records.indexOf(record), 1);
  }
}

/** A tmux server that answers from a script and records every command it was asked. */
export class ScriptedTmux implements TmuxCommandPort {
  readonly calls: (readonly string[])[] = [];
  constructor(private readonly answer: (args: readonly string[]) => Partial<TmuxCommandResult> = () => ({})) {}
  async execute(args: readonly string[]): Promise<TmuxCommandResult> {
    this.calls.push(args);
    return { code: 0, stdout: '', stderr: '', ...this.answer(args) };
  }
}

export const ferretSummary = (id: FerretId = FERRET): FerretSummary =>
  ({
    id,
    name: 'Hadi',
    role: 'worker',
    harness: 'claude-code',
    runner: 'tmux',
    folder: '/work/hadi',
    state: 'working',
    createdAt: '2026-11-07T00:00:00.000Z',
    stateAt: '2026-11-07T00:00:00.000Z',
  }) as unknown as FerretSummary;

export function fakeFerrets(known: readonly FerretSummary[] = [ferretSummary()]): FerretsApi {
  return {
    get: async id => known.find(ferret => ferret.id === id),
    list: async () => known,
    mayTouch: (caller, target) => caller === target,
    children: () => [],
    harnesses: () => [],
    start: async () => ({ ok: false, error: { code: 'failed', reason: 'not in this test' } }),
    stop: async () => undefined,
    resume: async () => ({ ok: false, error: { code: 'failed', reason: 'not in this test' } }),
    attach: async () => ({ ok: false, error: { code: 'failed', reason: 'not in this test' } }),
    sitrep: async () => undefined,
  };
}

/** The Vault, as far as Terminals asks it: input cards a ferret raises. */
export function fakeVault(raised: { ferret: string; raise: InputRaise }[]): VaultApi {
  const refuse = async (): Promise<never> => {
    throw new Error('not in this test');
  };
  return {
    names: refuse,
    has: refuse,
    put: refuse,
    remove: refuse,
    run: refuse,
    authorizeFetch: refuse,
    childEnvironment: refuse,
    raiseInput: async (ferret, raise) => {
      raised.push({ ferret, raise });
      return ok('0'.repeat(32) as InputRequestId);
    },
    cancelInput: async () => undefined,
    inputState: async () => undefined,
  };
}

export interface Half {
  readonly host: TestHost;
  readonly runtime: FakeTerminalRuntime;
  readonly holds: FakeInputHolds;
  readonly redaction: FakeRedaction;
  readonly raised: { ferret: string; raise: InputRaise }[];
  /** Who the next call is: the ferret (its own token) or the owner. */
  as(caller: 'ferret' | 'owner'): void;
  /** The `input.targets:terminal` adapter the half provides. */
  inputTarget(): InputTargetAdapter;
}

export async function terminalsHalf(overrides: Partial<TerminalsOverrides> = {}): Promise<Half> {
  const runtime = new FakeTerminalRuntime();
  const holds = new FakeInputHolds();
  const redaction = new FakeRedaction(new Map([['GITHUB_TOKEN' as SecretName, SECRET]]));
  const raised: { ferret: string; raise: InputRaise }[] = [];
  let caller: 'ferret' | 'owner' = 'ferret';
  let built: ReturnType<typeof buildTerminals> | undefined;
  const plugin = implementDaemon(manifest, {
    build: ctx =>
      (built = buildTerminals(ctx, {
        tmux: new ScriptedTmux(),
        socketPath: '/state/terminals/tmux.sock',
        runtime,
        ...overrides,
      })),
  });
  const host = await testHost({
    plugins: [plugin],
    fakes: { ferrets: fakeFerrets(), vault: fakeVault(raised) },
    gate: new StandInAdmission(() => (caller === 'ferret' ? ferretStanding(FERRET) : ownerStanding())),
    holds: holds.holds,
    redaction,
  });
  return {
    host,
    runtime,
    holds,
    redaction,
    raised,
    as: next => (caller = next),
    inputTarget: () => built?.hooks['input.targets:terminal'] as InputTargetAdapter,
  };
}
