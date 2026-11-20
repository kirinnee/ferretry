import type { TransportAnswer, TransportRequest } from '../../../../src/client/transport.ts';
import { json } from '../../../unit/client/fixtures.ts';
import runtimes from '../runtimes-reads.json' with { type: 'json' };

/**
 * Fixed FAKE answers for part of the settings sweep (see `../settings-sweep-register.ts`): terminals, updates, browser, pack mode,
 * board, tidy, setup, lessons, warden, layout and speed-ups. One machine, 'workshop-host'; no real home, key, login or code.
 * `undefined` = not mine.
 */

const NOW = '2026-11-19T09:00:00.000Z';
const EARLIER = '2026-11-19T07:30:00.000Z';
const KEY_URL = 'https://example.invalid/keys';

// ─── configuration files (the kernel's `GET /v1/config/file?path=`) ────────────────────────────────────────────────

const FILES: Readonly<Record<string, string>> = {
  'packs.yaml': '# Pack mode on this machine\nenabled: true\n',
  'browsers.yaml': '# The shared browser\nmode: headless\n',
  'board.yaml': '# The project board\ngithub:\n  watch: true\n',
  'warden.yaml': '# The Warden\nenabled: true\n',
};

const configFile = (path: string): unknown => ({
  path,
  exists: path in FILES,
  text: FILES[path] ?? '',
  etag: `etag-${path}`,
});

// ─── terminals ─────────────────────────────────────────────────────────────────────────────────────────────────────

const holders = {
  limit: 24,
  open: 9,
  holders: [
    { sessionId: 'sess-hadi', label: 'hadi', standing: 'live', status: 'working', count: 3 },
    { sessionId: 'sess-mira', label: 'mira', standing: 'live', status: 'waiting', count: 2 },
    { sessionId: 'sess-oden', label: 'oden', standing: 'finished', status: 'completed', count: 3 },
    { sessionId: 'sess-pell', label: 'pell', standing: 'gone', status: 'removed', count: 1 },
  ],
};

const limits = {
  switchedOn: true,
  enforcement: 'cgroups',
  file: 'limits.yaml',
  lines: [
    'Ferrets together may use 56 GB of memory; the daemon keeps 4 GB for itself.',
    'Each ferret may use up to 14 GB of memory and 4 processor cores.',
    'Ferrets read and write the disk at the lowest priority.',
    'The daemon and voice get more processor time than any ferret when the machine is busy.',
  ],
  warnings: ['hadi is slowed for memory right now: it uses 13.2 GB of its 14 GB.'],
};

// ─── updates ───────────────────────────────────────────────────────────────────────────────────────────────────────

const standalone = { kind: 'standalone', directory: '/opt/ferretry' };
const update = {
  current: '4.28.0',
  method: standalone,
  plan: {
    kind: 'self',
    steps: [{ command: 'fy update', note: 'downloads, verifies and swaps the binaries in /opt/ferretry' }],
    rollback: 'automatic',
  },
  check: {
    state: 'ok',
    checkedAt: NOW,
    latest: { version: '4.29.0', url: 'https://example.invalid/releases/v4.29.0', publishedAt: EARLIER },
  },
  available: true,
  midTurn: 2,
  autoInstall: false,
  job: null,
};

// ─── browser ───────────────────────────────────────────────────────────────────────────────────────────────────────

const browserState = {
  state: 'running',
  startedAt: EARLIER,
  proxy: { url: 'http://proxy.example.invalid:3128', authenticated: true, bypassCount: 2 },
  firewall: { state: 'applied', appliedAt: EARLIER, detail: 'Only this user can reach the browser’s ports.' },
};

// ─── pack mode (the shape `GET /v1/pack` answers) ──────────────────────────────────────────────────────────────────

const model = (id: string, label: string, over: Record<string, unknown> = {}) => ({
  provider: 'anthropic',
  providerLabel: 'Anthropic',
  harness: 'claude-code',
  tier: 'balanced',
  efforts: [],
  runtimes: ['claude-main'],
  id,
  label,
  ...over,
});
const quota = (state: string, summary: string, leftPercent: number) => ({ state, leftPercent, windows: [], summary });

const pack = {
  config: {
    enabled: true,
    decision: 'agent',
    limits: { interactiveChildren: 20, autoChildren: 4, maxDepth: 2 },
    probe: { timeoutSeconds: 45, cacheSeconds: 180 },
    jev: { usdPerDay: 0.25 },
  },
  routing: {
    text: 'Planning, review and critical code → claude-opus-5-5 at max. Everyday work → claude-sonnet-5. Chores → claude-haiku-4-5.',
    source: 'file',
  },
  models: [
    model('claude-opus-5-5', 'Claude Opus 5.5', { tier: 'best', efforts: ['low', 'high', 'max'] }),
    model('claude-sonnet-5', 'Claude Sonnet 5'),
    model('claude-haiku-4-5', 'Claude Haiku 4.5', { tier: 'fast' }),
    model('gpt-6-astra', 'GPT-6 Astra', {
      provider: 'openai',
      providerLabel: 'OpenAI',
      harness: 'codex',
      tier: 'best',
      efforts: ['medium', 'high'],
      runtimes: ['codex-main'],
    }),
  ],
  available: [
    {
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      modelLabel: 'Claude Opus 5.5',
      harness: 'claude-code',
      tier: 'best',
      efforts: ['low', 'high', 'max'],
      runtime: 'claude-main',
      runtimes: 1,
      ready: true,
      quota: quota('plenty', '5h 12% · week 30%', 70),
      named: 1,
      effort: 'max',
      command: 'fy new --runtime claude-main --model claude-opus-5-5 --effort max',
    },
    {
      provider: 'openai',
      model: 'gpt-6-astra',
      modelLabel: 'GPT-6 Astra',
      harness: 'codex',
      tier: 'best',
      efforts: ['medium', 'high'],
      runtime: 'codex-main',
      runtimes: 1,
      ready: true,
      quota: quota('low', '5h 91% · week 64%', 9),
      named: 2,
    },
  ],
  cleanUp: { available: true, runtimes: ['codex-main', 'claude-main'] },
};

// ─── tidy ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const scratch = (ferret: string, name: string, bytes: number, eligible: boolean, reason?: string) => ({
  ferret,
  name,
  directory: `/workshop/scratch/${ferret}`,
  bytes,
  entries: [{ name: 'build', bytes, kind: 'directory' }],
  eligible,
  ...(reason === undefined ? {} : { reason }),
});
const tidy = [
  scratch('sess-oden', 'oden', 412_000_000, true),
  scratch('sess-pell', 'pell', 88_000_000, true),
  scratch('sess-hadi', 'hadi', 1_300_000_000, false, 'still running'),
  scratch('sess-mira', 'mira', 46_000_000, false, 'stopped less than a day ago'),
];

// ─── first-run steps ───────────────────────────────────────────────────────────────────────────────────────────────

const step = (
  plugin: string,
  id: string,
  title: string,
  order: number,
  state: string,
  over: Record<string, unknown> = {},
) => ({
  plugin,
  id,
  title,
  order,
  state,
  stepHost: true,
  ...(state === 'pending' ? {} : { at: EARLIER }),
  ...over,
});
const onboarding = {
  steps: [
    step('runtimes', 'start', 'Start fresh or copy', 10, 'done'),
    step('claude-code', 'installed', 'Install Claude Code', 20, 'found', { group: 'Claude Code' }),
    step('claude-code', 'sign-in', 'Sign in to Claude', 21, 'found', { group: 'Claude Code', linked: true }),
    step('onboarding', 'name', 'Name this machine', 5, 'done', { group: 'This machine' }),
    step('warden', 'warden', 'Let the Warden watch your ferrets?', 60, 'later', { group: 'Warden', side: 'daemon' }),
    step('lessons', 'lessons', 'Lessons', 70, 'pending'),
    step('shells', 'nix', 'Shells', 80, 'skipped', { group: 'Shells', side: 'daemon' }),
  ],
  complete: false,
  setUp: true,
};

// ─── lessons ───────────────────────────────────────────────────────────────────────────────────────────────────────

const lessonsConfig = {
  enabled: true,
  agent: 'claude',
  intervalMinutes: 60,
  batchSize: 20,
  maxMinersPerRun: 2,
  maxFerretsPerRun: 40,
  minSpawnGapMinutes: 30,
  passiveDefault: true,
};
const lessonsGlobal = {
  name: 'Global lessons document',
  text: '- Run every command through the project’s nix shell.\n- Keep replies short and lead with the answer.\n- Never merge a pull request for the owner.\n',
  etag: 'etag-global-lessons',
  notes: [],
};
const lessonsFerrets = [
  { ferretId: 'sess-hadi', passive: true, since: EARLIER, setBy: 'default' },
  { ferretId: 'sess-mira', passive: false, since: NOW, setBy: 'owner' },
  { ferretId: 'sess-oden', passive: true, since: EARLIER, setBy: 'default' },
];
const lessonsDirectory = [
  { ferretId: 'sess-hadi', name: 'hadi', folder: '/workshop/projects/lathe' },
  { ferretId: 'sess-mira', name: 'mira', folder: '/workshop/projects/lathe' },
  { ferretId: 'sess-oden', name: 'oden', folder: '/workshop/projects/kiln' },
];

// ─── warden ────────────────────────────────────────────────────────────────────────────────────────────────────────

const wardenConfig = {
  enabled: true,
  revive: {
    enabled: true,
    windowMinutes: 15,
    cooldownMinutes: 30,
    waveSize: 3,
    waveGapSeconds: 10,
    breakerMinutes: 30,
  },
  autoMove: {
    enabled: true,
    when: ['rate_limited', 'budget_exceeded'],
    targets: [],
    forceStopBackground: false,
    waitMinutes: 10,
    maxMovesPerHour: 1,
    minHeadroomPercent: 20,
  },
  layers: { jev: true, llm: true },
  guard: { threshold: 0.7, model: 'jev-latest', usdPerMillionInputTokens: 0.042 },
  caps: { jevUsdPerDay: 0.5, investigationUsdPerDay: 2, maxInvestigationsPerHour: 6 },
  mayActAlone: { nudge: true, resume: true, restart: true, failover: true, stop: false, closeLeftovers: true },
  jevActs: { nudge: 0.7, resume: 0.7, restart: 0.7, stop: 0.8 },
  events: { turnEnd: true, question: true, paneDied: true },
  investigation: { effort: 'low' },
  accounts: [{ agent: 'claude-default' }, { agent: 'codex-default' }],
  failover: { policy: 'fallback', failureThreshold: 2, cooldownMinutes: 30 },
  providerOutage: { minDistinctFerrets: 2, persistenceSweeps: 2, tailLines: 24 },
  intervalMinutes: 2,
  unattendedMinutes: 30,
  minSpawnGapMinutes: 15,
  susThinkingSeconds: 900,
  susSubprocessSeconds: 600,
  maxAssignedWardens: 1,
  assignedCooldownMinutes: 30,
  blessMinutes: 15,
};
const wardenConfigView = {
  config: wardenConfig,
  accounts: wardenConfig.accounts,
  warnings: [],
  login: { source: 'configured', unknown: [], available: ['claude-default', 'codex-default'] },
  jevKey: 'named',
};
const wardenStatus = {
  config: wardenConfig,
  flags: [],
  fingerprint: 'fp-workshop',
  triage: {
    jev: { configured: true, active: true, reason: 'configured' },
    llm: { configured: true, active: true, reason: 'configured' },
  },
  spend: {
    day: '2026-11-19',
    jevUsd: 0.04,
    jevCapUsd: 0.5,
    investigationUsd: 0.31,
    investigationCapUsd: 2,
    pendingInvestigations: 0,
    capsHit: [],
    investigationsLastHour: 1,
    maxInvestigationsPerHour: 6,
  },
  savings: { day: '2026-11-19', flags: 4, jevDecisions: 3, jevSkips: 1, investigations: 1 },
  investigations: [],
  actions: [],
  blessings: [],
  history: [],
};
const dialogRules = {
  builtIn: [
    { id: 'claude-dangerous-rm', harness: 'claude', kind: 'permission', does: 'presses Esc' },
    {
      id: 'claude-mcp-servers',
      harness: 'claude',
      kind: 'mcp-servers',
      does: 'chooses “Continue without using this MCP server”',
    },
    { id: 'codex-update', harness: 'codex', kind: 'update', does: 'chooses “Skip”' },
  ],
  taught: [{ id: 'learned-other-9z', harness: 'codex', kind: 'other', does: 'chooses “Not now”' }],
  pending: [],
};

// ─── speed-ups ─────────────────────────────────────────────────────────────────────────────────────────────────────

const provider = (id: string, label: string, secretName: string, set: boolean, over: Record<string, unknown> = {}) => ({
  provider: id,
  label,
  purpose: 'Cleans up dictated text for every device on this machine.',
  costNote: 'Well under a cent a take.',
  privacyNote: 'The recognised text goes to the provider; audio never leaves the device.',
  keyUrl: KEY_URL,
  testNote: 'Test lists the models your key can use. It is free.',
  secretName,
  set,
  testStale: false,
  ...over,
});
const speedups = {
  vault: 'ok',
  providers: [
    provider('jev', 'Jev', 'JEV_API_KEY', true, {
      purpose: 'A fast second opinion on a Warden flag.',
      costNote: 'About a tenth of a cent a flag.',
      privacyNote: 'The flagged text goes to Jev; nothing else leaves this machine.',
      testNote: 'Test asks for one tiny decision.',
      secretUpdatedAt: EARLIER,
      lastTest: {
        provider: 'jev',
        secretName: 'JEV_API_KEY',
        ok: true,
        code: 'ok',
        message: 'The key works.',
        latencyMs: 212,
        at: NOW,
      },
    }),
    provider('groq', 'Groq', 'GROQ_API_KEY', true, {
      secretUpdatedAt: EARLIER,
      lastTest: {
        provider: 'groq',
        secretName: 'GROQ_API_KEY',
        ok: true,
        code: 'ok',
        message: 'The key works.',
        latencyMs: 148,
        at: NOW,
      },
    }),
    provider('cerebras', 'Cerebras', 'CEREBRAS_API_KEY', false),
  ],
};

// ─── layouts ───────────────────────────────────────────────────────────────────────────────────────────────────────

const layout = {
  id: 'default',
  nav: { side: 'left', style: 'list', items: ['agenda', 'board', 'insights', 'settings'] },
  side: { show: 'wide-only', holds: 'panels', at: 'left' },
  top: ['daemon-picker', 'search'],
  'composer.tools': ['attachments', 'dictation', 'runtime-picker', 'composer-quota'],
  panels: {
    'ferret.side': ['queue'],
  },
  density: 'comfortable',
  phone: { nav: { side: 'bottom', items: ['agenda', 'board', 'insights', 'settings'] } },
};
const layouts = {
  layouts: [
    { id: 'default', origin: 'built-in' },
    { id: 'compact', origin: 'built-in' },
    { id: 'workshop', origin: 'saved' },
  ],
  themes: [{ id: 'default', origin: 'built-in' }],
  current: { layout: 'default', theme: 'default' },
};

// ─── the routes ────────────────────────────────────────────────────────────────────────────────────────────────────

const READS: Readonly<Record<string, unknown>> = {
  '/v1/terminals': holders,
  '/v1/cgroups/config': limits,
  '/v1/daemon/update': update,
  '/v1/browser/state': browserState,
  '/v1/pack': pack,
  '/v1/gc': tidy,
  '/v1/onboarding': onboarding,
  '/v1/lessons/config': lessonsConfig,
  '/v1/lessons/global': lessonsGlobal,
  '/v1/lessons/ferrets': lessonsFerrets,
  '/v1/lessons/directory': lessonsDirectory,
  '/v1/warden/config': wardenConfigView,
  '/v1/warden/status': wardenStatus,
  '/v1/warden/dialog/rules': dialogRules,
  '/v1/speedups': speedups,
  '/v1/layouts/current': { layout, theme: { id: 'default', label: 'Default', light: {}, dark: {} } },
  '/v1/layouts': layouts,
  '/v1/runtimes': (runtimes as Record<string, unknown>)['GET /v1/runtimes'],
};

export const answer = (request: TransportRequest): TransportAnswer | undefined => {
  if (request.method !== 'GET') return undefined;
  const path = request.path.split('?')[0] ?? '';
  if (path === '/v1/config/file') {
    const file = request.query?.path ?? '';
    return file in FILES ? json(configFile(file)) : undefined;
  }
  const body = READS[path];
  return body === undefined ? undefined : json(body);
};
