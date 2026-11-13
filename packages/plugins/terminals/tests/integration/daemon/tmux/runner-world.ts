import type { RunnerHandle } from '@ferretry/core-ferrets/contract';
import type { InputHolds, Redaction } from '@ferretry/kernel/contract';
import { type ActRecord, testActRunner, TestMintedIds } from '@ferretry/kernel/testing';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import { FakeTmuxServer } from '../support/fake-tmux-server.ts';
import { scriptWords } from '../support/script-words.ts';

// This fixture is an in-memory composer; no tmux process or real sleep is used.
export function subject(options: { readonly unguarded?: boolean; readonly redaction?: Redaction } = {}) {
  const server = new FakeTmuxServer();
  const acts: ActRecord[] = [];
  const handle = '%7' as RunnerHandle;
  let pane = { id: '%7', pid: 4242, session: 'fy-f-hadi', created: 1000, command: 'harness' };
  let held = false;
  let holdAfterBuffer = false;
  let holdAfterPayload = false;
  let beforeGuard: ((write: readonly string[]) => void) | undefined;
  /** No cursor in the pane's metadata: a composer no frame can place. */
  let blindCursor = false;
  /** A tmux command whose call throws (the command port itself failed), for a read that cannot be made. */
  let throwOn: string | undefined;
  const guards: Array<readonly string[]> = [];
  const cursorRow = () =>
    server.transcript.split('\n').length +
    (server.modal?.split('\n').length ?? 0) +
    (server.working ? 1 : 0) +
    server.composer.split('\n').length -
    1;
  const holds: InputHolds = {
    decide: () => (held ? { refused: 'input_pending' } : 'allow'),
  };
  /** The act the turn watch's reads run in (the same holds as the writes), recorded with them. */
  const lookAct = testActRunner({
    holds: () => holds,
    actor: () => 'ferret',
    minted: new TestMintedIds(),
    record: act => acts.push(act),
  });
  const runner = new TmuxRunner({
    tmux: {
      execute: async (args, stdin) => {
        if (throwOn !== undefined && args[0] === throwOn) throw new Error(`tmux ${throwOn} failed`);
        if (blindCursor && args[0] === 'display-message' && !args.at(-1)?.startsWith('#{pane_id}|')) {
          server.calls.push(args);
          return { code: 0, stdout: '0||||24|80\n', stderr: '' };
        }
        if (args[0] === 'display-message' && args.at(-1)?.startsWith('#{pane_id}|')) {
          return server.alive
            ? {
                code: 0,
                stdout: `${pane.id}|${pane.pid}|${server.dead ? '1' : '0'}|${pane.session}|${pane.created}|${pane.command}|${cursorRow()}`,
                stderr: '',
              }
            : { code: 1, stdout: '', stderr: 'no such pane' };
        }
        if (args[0] === 'if-shell') {
          guards.push(args);
          const write = scriptWords(args[5] ?? '');
          beforeGuard?.(write);
          const live: Record<string, string> = {
            pane_id: pane.id,
            pane_pid: String(pane.pid),
            pane_dead: server.dead ? '1' : '0',
            pane_current_command: pane.command,
            cursor_y: String(cursorRow()),
            session_name: pane.session,
            session_created: String(pane.created),
          };
          const comparisons = [...(args[4] ?? '').matchAll(/#\{==:#\{(\w+)\},([^}]*)\}/gu)];
          if (comparisons.length === 0 || !comparisons.every(([, key = '', value]) => live[key] === value))
            return { code: 0, stdout: 'fy-input-guard-refused\n', stderr: '' };
          if (write[0] === 'set-buffer') {
            return await server.execute(['load-buffer', '-b', write[2] ?? '', '-'], write.at(-1)).then(result => {
              if (holdAfterBuffer) held = true;
              return result;
            });
          }
          const result = await server.execute(write);
          if (holdAfterPayload && (write.includes('-l') || write[0] === 'paste-buffer')) held = true;
          return result;
        }
        if (['send-keys', 'paste-buffer', 'load-buffer'].includes(args[0] ?? ''))
          throw new Error('delivery writes must be conditional');
        const result = await server.execute(args, stdin);
        return result;
      },
    },
    spawn: {
      run: async () => {
        throw new Error('delivery must not spawn');
      },
      runBytes: () => Promise.reject(new Error('the fixture runs no bytes')),
      start: () => {
        throw new Error('delivery must not start');
      },
    },
    socketPath: '/fixture/tmux.sock',
    ...(options.redaction === undefined
      ? {}
      : { look: { act: lookAct, redaction: options.redaction, digest: undefined as never } }),
    instantOf: () => 'now' as never,
    now: () => 'now' as never,
    delivery:
      options.unguarded === true
        ? undefined
        : {
            act: testActRunner({
              holds: () => holds,
              actor: () => 'ferret',
              minted: new TestMintedIds(),
              record: act => acts.push(act),
            }),
            sleep: async ms => server.advance(ms),
          },
  });
  return {
    runner,
    server,
    acts,
    guards,
    handle,
    hold: () => {
      held = true;
    },
    holdAfterBuffer: () => {
      holdAfterBuffer = true;
    },
    holdAfterPayload: () => {
      holdAfterPayload = true;
    },
    beforeGuard: (fn: (write: readonly string[]) => void) => {
      beforeGuard = fn;
    },
    replace: (change: Partial<typeof pane>) => {
      pane = { ...pane, ...change };
    },
    blindCursor: () => {
      blindCursor = true;
    },
    throwOn: (command: string) => {
      throwOn = command;
    },
  };
}
