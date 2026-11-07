/** One ferret's processes as the daemon lists them: every kind, a child, an ended failure and unreadable output. */

import type { SessionProcess, SessionProcessList, SessionProcessOutput } from '@ferretry/protocol';

export const PROCESSES_NOW = Date.parse('2026-10-29T12:00:00.000Z');

const ago = (seconds: number): string => new Date(PROCESSES_NOW - seconds * 1000).toISOString();

const MB = 1024 * 1024;

export const WATCH_TESTS: SessionProcess = {
  id: '100.1',
  pid: 100,
  command: 'bun test --watch',
  commandTruncated: false,
  kind: 'command',
  state: 'running',
  startedAt: ago(134),
  cpuPercent: 12.4,
  rssBytes: 48 * MB,
  output: { source: 'file' },
  stoppable: true,
};

export const DEV_SERVER_PARENT: SessionProcess = {
  id: '200.2',
  pid: 200,
  command: 'bun run dev',
  commandTruncated: false,
  kind: 'background',
  state: 'sleeping',
  startedAt: ago(3900),
  rssBytes: 30 * MB,
  output: { source: 'file' },
  stoppable: true,
};

const DEV_SERVER_CHILD: SessionProcess = {
  id: '201.3',
  pid: 201,
  parentId: '200.2',
  command: 'vite --port 5173',
  commandTruncated: false,
  kind: 'server',
  state: 'sleeping',
  startedAt: ago(3899),
  cpuPercent: 0.4,
  rssBytes: 210 * MB,
  output: { source: 'file' },
  stoppable: true,
};

const MCP_HELPER: SessionProcess = {
  id: '300.4',
  pid: 300,
  command: 'fy mcp serve',
  commandTruncated: false,
  kind: 'helper',
  state: 'sleeping',
  startedAt: ago(7200),
  rssBytes: 64 * MB,
  output: { source: 'none', reason: 'Its output goes to the harness, not to a file.' },
  stoppable: false,
};

export const LINT_FAILED: SessionProcess = {
  id: '400.5',
  pid: 400,
  command: 'task lint',
  commandTruncated: false,
  kind: 'command',
  state: 'exited',
  startedAt: ago(400),
  endedAt: ago(180),
  exit: { code: 1, failed: true },
  output: { source: 'transcript' },
  stoppable: false,
};

export const TERMINAL_ONLY: SessionProcess = {
  id: '500.6',
  pid: 500,
  command: 'sleep 600',
  commandTruncated: false,
  label: 'Wait for the deploy',
  kind: 'background',
  state: 'running',
  startedAt: ago(20),
  output: { source: 'none', reason: 'It writes to the terminal, so there is no file to read. The Console shows it.' },
  stoppable: true,
};

export const processList = (
  processes: readonly SessionProcess[],
  extra: Partial<SessionProcessList> = {},
): SessionProcessList => ({
  sessionId: 'agent-session',
  observedAt: new Date(PROCESSES_NOW).toISOString(),
  available: true,
  processes: [...processes],
  ...extra,
});

export const ALL_PROCESSES = processList([
  WATCH_TESTS,
  DEV_SERVER_PARENT,
  DEV_SERVER_CHILD,
  MCP_HELPER,
  TERMINAL_ONLY,
  LINT_FAILED,
]);

export const outputAnswer = (
  processId: string,
  text: string,
  extra: Partial<SessionProcessOutput> = {},
): SessionProcessOutput => ({
  processId,
  source: 'file',
  text,
  start: 0,
  end: text.length,
  size: text.length,
  skipped: false,
  reset: false,
  complete: false,
  ...extra,
});

export const COLOURED_TEST_OUTPUT =
  '\u001b[1mbun test\u001b[0m v1.3.13\n\u001b[32m✓\u001b[0m adds numbers\n\u001b[31m✗ fails loudly\u001b[0m\n\u001b[2m 2 pass, 1 fail\u001b[0m\n';
