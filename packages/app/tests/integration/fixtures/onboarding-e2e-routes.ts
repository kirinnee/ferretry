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

/** `?projects=fresh`: the machine holds NO project until the Projects page registers one (and one account is already connected). */
const FRESH = new URLSearchParams(globalThis.location?.search ?? '').get('projects') === 'fresh';
/** The registry of a fresh machine: what the Projects page registered, and the accounts a link put on it. */
const registry = new WeakMap<FakeDaemon, { projects: Record<string, unknown>[] }>();
const MADE_PROJECT = {
  id: '55555555-5555-4555-8555-555555555555',
  name: 'atlas',
  path: '/home/sam/atlas',
  source: 'existing-folder',
  createdAt: '2026-11-20T10:00:00.000Z',
};
/** The Projects page's routes on a fresh machine: an empty registry, one folder to pick, the registration, and the account link. */
const projectRoutes = (fake: FakeDaemon): Record<string, Handler> => {
  const state = registry.get(fake) ?? { projects: [] };
  registry.set(fake, state);
  return {
    'GET /v1/projects': () => state.projects,
    'GET /v1/projects/folders': (request: TransportRequest) => ({
      path: String(request.query?.path ?? '/home/sam/atlas'),
      crumbs: [{ name: '~', path: '/home/sam' }],
      entries: [],
      truncated: false,
    }),
    'POST /v1/projects': (request: TransportRequest) => {
      fake.writes.push({ route: 'POST /v1/projects', body: request.body });
      if (!state.projects.some(project => project.id === MADE_PROJECT.id)) state.projects.push({ ...MADE_PROJECT });
      return MADE_PROJECT;
    },
    'PUT /v1/projects/:id/accounts': (request: TransportRequest) => {
      fake.writes.push({ route: 'PUT /v1/projects/:id/accounts', body: request.body });
      const row = state.projects[0] ?? { ...MADE_PROJECT };
      state.projects[0] = { ...row, accounts: (request.body as { accounts: string[] }).accounts };
      return state.projects[0];
    },
  };
};

/** The made-up GitHub accounts a machine holds: none at the start (one on a fresh machine); the device flow below adds one. Never a token. */
const github = new WeakMap<FakeDaemon, { accounts: object[]; polls: number }>();
const FAKE_ACCOUNT = {
  id: 'gha_7',
  provider: 'github',
  githubId: 4_242,
  login: 'hubot-fake',
  scopes: ['repo'],
  keys: {},
  createdAt: '2026-11-20T10:00:00.000Z',
};
/** Git accounts' routes on a fake machine: list, start the device flow, and a poll that is pending once, then approved. */
const githubRoutes = (fake: FakeDaemon): Record<string, Handler> => {
  const state = github.get(fake) ?? { accounts: FRESH ? [{ ...FAKE_ACCOUNT }] : [], polls: 0 };
  github.set(fake, state);
  return {
    'GET /v1/git-accounts': () => state.accounts,
    'POST /v1/git-accounts/github/device': () => {
      state.polls = 0;
      return {
        flowId: 'flow_0123456789abcdef',
        provider: 'github',
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        interval: 1,
      };
    },
    'GET /v1/git-accounts/github/device/:flowId': () => {
      state.polls += 1;
      if (state.polls < 2) return { status: 'pending', interval: 1 };
      if (state.accounts.length === 0) state.accounts.push(FAKE_ACCOUNT);
      return { status: 'done', accountId: FAKE_ACCOUNT.id, login: FAKE_ACCOUNT.login };
    },
  };
};

export const extraRoutes = (fake: FakeDaemon) => {
  const table = importRoutes();
  const answer = matcher({
    ...table,
    ...githubRoutes(fake),
    ...(FRESH ? projectRoutes(fake) : {}),
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
    // The Jev key lives in the fake machine's vault: absent until the person's Save, named in warden.yaml only by a save
    // that asks for it (`nameJevKey`, ONE write with the answer). The value is held here only to be compared, never answered.
    'GET /v1/speedups': () => {
      const base = answerFor({ method: 'GET', path: '/v1/speedups' })?.body as {
        providers: { provider: string; set: boolean; lastTest?: unknown }[];
      };
      return {
        ...base,
        providers: base.providers.map(provider =>
          provider.provider === 'jev'
            ? { ...provider, set: fake.vault.has('JEV_API_KEY'), lastTest: undefined }
            : provider,
        ),
      };
    },
    'POST /v1/secrets': (request: TransportRequest) => {
      const body = request.body as { name?: string; value?: string };
      fake.writes.push({ route: 'POST /v1/secrets', body });
      fake.vault.set(String(body.name), String(body.value));
      return { name: body.name, set: true };
    },
    'POST /v1/speedups/jev/test': () => ({
      provider: 'jev',
      secretName: 'JEV_API_KEY',
      ok: true,
      code: 'ok',
      message: 'The key works.',
      latencyMs: 120,
      at: new Date().toISOString(),
    }),
    // A first run: the layers are what a new machine carries (both off, rules only) until a write turns one on.
    'GET /v1/warden/config': () => {
      const base = answerFor({ method: 'GET', path: '/v1/warden/config' })?.body as { config: object };
      return {
        ...base,
        config: { ...base.config, layers: fake.layers },
        jevKey: fake.jevNamed ? 'named' : 'not_named',
      };
    },
    'PATCH /v1/warden/config': (request: TransportRequest) => {
      fake.writes.push({ route: 'PATCH /v1/warden/config', body: request.body });
      const { nameJevKey, ...patch } = (request.body ?? {}) as { nameJevKey?: boolean; layers?: typeof fake.layers };
      if (nameJevKey === true) fake.jevNamed = true;
      if (patch.layers !== undefined) fake.layers = patch.layers;
      const base = answerFor({ method: 'GET', path: '/v1/warden/config' })?.body as { config: object };
      return {
        ...base,
        config: { ...base.config, ...patch, layers: fake.layers },
        jevKey: fake.jevNamed ? 'named' : 'not_named',
      };
    },
  });
  return (request: TransportRequest): TransportAnswer | undefined => answer(request);
};
