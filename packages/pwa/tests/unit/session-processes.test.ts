import { describe, expect, it } from 'bun:test';
import {
  applyOutput,
  EMPTY_OUTPUT,
  PROCESS_OUTPUT_HELD_MAX,
} from '../../src/features/workspace/use-session-processes.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { DaemonResponseError } from '../../src/lib/runtime-models.ts';
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
} from '../../src/lib/session-processes.ts';
import {
  ALL_PROCESSES,
  DEV_SERVER_PARENT,
  LINT_FAILED,
  outputAnswer,
  PROCESSES_NOW,
  processList,
  TERMINAL_ONLY,
  WATCH_TESTS,
} from '../support/session-processes.ts';

const daemon = daemonConnection({ daemonId: 'proc-daemon', baseUrl: 'https://proc.example.test', deviceId: 'd' });
const scope = daemonSessionScope(daemon, 'agent-session');

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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
    expect(processErrorText(new DaemonResponseError(403, 'forbidden'))).toBe(PROCESSES_FORBIDDEN_TEXT);
    expect(PROCESSES_FORBIDDEN_TEXT).toBe(
      'This device can’t see this ferret’s processes. Allow Terminals for it in Settings › Devices.',
    );
  });

  it('says nothing was stopped when the process changed under the request', () => {
    expect(processErrorText(new DaemonResponseError(409, 'changed', 'process_changed'))).toBe(PROCESS_CHANGED_TEXT);
    expect(processErrorText(new DaemonResponseError(409, 'something else', 'other'))).toBe('something else');
  });

  it('passes any other failure’s own message', () => {
    expect(processErrorText(new Error('network down'))).toBe('network down');
    expect(processErrorText('plain')).toBe('plain');
  });
});

describe('the client', () => {
  it('lists, addressing the session’s processes route and parsing the answer', async () => {
    const calls: { url: string; method: string }[] = [];
    const list = await listSessionProcesses(daemon, scope, async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' });
      return json(ALL_PROCESSES);
    });
    expect(calls).toEqual([{ url: 'https://proc.example.test/v1/sessions/agent-session/processes', method: 'GET' }]);
    expect(list.processes).toHaveLength(6);
  });

  it('refuses an answer for another session or one that does not parse', async () => {
    await expect(
      listSessionProcesses(daemon, scope, async () => json({ ...ALL_PROCESSES, sessionId: 'someone-else' })),
    ).rejects.toThrow();
    await expect(listSessionProcesses(daemon, scope, async () => json({ nope: true }))).rejects.toThrow();
  });

  it('turns an error status into a DaemonResponseError carrying the code', async () => {
    const error = await listSessionProcesses(daemon, scope, async () =>
      json({ error: 'no', code: 'process_changed' }, 409),
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DaemonResponseError);
    expect((error as DaemonResponseError).status).toBe(409);
    expect((error as DaemonResponseError).code).toBe('process_changed');
  });

  it('reads the tail first, then everything after the last end', async () => {
    const urls: string[] = [];
    const reader = async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return json(outputAnswer('100.1', 'hi'));
    };
    await readSessionProcessOutput(daemon, scope, '100.1', undefined, reader);
    await readSessionProcessOutput(daemon, scope, '100.1', 4096, reader);
    expect(urls).toEqual([
      'https://proc.example.test/v1/sessions/agent-session/processes/100.1/output',
      'https://proc.example.test/v1/sessions/agent-session/processes/100.1/output?after=4096',
    ]);
  });

  it('stops with a POST and no body, carrying a request id', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const result = await stopSessionProcess(daemon, scope, '100.1', async (url, init) => {
      seen.push({ url: String(url), init });
      return json({ processId: '100.1', signalled: 3 });
    });
    expect(result.signalled).toBe(3);
    expect(seen[0]?.url).toBe('https://proc.example.test/v1/sessions/agent-session/processes/100.1/stop');
    expect(seen[0]?.init?.method).toBe('POST');
    expect(seen[0]?.init?.body).toBeUndefined();
  });

  it('refuses a process id that is not one the daemon mints', async () => {
    await expect(stopSessionProcess(daemon, scope, '../etc', async () => json({}))).rejects.toThrow();
    expect(DEV_SERVER_PARENT.id).toBe('200.2');
  });
});

describe('following output', () => {
  it('holds the first answer as the tail and asks after its end', () => {
    const held = applyOutput(
      EMPTY_OUTPUT,
      outputAnswer('100.1', 'abc', { start: 100, end: 103, size: 103, skipped: true }),
    );
    expect(held).toMatchObject({ text: 'abc', end: 103, skipped: true, complete: false });
  });

  it('appends what comes after and moves the end', () => {
    const first = applyOutput(EMPTY_OUTPUT, outputAnswer('100.1', 'abc'));
    const second = applyOutput(first, outputAnswer('100.1', 'def', { start: 3, end: 6, size: 6 }));
    expect(second).toMatchObject({ text: 'abcdef', end: 6, skipped: false });
  });

  it('drops what it holds when the file was replaced', () => {
    const first = applyOutput(EMPTY_OUTPUT, outputAnswer('100.1', 'abcdef'));
    const reset = applyOutput(first, outputAnswer('100.1', 'new', { reset: true, end: 3, size: 3 }));
    expect(reset).toMatchObject({ text: 'new', end: 3 });
  });

  it('drops what it holds when a gap was skipped, and says so', () => {
    const first = applyOutput(EMPTY_OUTPUT, outputAnswer('100.1', 'abcdef'));
    const gap = applyOutput(first, outputAnswer('100.1', 'xyz', { skipped: true, start: 900, end: 903, size: 903 }));
    expect(gap).toMatchObject({ text: 'xyz', end: 903, skipped: true });
  });

  it('remembers that the process is done', () => {
    const first = applyOutput(EMPTY_OUTPUT, outputAnswer('100.1', 'abc'));
    expect(applyOutput(first, outputAnswer('100.1', '', { start: 3, end: 3, size: 3, complete: true })).complete).toBe(
      true,
    );
  });

  it('keeps no more than the cap and says earlier text was dropped', () => {
    const big = 'x'.repeat(PROCESS_OUTPUT_HELD_MAX);
    const first = applyOutput(EMPTY_OUTPUT, outputAnswer('100.1', big));
    const next = applyOutput(first, outputAnswer('100.1', 'tail', { start: big.length, end: big.length + 4 }));
    expect(next.text.length).toBe(PROCESS_OUTPUT_HELD_MAX);
    expect(next.text.endsWith('tail')).toBe(true);
    expect(next.skipped).toBe(true);
  });
});
