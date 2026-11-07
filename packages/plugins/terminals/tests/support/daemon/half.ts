import {
  DEFAULT_AGENT_CONTROL,
  NO_AGENT_CONTROL,
  type FerretsApi,
  type FerretSummary,
} from '@ferretry/core-ferrets/contract';
import { ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type {
  InputRaise,
  InputRequestId,
  InputTargetAdapter,
  SecretName,
  VaultApi,
} from '@ferretry/core-vault/contract';
import {
  FakeInputHolds,
  FakeRedaction,
  type InputTargetBinding,
  type InputTargetSubject,
  type LiveInputTarget,
} from '@ferretry/core-vault/contract/testing';
import type { FerretId } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import type { ReferenceCatalogProvider } from '@ferretry/plugin-conversation/contract';
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
    role: 'lead',
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
    handle: async () => undefined,
    workFolder: async id => {
      const ferret = known.find(ferret => ferret.id === id);
      return ferret === undefined ? undefined : { folder: ferret.folder };
    },
    agentControl: async id => (known.some(ferret => ferret.id === id) ? DEFAULT_AGENT_CONTROL : NO_AGENT_CONTROL),
    sitrep: async () => undefined,
    summary: async () => undefined,
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
  /** The `reference.catalog:%terminal` provider the half takes (Conversation's references route asks it when Conversation is on). */
  referenceMenu(): ReferenceCatalogProvider;
}

export async function terminalsHalf(
  overrides: Partial<TerminalsOverrides> = {},
  known: readonly FerretSummary[] = [ferretSummary()],
): Promise<Half> {
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
    fakes: { ferrets: fakeFerrets(known), vault: fakeVault(raised) },
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
    referenceMenu: () => built?.hooks['reference.catalog:%terminal'] as ReferenceCatalogProvider,
  };
}

/**
 * A live terminal for the Vault's live-target conformance: a real sudo at its password prompt in a pane tmux, `ps`,
 * `stty` and the kernel's proofs describe, so the half's own guarded write is what is checked. tmux types the keys of
 * an `if-shell` only while its own condition holds of the pane NOW, exactly as the server evaluates it.
 */
export async function liveTerminalSubject(): Promise<InputTargetSubject> {
  const ferret = 'f1' as FerretId;
  const world = {
    pid: 4242,
    command: 'sudo',
    cursor: 7,
    prompt: '[sudo] password for kirin:',
    echo: 'off' as 'off' | 'on',
    ps: ' 4242  4242  4300 bash -bash\n 4300  4300  4300 /usr/bin/sudo sudo -v\n',
    writes: 0,
  };
  const live = (name: string): string =>
    ({
      pane_id: '%1',
      pane_pid: String(world.pid),
      pane_current_command: world.command,
      cursor_y: String(world.cursor),
      pane_dead: '0',
    })[name] ?? '';
  const condition = (text: string): boolean => {
    const compared = [...text.matchAll(/#\{==:#\{(\w+)\},([^}]*)\}/gu)];
    return compared.length > 0 && compared.every(([, name = '', value = '']) => live(name) === value);
  };
  const tmux: TmuxCommandPort = {
    execute: async args => {
      const answer = (stdout: string): TmuxCommandResult => ({ code: 0, stdout, stderr: '' });
      if (args[0] === 'display-message')
        return answer(`%1|${String(world.pid)}|0|1700000000\t/dev/pts/9\t${String(world.cursor)}\t${world.command}\n`);
      if (args[0] === 'capture-pane') return answer(`${world.prompt}\n`);
      if (args[0] === 'if-shell') {
        if (!condition(args[4] ?? '')) return answer(`${args[6]?.split(' ').at(-1) ?? ''}\n`);
        world.writes += 1;
        return answer('');
      }
      return { code: 1, stdout: '', stderr: "can't find pane" };
    },
  };
  const sudo = { name: 'sudo', setuidRoot: true } as const;
  const half = await terminalsHalf(
    {
      inputs: {
        tmux,
        run: async () => world.ps,
        modes: { echo: async () => world.echo },
        proofs: { prove: async pid => (pid === 4300 ? sudo : undefined), heldElsewhere: async () => false },
      },
    },
    [ferretSummary(), ferretSummary(ferret)],
  );
  half.runtime.records.push({
    id: 't-live',
    ownerId: ferret,
    title: 'live',
    name: 'live',
    root: '/work/hadi',
    tmuxSession: 'fy-webterm-live',
    paneId: '%1',
    createdAtMs: 0,
    lastActivityAtMs: 0,
    cols: 80,
    rows: 24,
  } as TerminalRecord);
  const change = (binding: InputTargetBinding): void => {
    if (binding === 'pane') world.pid = 9999;
    if (binding === 'foreground') {
      world.command = 'bash';
      world.ps = ' 4242  4242  4242 bash -bash\n';
    }
    if (binding === 'echo') world.echo = 'on';
    if (binding === 'prompt') world.prompt = 'Password for another:';
  };
  const subject: LiveInputTarget = { key: 'live', change, writes: () => world.writes };
  return { adapter: half.inputTarget(), unknownKey: 'nothing-here', kind: 'terminal', live: subject };
}
