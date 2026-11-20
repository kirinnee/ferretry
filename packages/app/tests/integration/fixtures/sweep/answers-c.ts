import type { TransportAnswer, TransportRequest } from '../../../../src/client/transport.ts';
import { json } from '../../../unit/client/fixtures.ts';
import runtimesReads from '../runtimes-reads.json';

/**
 * Fixed FAKE answers for part of the settings sweep (see `../settings-sweep-register.ts`): MCP, Skills, Shells, Claude Code, Codex,
 * Logins, Runtimes (all six tabs) and Usage. `undefined` = not mine. Machine `workshop-host`; no real home, login, key or token.
 */

const MACHINE = 'workshop-host';
const reads = runtimesReads as unknown as Record<string, Record<string, unknown>>;
const AT = '2026-11-18T09:30:00.000Z';
const LATER = '2026-11-19T17:45:00.000Z';
const hash = (seed: string): string => `sha256-${seed.repeat(43).slice(0, 43)}=`;

// ── MCP ──────────────────────────────────────────────────────────────────────────────────────────────
const signedIn = {
  component: 'docs-search',
  state: 'signed-in',
  issuer: 'https://auth.docs.example.test',
  signedInAt: AT,
  expiresAt: '2026-12-18T09:30:00.000Z',
  renewable: true,
  scope: 'read search',
  secrets: ['MCP_DOCS_SEARCH_TOKEN'],
};
const mcpServers = {
  servers: [
    {
      id: 'docs-search',
      name: 'docs-search',
      scope: 'ferretry',
      harness: 'claude-code',
      transport: 'http',
      target: 'https://mcp.docs.example.test/v1',
      source: 'config/mcp/docs-search.yaml',
      runtimes: [{ runtime: 'claude-default', approval: 'approved' }, { runtime: 'codex-default' }],
      signIn: { subject: 'docs-search', required: true },
      connection: signedIn,
    },
    {
      id: 'tracker',
      name: 'tracker',
      scope: 'ferretry',
      harness: 'claude-code',
      transport: 'http',
      target: 'https://mcp.tracker.example.test/sse',
      source: 'config/mcp/tracker.yaml',
      runtimes: [{ runtime: 'claude-agent', approval: 'pending' }],
      signIn: { subject: 'tracker', required: true },
      connection: { component: 'tracker', state: 'needs-sign-in', renewable: false, secrets: [] },
    },
    {
      id: 'files',
      name: 'files',
      scope: 'user',
      harness: 'claude-code',
      transport: 'stdio',
      target: 'files-mcp',
      source: '/home/workshop/.claude.json',
      runtimes: [{ runtime: 'claude-default', approval: 'approved' }],
    },
    {
      id: 'build-logs',
      name: 'build-logs',
      scope: 'project',
      harness: 'claude-code',
      transport: 'stdio',
      target: 'bunx',
      source: '/home/workshop/work/sample-app/.mcp.json',
      project: { root: '/home/workshop/work/sample-app', name: 'sample-app' },
      runtimes: [{ runtime: 'claude-review', approval: 'disabled' }],
    },
    {
      id: 'notes',
      name: 'notes',
      scope: 'user',
      harness: 'codex',
      transport: 'stdio',
      target: 'notes-mcp',
      source: '/home/workshop/.codex/config.toml',
      runtimes: [{ runtime: 'codex-default' }],
    },
  ],
  problems: [],
};

// ── Skills ───────────────────────────────────────────────────────────────────────────────────────────
const skill = (name: string, description: string, harness: string, scope: string, runtimes: string[]) => ({
  name,
  description,
  harness,
  scope,
  path: `/home/workshop/skills/${name}/SKILL.md`,
  runtimes,
  ...(scope === 'ferretry' ? { toggle: { supported: true, enabled: true } } : {}),
});
const skills = {
  homes: [
    {
      runtime: 'claude-default',
      harness: 'claude-code',
      home: '/home/workshop/.ferretry/homes/claude-default',
      skills: [
        skill('review-diff', 'Review the current diff for bugs and unclear names.', 'claude-code', 'ferretry', [
          'claude-default',
        ]),
        skill('write-changelog', 'Draft a changelog entry from merged pull requests.', 'claude-code', 'ferretry', [
          'claude-default',
        ]),
        skill('summary', 'Recap the current work in a few plain lines.', 'claude-code', 'user', ['claude-default']),
      ],
    },
    {
      runtime: 'codex-default',
      harness: 'codex',
      home: '/home/workshop/.ferretry/homes/codex-default',
      skills: [
        skill('review-diff', 'Review the current diff for bugs and unclear names.', 'codex', 'ferretry', [
          'codex-default',
        ]),
      ],
    },
  ],
  projects: [
    {
      name: 'sample-app',
      root: '/home/workshop/work/sample-app',
      skills: [
        {
          ...skill('release-notes', 'Write release notes in the sample-app house style.', 'claude-code', 'project', [
            'claude-default',
          ]),
          project: { root: '/home/workshop/work/sample-app' },
        },
      ],
    },
  ],
  truncated: false,
};

// ── Shells ───────────────────────────────────────────────────────────────────────────────────────────
const shells = {
  shells: [
    {
      name: 'default',
      description: 'Everyday tools for every ferret.',
      kind: 'packages',
      locked: true,
      floating: false,
      narHash: hash('A'),
      build: 'built',
      usedBy: ['claude-default', 'codex-default'],
    },
    {
      name: 'web',
      description: 'Node, bun and a browser for web work.',
      kind: 'flake',
      locked: true,
      floating: false,
      narHash: hash('B'),
      build: 'built',
      usedBy: ['sample-app'],
    },
    {
      name: 'rust-lab',
      description: 'A Rust toolchain from a moving branch.',
      kind: 'flake',
      locked: true,
      floating: true,
      narHash: hash('C'),
      build: 'not-built',
      usedBy: [],
    },
  ],
};

// ── Claude Code / Codex (one view per harness) ───────────────────────────────────────────────────────
const harnessView = (
  harness: 'claude-code' | 'codex',
  path: string,
  version: string,
  latest: string,
  native: boolean,
) => ({
  harness,
  location: { state: 'located', path, rule: 'on-path', declaredBy: 'config/harnesses.yaml' },
  installed: { state: 'ok', version },
  method: native
    ? { kind: 'native-installer', directory: '/home/workshop/.local/bin' }
    : { kind: 'npm-global', tool: 'npm', package: '@example/codex', prefix: '/home/workshop/.npm-global' },
  plan: {
    kind: 'self',
    steps: [{ command: harness === 'codex' ? 'npm install -g @example/codex@latest' : 'claude update' }],
    rollback: 'automatic',
    pinsVersion: false,
  },
  check: {
    state: 'ok',
    checkedAt: LATER,
    latest: { version: latest, url: `https://releases.example.test/${harness}/${latest}`, publishedAt: AT },
  },
  verified: { version, url: `https://releases.example.test/${harness}/${version}` },
  verification: harness === 'claude-code' ? 'unverified' : 'verified',
  available: latest !== version,
  job: null,
});

// ── Runtimes (recorded reads, renamed to this machine) ───────────────────────────────────────────────
const scan = {
  machine: MACHINE,
  format: 'present',
  tools: [
    { harness: 'claude-code', label: 'Claude Code', installed: true },
    { harness: 'codex', label: 'Codex', installed: true },
  ],
  harnesses: [
    {
      harness: 'claude-code',
      installed: true,
      account: { state: 'signed-in', email: 'you@example.com' },
      instructions: { name: 'CLAUDE.md', source: '~/.claude/CLAUDE.md', bytes: 2_048 },
      settings: { source: '~/.claude/settings.json', count: 6, hooks: 1 },
      mcpServers: ['files'],
      skills: ['summary'],
      secretKeys: [],
      missingCommands: [],
      problems: [],
    },
    {
      harness: 'codex',
      installed: true,
      account: { state: 'signed-in', email: 'you@example.com' },
      instructions: { name: 'AGENTS.md', source: '~/.codex/AGENTS.md', bytes: 1_024 },
      settings: { source: '~/.codex/config.toml', count: 4, hooks: 0 },
      mcpServers: ['notes'],
      skills: [],
      codexProfiles: [{ name: 'careful', model: 'gpt-fake-1', effort: 'high' }],
      secretKeys: [],
      missingCommands: [],
      problems: [],
    },
  ],
  instructionsIdentical: false,
  runtimes: [
    { harness: 'claude-code', name: 'claude-imported', profile: 'claude-imported' },
    { harness: 'codex', name: 'codex-imported', profile: 'codex-imported' },
  ],
  updates: [],
  duplicates: [],
  notes: [{ harness: 'claude-code', text: 'Hooks are counted but never imported.' }],
  importing: { available: true },
};

const runtimesRead = (route: string): Record<string, unknown> | undefined => {
  const body = reads[route];
  if (body === undefined) return undefined;
  const named = 'machine' in body ? { ...body, machine: MACHINE } : 'name' in body ? { ...body, name: MACHINE } : body;
  return named;
};

// ── Usage ────────────────────────────────────────────────────────────────────────────────────────────
const period = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  trigger: 40,
  hard: 60,
  spentUsd: 12.4,
  level: 'ok',
  startsAt: '2026-11-19T08:00:00.000Z',
  resetsAt: '2026-11-20T08:00:00.000Z',
  ...overrides,
});
const budget = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  timeZone: 'America/Los_Angeles',
  timeZoneSet: true,
  daily: period(),
  weekly: period({ trigger: 200, hard: 300, spentUsd: 150.01, resetsAt: '2026-11-23T08:00:00.000Z' }),
  level: 'ok',
  unpriced: 0,
  measured: true,
  ...overrides,
});
const budgets = {
  budgets: [
    { login: 'claude-personal', budget: budget() },
    {
      login: 'claude-work',
      budget: budget({ level: 'over_trigger', daily: period({ level: 'over_trigger', spentUsd: 44 }) }),
    },
  ],
};
const rate = (modelId: string, provider: 'openai' | 'anthropic', manual: boolean) => ({
  pricingKey: `${provider}:${modelId}:2026-08`,
  modelId,
  aliases: [`${modelId}-2026-08-01`],
  provider,
  currency: 'USD',
  rates: {
    input: 1_250_000,
    output: 10_000_000,
    cachedInput: 125_000,
    cacheWrite: null,
    cacheWrite5m: null,
    cacheWrite1h: null,
    reasoning: 2_000_000,
    image: null,
    tool: null,
  },
  source: manual
    ? { kind: 'manual' }
    : { kind: 'provider_sync', provider, sourceUrl: 'https://pricing.example.test/openai.json' },
  validFrom: '2026-08-01T00:00:00.000Z',
  validThrough: null,
  verifiedAt: '2026-08-01T08:00:00.000Z',
  lastSyncedAt: manual ? null : '2026-08-05T12:00:00.000Z',
});
const pricing = {
  catalog: [rate('gpt-fake-1', 'openai', false), rate('claude-fake-1', 'anthropic', true)],
  catalogFingerprint: 'catalog-current',
  sources: [
    {
      id: 'openai-feed',
      provider: 'openai',
      url: 'https://pricing.example.test/openai.json',
      enabled: true,
      lastSyncedAt: null,
    },
    {
      id: 'anthropic-feed',
      provider: 'anthropic',
      url: 'https://pricing.example.test/anthropic.json',
      enabled: false,
      lastSyncedAt: null,
    },
  ],
  sourcesFingerprint: 'sources-current',
  rateApplicability: {
    input: 'applied_when_evidenced',
    output: 'applied_when_evidenced',
    cachedInput: 'applied_when_evidenced',
    cacheWrite: 'applied_when_evidenced',
    cacheWrite5m: 'applied_when_evidenced',
    cacheWrite1h: 'applied_when_evidenced',
    reasoning: 'applied_when_evidenced',
    image: 'stored_not_applied',
    tool: 'stored_not_applied',
  },
  modelCatalogRates: [],
};

const ANSWERS: Readonly<Record<string, () => unknown>> = {
  'GET /v1/mcp': () => mcpServers,
  'GET /v1/mcp/auth': () => ({ connections: [signedIn, mcpServers.servers[1]?.connection] }),
  'GET /v1/skills': () => skills,
  'GET /v1/shells': () => shells,
  'GET /v1/shells/nix': () => ({ present: true, version: '2.24.0', path: '/nix/var/nix/profiles/default/bin/nix' }),
  'GET /v1/claude-code/update': () =>
    harnessView('claude-code', '/home/workshop/.local/bin/claude', '2.1.40', '2.1.44', true),
  'GET /v1/codex/update': () => harnessView('codex', '/home/workshop/.npm-global/bin/codex', '0.9.2', '0.9.3', false),
  'GET /v1/runtimes/setup/scan': () => scan,
  'GET /v1/usage/budgets': () => budgets,
  'GET /v1/usage/pricing': () => pricing,
};

export const answer = (request: TransportRequest): TransportAnswer | undefined => {
  const route = `${request.method} ${request.path.split('?')[0] ?? ''}`;
  const fixed = ANSWERS[route];
  if (fixed !== undefined) return json(fixed());
  if (request.method !== 'GET') return undefined;
  const recorded = runtimesRead(route);
  if (recorded === undefined) return undefined;
  // The recorded usage windows have reset by now: move them ahead so the bars say "resets in…" rather than "resets now".
  return json(
    route === 'GET /v1/logins'
      ? JSON.parse(
          JSON.stringify(recorded).replaceAll('2026-10-13T', '2026-11-21T').replaceAll('2026-10-16T', '2026-11-24T'),
        )
      : recorded,
  );
};
