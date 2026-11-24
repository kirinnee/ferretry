/** The Logins list over fake data, in a real browser fixture: three cards, each with its switch and Remove. */
import { createRoot } from 'react-dom/client';
import { SignInsTab } from '../../../../app/features/sign-ins-tab.tsx';
import { login, loginList } from '../../../unit/cli/fakes.ts';
import { scripted } from '../../../unit/app/support/client.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const OPEN = { capabilities: [{ capability: 'fleet', use: true, configure: true, configureRefusal: 'granted' }] };

/** `?long=1` adds two logins whose names are far longer than a phone's card: an environment login's id and an email. */
const longNames =
  params.get('long') === '1'
    ? [
        login({ id: 'claude-qa-fake-key-for-the-staging-gateway', store: 'environment', email: undefined }),
        login({ id: 'claude-long-email', email: 'ada.lovelace.the.analytical.engine.programmer@example.test' }),
      ]
    : [];

const list = loginList(
  ...longNames,
  login({ id: 'claude-personal', email: 'ada@example.test', label: 'personal', usedBy: ['main', 'review'] }),
  login({
    id: 'claude-work',
    email: 'ada@work.example.test',
    label: 'work',
    disabled: { source: 'login', reason: 'monthly spend limit reached', until: '2026-11-05T00:00:00.000Z' },
  }),
  login({
    id: 'codex-main',
    harness: 'codex',
    harnesses: ['codex'],
    email: 'ada@example.test',
    usedBy: [],
    usage: { fiveHour: {}, weekly: {} },
  }),
);

// ?names=1: logins as a QA walk made them (ids typed as slugs, labels typed as slugs, no email): no id may read as a name.
const names = params.get('names') === '1';
const needsSignIn = {
  word: 'needs_sign_in',
  label: 'Needs sign-in',
  reason: 'not_signed_in',
  explanation: 'Sign in to continue.',
  lastCheckInconclusive: false,
};
const slugList = loginList(
  login({
    id: 'claude-qa-fake-key',
    store: 'environment',
    label: 'qa-fake-key',
    email: undefined,
    environment: {
      preset: { id: 'anthropic', label: 'Anthropic API key', docs: 'https://docs.anthropic.com' },
      variables: [{ name: 'ANTHROPIC_API_KEY', kind: 'secret', secrets: ['QA_KEY'], set: true }],
      quotaSource: 'zai-coding-plan',
      missingSecrets: [],
      test: { available: true, spends: 'nothing', note: 'Reads your quota. Spends nothing.' },
    },
  }),
  login({
    id: 'claude-code-login',
    store: 'host',
    label: 'qaclaude',
    email: undefined,
    status: needsSignIn,
    usedBy: ['claude-code-login'],
  }),
  login({
    id: 'codex-login',
    harness: 'codex',
    harnesses: ['codex'],
    store: 'host',
    email: undefined,
    status: needsSignIn,
    usedBy: [],
  }),
);

const client = scripted({
  'GET /v1/logins': names ? slugList : list,
  'GET /v1/grants': OPEN,
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
      <SignInsTab client={client} now={() => Date.parse('2026-11-01T10:00:00.000Z')} />
    </div>,
  );
