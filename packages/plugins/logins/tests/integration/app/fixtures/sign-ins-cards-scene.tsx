/** The Logins list over fake data, in a real browser fixture: three cards, each with its switch and Remove. */
import { createRoot } from 'react-dom/client';
import { SignInsTab } from '../../../../app/features/sign-ins-tab.tsx';
import { login, loginList } from '../../../unit/cli/fakes.ts';
import { scripted } from '../../../unit/app/support/client.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const OPEN = { capabilities: [{ capability: 'fleet', use: true, configure: true, configureRefusal: 'granted' }] };

const list = loginList(
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

const client = scripted({
  'GET /v1/logins': list,
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
