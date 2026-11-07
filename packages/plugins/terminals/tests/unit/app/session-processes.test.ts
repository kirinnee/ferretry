import { describe, expect, it } from 'bun:test';
import { DaemonCallError } from '@ferretry/app';
import {
  formatElapsed,
  formatMemory,
  groupProcesses,
  listSessionProcesses,
  liveProcessCount,
  PROCESS_CHANGED_TEXT,
  PROCESSES_FORBIDDEN_TEXT,
  processElapsedText,
  processErrorText,
  processTitle,
  readSessionProcessOutput,
  stopSessionProcess,
} from '../../../app/lib/session-processes.ts';
import { refusal, scriptedClient } from '../../support/app/client.ts';
import {
  ALL_PROCESSES,
  DEV_SERVER_PARENT,
  LINT_FAILED,
  outputAnswer,
  PROCESSES_NOW,
  processList,
  TERMINAL_ONLY,
  WATCH_TESTS,
} from '../../support/app/session-processes.ts';

const scope = { sessionId: 'agent-session' };

describe('grouping the process list', () => {
  const groups = groupProcesses(ALL_PROCESSES);

  it('orders commands, background, servers, helpers, then what has ended', () => {
    expect(groups.map(group => group.key)).toEqual(['command', 'background', 'helper', 'ended']);
    expect(groups.map(group => group.heading)).toEqual(['Running commands', 'Background', 'Helpers', 'Recently ended']);
  });

  it('puts a process under the one that started it, and counts its descendants', () => {
    const background = groups.find(group => group.key === 'background');
    expect(background?.rows.map(row => row.process.id)).toEqual(['200.2', '500.6']);
    expect(background?.rows[0]?.children.map(child => child.id)).toEqual(['201.3']);
    expect(groups.some(group => group.key === 'server')).toBe(false);
  });

  it('lists every child of one parent under that parent, in the order the daemon sent them', () => {
    type Listed = (typeof ALL_PROCESSES.processes)[number];
    const parent = ALL_PROCESSES.processes[1] as Listed;
    const first = ALL_PROCESSES.processes[2] as Listed;
    const second = { ...first, id: '201.4' } as Listed;
    const rows = groupProcesses(processList([parent, first, second]))
      .flatMap(group => group.rows)
      .filter(row => row.process.id === parent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.children.map(child => child.id)).toEqual([first.id, '201.4']);
  });

  it('keeps a process whose parent is not listed at the top level', () => {
    const orphan = { ...ALL_PROCESSES.processes[2], parentId: '9.9' } as (typeof ALL_PROCESSES.processes)[number];
    const only = groupProcesses(processList([orphan]));
    expect(only[0]?.key).toBe('server');
    expect(only[0]?.heading).toBe('Servers');
  });

  it('counts the live top-level entries a person started: no exited ones, no helpers, no children', () => {
    expect(ALL_PROCESSES.processes).toHaveLength(6);
    expect(liveProcessCount(ALL_PROCESSES)).toBe(3);
    expect(liveProcessCount(processList([LINT_FAILED]))).toBe(0);
    expect(liveProcessCount(null)).toBe(0);
  });

  it('counts a child whose parent is not listed, and still skips a helper', () => {
    const [, parent, child, helper] = ALL_PROCESSES.processes;
    expect(liveProcessCount(processList([child as (typeof ALL_PROCESSES.processes)[number]]))).toBe(1);
    expect(liveProcessCount(processList([parent, child, helper] as (typeof ALL_PROCESSES.processes)[number][]))).toBe(
      1,
    );
    expect(liveProcessCount(processList([helper as (typeof ALL_PROCESSES.processes)[number]]))).toBe(0);
  });

  it('shows the agent’s label when there is one', () => {
    expect(processTitle(TERMINAL_ONLY)).toBe('Wait for the deploy');
    expect(processTitle(WATCH_TESTS)).toBe('bun test --watch');
  });
});

describe('words for time and size', () => {
  it('keeps the two largest units', () => {
    expect(formatElapsed(45_000)).toBe('45s');
    expect(formatElapsed(134_000)).toBe('2m 14s');
    expect(formatElapsed(3_900_000)).toBe('1h 05m');
    expect(formatElapsed(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d 4h');
    expect(formatElapsed(-5)).toBe('0s');
  });

  it('says how long a live process has run and how long ago an ended one stopped', () => {
    expect(processElapsedText(WATCH_TESTS, PROCESSES_NOW)).toBe('2m 14s');
    expect(processElapsedText(LINT_FAILED, PROCESSES_NOW)).toBe('ended 3m 0s ago · exit 1');
    expect(processElapsedText({ ...LINT_FAILED, endedAt: undefined, exit: undefined }, PROCESSES_NOW)).toBe('ended');
  });

  it('writes memory in megabytes', () => {
    expect(formatMemory(48 * 1024 * 1024)).toBe('48 MB');
    expect(formatMemory(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });
});

describe('what a failure says', () => {
  it('names the grant when the daemon refuses with 403', () => {
    expect(processErrorText(new DaemonCallError(403, 'http_403', 'forbidden'))).toBe(PROCESSES_FORBIDDEN_TEXT);
    expect(PROCESSES_FORBIDDEN_TEXT).toBe(
      'This device can’t see this ferret’s processes. Allow Terminals for it in Settings › Devices.',
    );
  });

  it('says nothing was stopped when the process changed under the request', () => {
    expect(processErrorText(new DaemonCallError(409, 'process_changed', 'changed'))).toBe(PROCESS_CHANGED_TEXT);
    expect(processErrorText(new DaemonCallError(409, 'other', 'something else'))).toBe('something else');
  });

  it('passes any other failure’s own message', () => {
    expect(processErrorText(new Error('network down'))).toBe('network down');
    expect(processErrorText('plain')).toBe('plain');
  });
});

describe('the client', () => {
  it('lists, addressing the ferret’s processes route by its manifest key and parsing the answer', async () => {
    const { calls, client } = scriptedClient(ALL_PROCESSES);
    const list = await listSessionProcesses(client, scope);
    expect(calls).toEqual([
      { route: 'GET /v1/ferrets/:ferretId/processes', init: { params: { ferretId: 'agent-session' } } },
    ]);
    expect(list.processes).toHaveLength(6);
  });

  it('refuses an answer for another ferret or one that does not parse', async () => {
    await expect(
      listSessionProcesses(scriptedClient({ ...ALL_PROCESSES, sessionId: 'someone-else' }).client, scope),
    ).rejects.toMatchObject({ status: 502 });
    await expect(listSessionProcesses(scriptedClient({ nope: true }).client, scope)).rejects.toThrow();
  });

  it('lets a refusal through carrying its status and code', async () => {
    const error = await listSessionProcesses(scriptedClient(refusal(409, 'no', 'process_changed')).client, scope).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(DaemonCallError);
    expect((error as DaemonCallError).status).toBe(409);
    expect((error as DaemonCallError).code).toBe('process_changed');
  });

  it('reads the tail first, then everything after the last end', async () => {
    const { calls, client } = scriptedClient(outputAnswer('100.1', 'hi'));
    await readSessionProcessOutput(client, scope, '100.1', undefined);
    await readSessionProcessOutput(client, scope, '100.1', 4096);
    expect(calls.map(call => call.init?.query)).toEqual([undefined, { after: '4096' }]);
    expect(calls[0]?.route).toBe('GET /v1/ferrets/:ferretId/processes/:processId/output');
    expect(calls[0]?.init?.params).toEqual({ ferretId: 'agent-session', processId: '100.1' });
  });

  it('stops with a POST route and no body', async () => {
    const { calls, client } = scriptedClient({ processId: '100.1', signalled: 3 });
    const result = await stopSessionProcess(client, scope, '100.1');
    expect(result.signalled).toBe(3);
    expect(calls).toEqual([
      {
        route: 'POST /v1/ferrets/:ferretId/processes/:processId/stop',
        init: { params: { ferretId: 'agent-session', processId: '100.1' } },
      },
    ]);
  });

  it('refuses a process id that is not one the daemon mints', async () => {
    const { calls, client } = scriptedClient({});
    await expect(stopSessionProcess(client, scope, '../etc')).rejects.toThrow();
    expect(calls).toHaveLength(0);
    expect(DEV_SERVER_PARENT.id).toBe('200.2');
  });
});
