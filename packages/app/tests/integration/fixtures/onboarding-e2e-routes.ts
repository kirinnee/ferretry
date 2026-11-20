/**
 * The first-run routes the step pages call, answered over made-up data (no real name, path, login or key). Layered over the
 * machine's own state (`FakeDaemon`) and under `mobile-fake-daemon.ts`'s ordinary reads.
 */
import type { TransportAnswer, TransportRequest } from '../../../src/client/transport.ts';
import { json } from '../../unit/client/fixtures.ts';
import type { FakeDaemon } from './onboarding-e2e-daemon.ts';
import { answerFor } from './mobile-fake-daemon.ts';

type Handler = unknown | ((request: TransportRequest) => unknown);

const CHANGE_ID = 'fy_fprop_abcdefghijklmnopqrstuv';

/** One harness the made-up host has: signed in, with something of every kind to bring over. */
const harness = (name: 'claude-code' | 'codex') => ({
  harness: name,
  installed: true,
  account: { state: 'signed-in', email: 'sam@example.test' },
  instructions: {
    name: name === 'codex' ? 'AGENTS.md' : 'CLAUDE.md',
    source: name === 'codex' ? '~/.codex/AGENTS.md' : '~/.claude/CLAUDE.md',
    bytes: 2_048,
  },
  settings: {
    source: name === 'codex' ? '~/.codex/config.toml' : '~/.claude/settings.json',
    count: 7,
    hooks: name === 'codex' ? 0 : 3,
  },
  mcpServers: name === 'codex' ? ['docs'] : ['notes', 'issues'],
  skills: name === 'codex' ? ['review'] : ['review', 'release-notes'],
  secretKeys: name === 'codex' ? [] : ['env.ANTHROPIC_API_KEY'],
  missingCommands: [],
  problems: [],
});

/** The made-up host: Claude Code AND Codex installed and signed in. Written out longhand (no other plugin's test fixture is imported). */
const scan = {
  machine: 'studio-mac',
  format: 'none',
  tools: [
    { harness: 'claude-code', label: 'Claude Code', installed: true },
    { harness: 'codex', label: 'Codex', installed: true },
  ],
  harnesses: [harness('claude-code'), harness('codex')],
  runtimes: [
    { harness: 'claude-code', name: 'claude-code-default', profile: 'Default' },
    { harness: 'codex', name: 'codex-default', profile: 'Default' },
  ],
  updates: [],
  duplicates: [],
  notes: [],
  importing: { available: true },
};

/** The routes the import pages read and write on a fake machine. */
const importRoutes = (): Record<string, unknown> => ({
  'GET /v1/runtimes/setup/scan': scan,
  'GET /v1/runtimes/machine': {
    name: 'studio-mac',
    format: 'present',
    setUp: true,
    agentPermissions: 'auto',
    defaultRuntime: 'claude-default',
    agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
    browserMode: 'headless',
    browserProxy: null,
    browserPorts: 'random',
    browserFirewallFailure: 'warn',
    autoResume: true,
    agendaMode: false,
    publicUsageFeed: false,
    lastAutoResume: null,
    tools: [
      { harness: 'claude-code', label: 'Claude Code', installed: true, command: '/fake/bin/claude' },
      { harness: 'codex', label: 'Codex', installed: true, command: '/fake/bin/codex' },
    ],
    runtimeCount: 2,
    runningSessions: 0,
    authority: { mayApply: true, applyRefusal: 'granted' },
  },
  'POST /v1/runtimes/proposals': (call: TransportRequest) => ({
    id: CHANGE_ID,
    revision: 'r1',
    change: (call.body as { change: unknown }).change,
    summary: 'A change',
    consequences: [],
    expiresAt: '2026-10-13T08:15:00.000Z',
    state: 'pending',
    preview: { kind: 'executor', executor: 'setup', description: 'Import.' },
  }),
  'POST /v1/runtimes/proposals/:proposalId/apply': {
    outcome: 'executed',
    executor: 'setup',
    summary: 'Runtimes: claude-code-default. Written by the parts that own them: mcp/notes.yaml, skills/review.yaml.',
  },
});

/** A route table whose keys may carry `:param` segments. */
const matcher = (table: Readonly<Record<string, Handler>>) => {
  const rows = Object.entries(table).map(([key, handler]) => {
    const [method = '', path = ''] = key.split(' ');
    const pattern = new RegExp(`^${path.replace(/:[A-Za-z]+/gu, '[^/]+')}$`, 'u');
    return { method, pattern, handler };
  });
  return (request: TransportRequest): TransportAnswer | undefined => {
    const row = rows.find(candidate => candidate.method === request.method && candidate.pattern.test(request.path));
    if (row === undefined) return undefined;
    return json(
      typeof row.handler === 'function' ? (row.handler as (r: TransportRequest) => unknown)(request) : row.handler,
    );
  };
};

export const extraRoutes = (fake: FakeDaemon) => {
  const table = importRoutes();
  const answer = matcher({
    ...table,
    'GET /v1/codex/update': { installed: { state: 'ok', version: '0.166.0' }, location: { state: 'found' } },
    'GET /v1/claude-code/update': { installed: { state: 'ok', version: '2.1.0' }, location: { state: 'found' } },
    // Only the second machine has no passkey yet and its first window open: its Passkey step is asked.
    'GET /v1/passkeys': () => ({
      ...(answerFor({ method: 'GET', path: '/v1/passkeys' })?.body as object),
      ...(fake.machine.name === 'travel-laptop' ? { passkeys: [], registration: 'first-window' } : {}),
    }),
    'GET /v1/shells/nix': { present: true, version: '2.24.0', path: '/nix/var/nix/profiles/default/bin/nix' },
    'GET /v1/config/file': (request: TransportRequest) => ({
      path: String(request.query?.path ?? 'harness-claude-code.yaml'),
      text: String(request.query?.path ?? '').includes('warden')
        ? ''
        : String(request.query?.path ?? '').includes('host')
          ? ''
          : 'binary: /fake/bin/claude\npermissionMode: skip\n',
      etag: 'e1',
      exists: !/warden|host/u.test(String(request.query?.path ?? '')),
    }),
    'PUT /v1/config/file': (request: TransportRequest) => {
      fake.writes.push({ route: 'PUT /v1/config/file', body: request.body });
      return {
        path: (request.body as { path?: string } | undefined)?.path ?? 'file.yaml',
        etag: 'e2',
        outcome: 'applied',
      };
    },
    'PATCH /v1/warden/config': (request: TransportRequest) => {
      fake.writes.push({ route: 'PATCH /v1/warden/config', body: request.body });
      const base = answerFor({ method: 'GET', path: '/v1/warden/config' })?.body as object;
      return { ...base, ...(request.body as object) };
    },
  });
  return (request: TransportRequest): TransportAnswer | undefined => answer(request);
};
