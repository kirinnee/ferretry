import type { TransportAnswer, TransportRequest } from '../../../../src/client/transport.ts';
import { json } from '../../../unit/client/fixtures.ts';
import { audit, passkeys, pairedView, security } from '../access-settings-data.ts';

/**
 * Fixed FAKE answers for part of the settings sweep (see `../settings-sweep-register.ts`): the kernel's tabs (name, doctor,
 * host checks, files), the vault's secrets, accounts (accounts, secure copy), git accounts, connections and access.
 * One fake machine, `workshop-host`; no real home, key, login, token or pairing code. `undefined` = not mine.
 */

const AT = '2026-11-18T10:00:00.000Z';
const HOME = '/home/workshop/.config/ferretry';

// ─── kernel ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const check = (name: string, requirement: string, status: string, summary: string, impact: string) => ({
  name,
  requirement,
  status,
  summary,
  impact,
});

const doctor = {
  checks: [
    check('git', 'required', 'present', 'git 2.47 found on PATH.', 'Sessions cannot work in a repository without it.'),
    check('tmux', 'required', 'present', 'tmux 3.5 found on PATH.', 'Terminals cannot be kept alive without it.'),
    check(
      'claude',
      'capability',
      'present',
      'claude found at /usr/local/bin/claude.',
      'Claude Code ferrets cannot start.',
    ),
    check('codex', 'capability', 'present', 'codex found at /usr/local/bin/codex.', 'Codex ferrets cannot start.'),
    check(
      'gh',
      'optional',
      'missing',
      'gh was not found on PATH.',
      'GitHub sign-in by the command line is unavailable.',
    ),
    check(
      'cloudflared',
      'alternative',
      'not_applicable',
      'The tunnel carrier is off on this machine.',
      'Nothing to do.',
    ),
  ],
  harnesses: [
    { kind: 'claude', launchable: ['work', 'personal'], blocked: [] },
    { kind: 'codex', launchable: ['default'], blocked: ['trial'] },
  ],
  ready: true,
  limitation: 'This report shows what is installed, not whether a harness is signed in.',
};

const FILES = [
  ['host.yaml', 'kernel', 'ok'],
  ['warden.yaml', 'warden', 'ok'],
  ['learning.yaml', 'lessons', 'ok'],
  ['voice.yaml', 'voice', 'ok'],
  ['limits.yaml', 'ferrets', 'pending'],
  ['logins/work.yaml', 'logins', 'ok'],
  ['logins/personal.yaml', 'logins', 'ok'],
  ['runtimes/claude-work.yaml', 'runtimes', 'ok'],
  ['runtimes/codex-default.yaml', 'runtimes', 'invalid'],
  ['accounts.yaml', 'accounts', 'ok'],
] as const;

const configStatus = {
  directory: HOME,
  files: FILES.map(([path, kind, state]) => ({ path, kind, state })),
  issues: [
    {
      path: 'runtimes/codex-default.yaml',
      line: 4,
      column: 3,
      severity: 'error',
      message: 'model "gpt-fake" is not one this runtime offers.',
      fix: 'Pick a model from the list in Settings › Runtimes.',
    },
  ],
  pending: [
    {
      path: 'limits.yaml',
      etag: 'etag-limits-2',
      changes: ['Raises the memory cap for each ferret from 6 GiB to 12 GiB.'],
    },
  ],
};

const configFile = (path: string) => ({
  path,
  absolutePath: `${HOME}/${path}`,
  exists: true,
  text: path === 'host.yaml' ? 'name: "workshop-host"\n' : '# a fake file for the settings sweep\nenabled: true\n',
  etag: `etag-${path}`,
});

// ─── vault, accounts, git accounts ──────────────────────────────────────────────────────────────────────────────────

const secrets = {
  v: 1,
  health: 'ready',
  secrets: [
    { name: 'VERCEL_TOKEN', createdAt: '2026-10-02T09:00:00.000Z', updatedAt: '2026-11-01T09:00:00.000Z' },
    { name: 'NPM_PUBLISH_KEY', createdAt: '2026-10-12T09:00:00.000Z', updatedAt: '2026-10-12T09:00:00.000Z' },
    { name: 'STAGING_DB_URL', createdAt: '2026-11-05T09:00:00.000Z', updatedAt: '2026-11-05T09:00:00.000Z' },
  ],
  references: [
    { name: 'VERCEL_TOKEN', origin: 'config/daemon.json → agentEnvironment.VERCEL_TOKEN', resolved: true },
    { name: 'OLD_API_KEY', origin: 'config/mcp.yaml → servers.search.env.API_KEY', resolved: false },
  ],
};

const sms = {
  id: 'tf_000000000001',
  kind: 'sms',
  label: 'Phone',
  endsWith: '42',
  addedAt: AT,
  addedBy: 'owner',
  automatic: false,
};
const totp = {
  id: 'tf_000000000002',
  kind: 'totp',
  label: 'Authenticator app',
  params: { algorithm: 'SHA1', digits: 6, period: 30 },
  addedAt: AT,
  addedBy: 'owner',
  automatic: true,
  verified: { worked: true, at: AT },
};
const account = (id: string, label: string, over: object = {}) => ({
  id,
  label,
  fields: { password: true },
  factors: [],
  signIns: [],
  createdAt: AT,
  updatedAt: AT,
  ...over,
});
const signIn = (id: string, accountId: string, place: object, method: object = { kind: 'password' }) => ({
  id,
  account: accountId,
  place,
  method,
  createdAt: AT,
  updatedAt: AT,
});

const accounts = {
  v: 1,
  health: 'ready',
  accounts: [
    account('GITHUB', 'GitHub', { username: 'workshop-user', factors: [sms, totp], signIns: ['si_0000000000000001'] }),
    account('GITHUB_WORK', 'GitHub (work)', { username: 'user@work.example.test', signIns: ['si_0000000000000002'] }),
    account('VERCEL', 'Vercel', { fields: { password: false }, signIns: ['si_0000000000000003'] }),
    account('GOOGLE', 'Google'),
  ],
  signIns: [
    signIn('si_0000000000000001', 'GITHUB', { kind: 'site', domains: ['github.com'], match: [] }),
    signIn('si_0000000000000002', 'GITHUB_WORK', { kind: 'site', domains: ['github.com'], match: [] }),
    {
      ...signIn(
        'si_0000000000000003',
        'VERCEL',
        { kind: 'site', domains: ['vercel.com'], match: ['app.vercel.com'] },
        { kind: 'sso', name: 'Google', via: 'GOOGLE' },
      ),
      via: { account: { id: 'GOOGLE', label: 'Google' } },
    },
  ],
};

const copyRules = {
  rules: [
    {
      id: 'a'.repeat(32),
      from: { kind: 'command', program: 'vercel' },
      to: { kind: 'terminal', program: 'gh' },
      used: 4,
      remaining: 6,
      expiresAt: '2026-12-01T00:00:00.000Z',
      createdAt: AT,
      createdBy: { kind: 'host' },
    },
    {
      id: 'b'.repeat(32),
      from: { kind: 'browser', origin: 'https://dashboard.example.test' },
      to: { kind: 'secret', name: 'VERCEL_TOKEN' },
      used: 1,
      createdAt: AT,
      createdBy: { kind: 'host' },
    },
  ],
};

const gitAccounts = [
  {
    id: 'gha_1000001',
    provider: 'github',
    githubId: 1000001,
    login: 'workshop-user',
    name: 'Workshop User',
    scopes: ['repo', 'read:org'],
    keys: {
      ssh: { githubKeyId: '555001', title: 'workshop-host (ferretry)', source: 'generated' },
      signing: { title: 'workshop-host signing', source: 'generated' },
    },
    createdAt: AT,
  },
  {
    id: 'gha_1000002',
    provider: 'github',
    githubId: 1000002,
    login: 'workshop-work',
    scopes: ['repo'],
    keys: {},
    createdAt: AT,
  },
];

// ─── connections ────────────────────────────────────────────────────────────────────────────────────────────────────

const carriers = {
  carriers: [
    { kind: 'direct', url: 'https://workshop.example.test' },
    { kind: 'relay', url: 'wss://relay.example.test', source: 'configured' },
  ],
};
const tunnel = { enabled: false, explicit: false, state: 'off', tunnelUrl: null, sentence: 'The tunnel is off.' };

// ─── the answers ────────────────────────────────────────────────────────────────────────────────────────────────────

export const answer = (request: TransportRequest): TransportAnswer | undefined => {
  if (request.method !== 'GET') return undefined;
  const [path = '', query = ''] = request.path.split('?');
  switch (path) {
    case '/v1/doctor':
      return json(doctor);
    case '/v1/config/status':
      return json(configStatus);
    case '/v1/config/file': {
      // Only the machine name file is mine; packs, browsers, board and warden files are answered by the other parts.
      const file = request.query?.path ?? new URLSearchParams(query).get('path') ?? 'host.yaml';
      return file === 'host.yaml' ? json(configFile(file)) : undefined;
    }
    case '/v1/secrets':
      return json(secrets);
    case '/v1/accounts':
      return json(accounts);
    case '/v1/accounts/plans':
      return json({ plans: [] });
    case '/v1/sign-in-rules':
      return json({ health: 'ok', rules: [], stages: [] });
    case '/v1/copy-rules':
      return json(copyRules);
    case '/v1/copy-rules/settings':
      return json({ settings: { allowProfileTargets: false }, profileRules: [] });
    case '/v1/copy-rules/stages':
      return json({ stages: [] });
    case '/v1/git-accounts':
      return json(gitAccounts);
    case '/v1/carriers':
      return json(carriers);
    case '/v1/tunnel':
      return json(tunnel);
    case '/v1/pair/devices':
      return json(pairedView);
    case '/v1/passkeys':
      return json(passkeys);
    case '/v1/security':
      return json(security);
    case '/v1/audit':
      return json(audit);
    default:
      return undefined;
  }
};
