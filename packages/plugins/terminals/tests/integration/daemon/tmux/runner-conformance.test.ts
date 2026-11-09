import type { RunnerHandle } from '@ferretry/core-ferrets/contract';
import { emptyChildEnvironment, fenced, ferretId, runnerConformance } from '@ferretry/core-ferrets/contract/testing';
import type { InputHolds } from '@ferretry/kernel/contract';
import { testActRunner, TestMintedIds } from '@ferretry/kernel/testing';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import type { TmuxCommandResult } from '../../../../daemon/lib/tmux/contracts.ts';
import { FakeTmuxServer } from '../support/fake-tmux-server.ts';
import { scriptWords } from '../support/script-words.ts';

/** One pane of the in-memory tmux world: its facts, and the composer model that answers its reads and keys. */
interface WorldPane {
  readonly id: string;
  readonly pid: number;
  readonly session: string;
  readonly created: number;
  readonly command: string;
  readonly server: FakeTmuxServer;
}

const done = (stdout = ''): TmuxCommandResult => ({ code: 0, stdout, stderr: '' });
const refused = (stderr: string): TmuxCommandResult => ({ code: 1, stdout: '', stderr });
const PAYLOAD_WRITES = new Set(['send-keys', 'paste-buffer', 'load-buffer']);

/**
 * The real `TmuxRunner` over an in-memory tmux server of several panes, so the Ferrets runner conformance suite holds
 * the runner itself to the contract, not only `FakeRunner`. No tmux process, shell or spawn runs: the launch script is
 * decoded and answered here, every pane is a `FakeTmuxServer` composer, and every write the runner makes must arrive
 * through the server-side guard (`if-shell`) — a raw payload write throws.
 */
function tmuxWorld() {
  const panes = new Map<string, WorldPane>();
  let next = 10;
  let starts = 0;

  const add = (session: string, command: string): WorldPane => {
    next += 1;
    const pane: WorldPane = {
      id: `%${next}`,
      pid: 4000 + next,
      session,
      created: 1_000 + next,
      command,
      server: new FakeTmuxServer(),
    };
    panes.set(pane.id, pane);
    return pane;
  };
  /** The pane a `-t` names: a pane id, or the session it is the active pane of. */
  const target = (args: readonly string[]): WorldPane | undefined => {
    const named = args[args.indexOf('-t') + 1] ?? '';
    return panes.get(named) ?? [...panes.values()].find(pane => pane.session === named);
  };
  const cursorRow = ({ server }: WorldPane): number =>
    server.transcript.split('\n').length +
    (server.modal?.split('\n').length ?? 0) +
    (server.working ? 1 : 0) +
    server.composer.split('\n').length -
    1;
  const live = (pane: WorldPane): Record<string, string> => ({
    pane_id: pane.id,
    pane_pid: String(pane.pid),
    pane_dead: pane.server.dead ? '1' : '0',
    pane_current_command: pane.command,
    cursor_y: String(cursorRow(pane)),
    session_name: pane.session,
    session_created: String(pane.created),
  });

  const execute = async (args: readonly string[], stdin?: string): Promise<TmuxCommandResult> => {
    const command = args[0] ?? '';
    if (command === 'start-server') return done();
    if (command === 'show-options') return done('\n');
    if (command === 'set-option') return done();
    const pane = target(args);
    if (command === 'has-session') return pane === undefined ? refused("can't find session") : done();
    if (pane === undefined) return refused("can't find pane");
    if (command === 'kill-session') {
      panes.delete(pane.id);
      return done();
    }
    if (command === 'display-message' && args.at(-1)?.startsWith('#{pane_id}|')) {
      const facts = live(pane);
      return done(
        `${facts.pane_id}|${facts.pane_pid}|${facts.pane_dead}|${facts.session_name}|${facts.session_created}|${facts.pane_current_command}|${facts.cursor_y}\n`,
      );
    }
    if (command === 'if-shell') {
      const comparisons = [...(args[4] ?? '').matchAll(/#\{==:#\{(\w+)\},([^}]*)\}/gu)];
      const facts = live(pane);
      if (comparisons.length === 0 || !comparisons.every(([, key = '', value]) => facts[key] === value))
        return done('fy-input-guard-refused\n');
      const write = scriptWords(args[5] ?? '');
      return write[0] === 'set-buffer'
        ? await pane.server.execute(['load-buffer', '-b', write[2] ?? '', '-'], write.at(-1))
        : await pane.server.execute(write);
    }
    if (PAYLOAD_WRITES.has(command)) throw new Error('every write a delivery or a stop makes must be guarded');
    return await pane.server.execute(args, stdin);
  };

  const holds: InputHolds = { decide: () => 'allow' };
  const runner = new TmuxRunner({
    tmux: { execute },
    spawn: {
      // The launch script, decoded: `set-option`, `new-session … -s <session> -c <cwd> -- <program> …`, `set-option`.
      run: async (_program, _args, options) => {
        const stdin = options?.stdin ?? '';
        const script = typeof stdin === 'string' ? stdin : new TextDecoder().decode(stdin);
        const lines = script.split('\n').filter(line => line.trim() !== '');
        const created = lines.map(scriptWords).find(words => words[0] === 'new-session');
        if (created === undefined) return { exitCode: 1, signal: null, stdout: '', stderr: 'no new-session' };
        const session = created[created.indexOf('-s') + 1] ?? '';
        const program = created[created.indexOf('--') + 1] ?? '';
        starts += 1;
        const pane = add(session, program);
        return { exitCode: 0, signal: null, stdout: `${pane.id}|${pane.pid}\n`, stderr: '' };
      },
      runBytes: () => Promise.reject(new Error('the fixture runs no bytes')),
      start: () => {
        throw new Error('the fixture starts nothing');
      },
    },
    socketPath: '/fixture/tmux.sock',
    instantOf: () => 'then' as never,
    now: () => 'now' as never,
    delivery: {
      act: testActRunner({ holds: () => holds, actor: () => 'ferret', minted: new TestMintedIds(), record: () => {} }),
      sleep: async ms => {
        for (const pane of panes.values()) pane.server.advance(ms);
      },
    },
  });

  const paneOf = (handle: RunnerHandle): WorldPane => {
    const pane = panes.get(handle);
    if (pane === undefined) throw new Error(`no pane ${handle} in the fixture`);
    return pane;
  };
  return {
    runner,
    spec: { ferret: ferretId('f1'), command: ['harness'], cwd: fenced('/work'), env: emptyChildEnvironment() },
    // A ferret pane a previous daemon started: it is in the server, and this runner never launched it.
    adoptable: async () => add('fy-f0', 'harness').id as RunnerHandle,
    starts: () => starts,
    stopPane: {
      working: (handle: RunnerHandle, working: boolean) => {
        paneOf(handle).server.working = working;
      },
      keys: (handle: RunnerHandle) =>
        paneOf(handle)
          .server.calls.filter(call => call[0] === 'send-keys')
          .map(call => call.at(-1) ?? ''),
    },
  };
}

runnerConformance('TmuxRunner (in-memory tmux server)', tmuxWorld);
