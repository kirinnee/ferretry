/**
 * The Logins settings tab over fake data, in a real browser fixture (r10 S13). One scene, chosen by `?view=`:
 *
 *   list    three logins (a Claude one, a switched-off one, a Codex one) and an environment login
 *   empty   a machine with no logins
 *   page    one signed-in login's own page
 *   env     an environment login's own page (its variables, its Test)
 *   needs   a login that needs signing in
 *   add     the add-a-login panel: the sign-in form and the provider tiles
 *
 *   ?theme=<family>-<mode>   ?panel=<px>  the width of the Settings panel the tab sits in (default: fills the window)
 */
import { createRoot } from 'react-dom/client';
import { SignInsTab } from '../../../../app/features/sign-ins-tab.tsx';
import { login, loginList } from '../../../unit/cli/fakes.ts';
import { scripted } from '../../../unit/app/support/client.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const view = params.get('view') ?? 'list';
const panel = Number(params.get('panel') ?? 0);

const OPEN = { capabilities: [{ capability: 'fleet', use: true, configure: true, configureRefusal: 'granted' }] };

const needsSignIn = {
  word: 'needs_sign_in',
  label: 'Needs sign-in',
  reason: 'not_signed_in',
  explanation: 'Sign in once and every runtime that uses it can launch.',
  lastCheckInconclusive: false,
};

const glm = login({
  id: 'glm-env',
  store: 'environment',
  email: undefined,
  usedBy: ['main'],
  environment: {
    preset: { id: 'zai-glm', label: 'GLM / Z.ai', docs: 'https://docs.z.ai/devpack/tool/claude' },
    variables: [
      { name: 'ANTHROPIC_BASE_URL', kind: 'plain', value: 'https://api.z.ai/api/anthropic' },
      { name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secrets: ['ZAI_API_KEY'], set: true },
    ],
    quotaSource: 'zai-coding-plan',
    missingSecrets: [],
    test: { available: true, spends: 'nothing', note: 'Reads your quota. Spends nothing.' },
  },
});

const logins = [
  login({ id: 'claude-personal', email: 'ada@example.test', label: 'personal', usedBy: ['main', 'review'] }),
  login({
    id: 'claude-work',
    email: 'ada@work.example.test',
    label: 'work',
    disabled: { source: 'login', reason: 'monthly spend limit reached', until: '2026-11-05T00:00:00.000Z' },
  }),
  glm,
  login({
    id: 'codex-main',
    harness: 'codex',
    harnesses: ['codex'],
    email: 'ada@example.test',
    usedBy: [],
    usage: { fiveHour: {}, weekly: {} },
  }),
  login({ id: 'claude-slot', email: undefined, usedBy: [], status: needsSignIn }),
];

const presetOf = (id: string, label: string, group: string, harness = 'claude-code') => ({
  id,
  label,
  harness,
  group,
  summary: `${label} through its own endpoint.`,
  docs: 'https://docs.example.test',
  origin: 'built-in',
  variables: [
    {
      name: 'KEY',
      kind: 'secret',
      secret: `${id.toUpperCase().replace(/-/gu, '_')}_KEY`,
      required: true,
      allowEmpty: false,
      harnesses: [harness],
    },
  ],
  models: [],
  test: { available: true, spends: 'nothing', note: 'Free.' },
  quota: { source: 'none', note: 'n/a' },
  unverified: [],
  verified: '2026-10-16',
  offered: { available: true },
  halves: [{ harness, offered: { available: true }, models: [] }],
});

const presets = [
  presetOf('zai-glm', 'GLM / Z.ai', 'popular'),
  presetOf('openrouter', 'OpenRouter', 'popular'),
  presetOf('deepseek', 'DeepSeek', 'popular'),
  presetOf('kimi', 'Kimi', 'popular'),
  presetOf('minimax', 'MiniMax', 'popular'),
  presetOf('ollama', 'Ollama', 'self-hosted', 'codex'),
  presetOf('custom-gateway', 'Custom gateway', 'self-hosted'),
];

const shown = view === 'empty' ? [] : logins;
const target = { page: 'claude-personal', env: 'glm-env', needs: 'claude-slot' }[view as 'page' | 'env' | 'needs'];
window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`);
if (target !== undefined) window.location.hash = `#machines/box/sign-ins/${target}`;

const client = scripted({
  'GET /v1/logins': loginList(...shown),
  'GET /v1/grants': OPEN,
  'GET /v1/logins/presets': { presets },
  'POST /v1/logins/changes': (call: { body: unknown }) => ({
    id: 'chg1',
    change: call.body,
    summary: 'Remove login claude-personal',
    consequences: ['Its saved sign-in stays on this machine. To delete it, sign the login out before removing it.'],
    expiresAt: '2026-11-01T10:15:00.000Z',
    state: 'pending',
  }),
});

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="kt-chat-surface" style={{ position: 'fixed', inset: 0, overflow: 'auto', padding: 16 }}>
      <div style={{ maxWidth: 1_100, width: panel > 0 ? panel : undefined }}>
        <SignInsTab client={client} now={() => Date.parse('2026-11-01T10:00:00.000Z')} />
      </div>
    </div>,
  );
