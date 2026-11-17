/**
 * `TmuxRunner.exited`: the proof that a ferret's pane is still THERE with its program ended (`remain-on-exit`), and how
 * it ended. A live pane, a pane the session does not hold, a missing session and every refusal prove nothing.
 */
import { describe, expect, test } from 'bun:test';
import type { FerretId, RunnerHandle } from '@ferretry/core-ferrets/contract';
import type { Redaction } from '@ferretry/kernel/contract';
import { testActRunner, TestMintedIds } from '@ferretry/kernel/testing';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';

const FERRET = 'mw7bp88g-50e00159' as FerretId;
const HANDLE = '%7' as RunnerHandle;
const SECRET = 'sk-live-exited';
const NOW = '2026-11-08T10:00:00.000Z';

interface Answers {
  readonly panes?: string;
  readonly listCode?: number;
  readonly listStderr?: string;
  readonly screen?: string;
  readonly captureCode?: number;
  readonly watched?: boolean;
  readonly held?: boolean;
}

function runner(answers: Answers) {
  const calls: (readonly string[])[] = [];
  const redaction: Redaction = {
    read: async fn =>
      await fn({
        text: text => text.replaceAll(SECRET, '*'.repeat(SECRET.length)),
        cells: cells => cells,
        lines: lines => lines,
      }),
  };
  const subject = new TmuxRunner({
    tmux: {
      execute: async args => {
        calls.push(args);
        if (args[0] === 'list-panes')
          return { code: answers.listCode ?? 0, stdout: answers.panes ?? '', stderr: answers.listStderr ?? '' };
        if (args[0] === 'capture-pane')
          return { code: answers.captureCode ?? 0, stdout: answers.screen ?? '', stderr: '' };
        throw new Error(`exited must not run ${args[0]}`);
      },
    },
    spawn: {
      run: async () => {
        throw new Error('exited must not spawn');
      },
      runBytes: () => Promise.reject(new Error('exited must not spawn')),
      start: () => {
        throw new Error('exited must not spawn');
      },
    },
    socketPath: '/fixture/tmux.sock',
    instantOf: () => NOW as never,
    now: () => NOW as never,
    ...(answers.watched === false
      ? {}
      : {
          look: {
            act: testActRunner({
              holds: () => ({ decide: () => (answers.held === true ? { refused: 'input_pending' } : 'allow') }),
              actor: () => 'ferret',
              minted: new TestMintedIds(),
            }),
            redaction,
            digest: text => `digest:${text.length}`,
          },
        }),
  });
  return { subject, calls };
}

describe('TmuxRunner.exited', () => {
  test("asks list-panes of the ferret's own session by its exact name, then reads the pane", async () => {
    const { subject, calls } = runner({ panes: '%7|1||9\n', screen: 'bye\n' });
    await subject.exited(FERRET, HANDLE);
    expect(calls).toEqual([
      [
        'list-panes',
        '-s',
        '-t',
        `=fy-${FERRET}`,
        '-F',
        '#{pane_id}|#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}',
      ],
      ['capture-pane', '-p', '-t', '%7'],
    ]);
  });

  test('a pane killed by a signal answers the signal, and its masked last lines', async () => {
    const screen = `token ${SECRET}\n\nKilled\n\n\n`;
    const exit = await runner({ panes: '%7|1||9\n', screen }).subject.exited(FERRET, HANDLE);
    expect(exit).toEqual({ signal: 9, lastLines: `token ${'*'.repeat(SECRET.length)}\nKilled` });
  });

  test('a pane whose program exited answers its status, 0 included', async () => {
    expect(await runner({ panes: '%7|1|2|\n' }).subject.exited(FERRET, HANDLE)).toEqual({ status: 2 });
    expect(await runner({ panes: '%7|1|0|\n' }).subject.exited(FERRET, HANDLE)).toEqual({ status: 0 });
  });

  test('a dead pane tmux recorded nothing for is still proven dead', async () => {
    expect(await runner({ panes: '%7|1||\n' }).subject.exited(FERRET, HANDLE)).toEqual({});
  });

  test('a live pane is never read dead', async () => {
    const { subject, calls } = runner({ panes: '%7|0||\n' });
    expect(await subject.exited(FERRET, HANDLE)).toBeUndefined();
    expect(calls.map(call => call[0])).toEqual(['list-panes']);
  });

  test('only the exact pane id counts: a dead pane that is not the handle proves nothing', async () => {
    expect(await runner({ panes: '%8|1|1|\n%7|0||\n' }).subject.exited(FERRET, HANDLE)).toBeUndefined();
    expect(await runner({ panes: '%70|1|1|\n' }).subject.exited(FERRET, HANDLE)).toBeUndefined();
  });

  test('a session that is not there, or any refusal, proves nothing', async () => {
    expect(
      await runner({ listCode: 1, listStderr: `can't find session: fy-${FERRET}` }).subject.exited(FERRET, HANDLE),
    ).toBeUndefined();
    expect(
      await runner({ listCode: 1, listStderr: 'no server running' }).subject.exited(FERRET, HANDLE),
    ).toBeUndefined();
    expect(await runner({ panes: 'garbage' }).subject.exited(FERRET, HANDLE)).toBeUndefined();
  });

  test('a handle that is not a pane id is not asked about', async () => {
    const { subject, calls } = runner({ panes: '%7|1||9\n' });
    expect(await subject.exited(FERRET, 'not-a-pane' as RunnerHandle)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test('a held pane gives how it ended and no lines; so does a runner with no look wiring or an unreadable pane', async () => {
    expect(await runner({ panes: '%7|1||9\n', screen: 'x', held: true }).subject.exited(FERRET, HANDLE)).toEqual({
      signal: 9,
    });
    expect(await runner({ panes: '%7|1||9\n', screen: 'x', watched: false }).subject.exited(FERRET, HANDLE)).toEqual({
      signal: 9,
    });
    expect(await runner({ panes: '%7|1||9\n', captureCode: 1 }).subject.exited(FERRET, HANDLE)).toEqual({ signal: 9 });
  });
});
