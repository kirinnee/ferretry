/**
 * The harness sign-in surfaces over fake data, in a real browser fixture (`?case=`): Codex's add panel locked to Codex,
 * Codex's link sign-in waiting for its address, and Claude's sign-in waiting for its code. Every request the client
 * receives is recorded on `window.__calls`. Only fixed fake values: no real code, link, address or login.
 */
import { createRoot } from 'react-dom/client';
import { AddLoginPanel } from '../../../../app/features/add-login-panel.tsx';
import { LoginSignIn } from '../../../../app/features/login-sign-in.tsx';
import { login, loginList } from '../../../unit/cli/fakes.ts';
import { scripted } from '../../../unit/app/support/client.ts';
import { claudeFlow, codexFlow } from '../../../unit/app/support/harness-login.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const which = params.get('case') ?? 'codex-add';

const OPEN = { capabilities: [{ capability: 'fleet', use: true, configure: true, configureRefusal: 'granted' }] };
const CODEX = login({ id: 'codex-studio', label: undefined, harness: 'codex', harnesses: ['codex'], usedBy: ['main'] });
const CLAUDE = login({ id: 'claude-studio', usedBy: ['main'] });

const calls: { route: string; body: unknown }[] = [];
(window as unknown as { __calls: typeof calls }).__calls = calls;
const record =
  <T,>(value: T) =>
  (call: { route: string; body: unknown }): T => {
    calls.push({ route: call.route, body: call.body });
    return value;
  };

const client = scripted({
  'GET /v1/grants': OPEN,
  'GET /v1/logins': loginList(),
  'GET /v1/logins/presets': record({ presets: [] }),
  'POST /v1/logins/changes': record({
    id: 'chg1',
    change: {},
    summary: 'Add a login',
    consequences: [],
    expiresAt: '2026-11-01T10:15:00.000Z',
    state: 'pending',
  }),
  'POST /v1/logins/sign-in': (call: { route: string; body: unknown }) => {
    calls.push({ route: call.route, body: call.body });
    return which === 'claude-code' ? claudeFlow('awaiting-code') : codexFlow('awaiting-callback');
  },
  'GET /v1/logins/sign-in/:flowId': () =>
    which === 'claude-code' ? claudeFlow('awaiting-code') : codexFlow('awaiting-callback'),
});

const surface =
  which === 'codex-add' ? (
    <AddLoginPanel client={client} harness="codex" />
  ) : (
    <LoginSignIn
      login={which === 'claude-code' ? CLAUDE : CODEX}
      machineName="studio-mac"
      client={client}
      onSignedIn={() => undefined}
      autoStart={which !== 'codex-start'}
      pollMs={600_000}
    />
  );

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="kt-chat-surface" style={{ position: 'fixed', inset: 0, overflow: 'auto', padding: 16 }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>{surface}</div>
    </div>,
  );
