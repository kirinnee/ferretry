/**
 * The harness sign-in surfaces over fake data, in a real browser fixture (`?case=`). The Codex and Claude add panels are
 * the REGISTERED panels (`app/index.ts` → `panels['add-login']`) mounted with the planned subject (`harness:codex`,
 * `harness:claude`), exactly as a page's slot mounts them; `settings-add` is the same panel with no subject (Settings ›
 * Logins keeps its full chooser). Every request the client receives is recorded on `window.__calls`. Only fixed fake
 * values: no real code, link, address or login. The link the daemon "sends" is unique on purpose, so a test can prove the
 * link on screen is that one and not a constant of the app.
 */
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AddLoginPanel } from '../../../../app/features/add-login-panel.tsx';
import { ClaudeLoginPanel } from '../../../../app/features/claude-login-panel.tsx';
import { LoginSignIn } from '../../../../app/features/login-sign-in.tsx';
import logins from '../../../../app/index.ts';
import type { LoginsClient } from '../../../../app/lib/client.ts';
import { login, loginList } from '../../../unit/cli/fakes.ts';
import { scripted } from '../../../unit/app/support/client.ts';
import { claudeFlow, codexFlow } from '../../../unit/app/support/harness-login.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const which = params.get('case') ?? 'codex-add';
/** The cases whose daemon speaks Claude's sign-in (C59 O5). */
const CLAUDE_FLOW: ReadonlySet<string> = new Set(['claude-code', 'claude-fail', 'claude-done', 'claude-starting']);

/** The authorize link the fake daemon sends: unique, never a value any app file holds. */
const DAEMON_LINK =
  'https://auth.example.test/oauth/authorize?response_type=code&state=unique-3c9d1e7a&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback';

const OPEN = { capabilities: [{ capability: 'fleet', use: true, configure: true, configureRefusal: 'granted' }] };
const needsSignIn = {
  word: 'needs_sign_in',
  label: 'Needs sign-in',
  reason: 'not_checked_yet',
  explanation: 'Not signed in yet.',
  lastCheckInconclusive: false,
};
const CODEX = login({ id: 'codex-studio', label: undefined, harness: 'codex', harnesses: ['codex'], usedBy: ['main'] });
const CODEX_NEW = login({ ...CODEX, id: 'codex-login', status: needsSignIn, usedBy: [] });
const CLAUDE = login({ id: 'claude-studio', usedBy: ['main'] });

const calls: { route: string; body: unknown }[] = [];
(window as unknown as { __calls: typeof calls }).__calls = calls;
const note = (call: { route: string; body: unknown }): void => {
  calls.push({ route: call.route, body: call.body });
};

const preset = (id: string, label: string, harness: 'codex' | 'claude-code') => ({
  id,
  label,
  harness,
  group: 'popular',
  summary: `${label} through ${harness === 'codex' ? 'Codex' : 'Claude Code'}.`,
  docs: 'https://docs.example.test',
  origin: 'built-in',
  variables: [
    { name: 'API_KEY', kind: 'secret', secret: 'API_KEY', required: true, allowEmpty: false, harnesses: [harness] },
  ],
  models: [],
  test: { available: true, spends: 'nothing', note: 'Free.' },
  quota: { source: 'none', note: 'n/a' },
  unverified: [],
  verified: '2026-10-16',
  offered: { available: true },
  halves: [{ harness, offered: { available: true }, models: [] }],
});
/** A SHARED provider (OpenRouter-like): one preset that drives both tools, each half with its own variables. */
const SHARED = {
  ...preset('openrouter', 'OpenRouter', 'claude-code'),
  // Word for word as the daemon's endpoint data says it (openrouter.yaml; the unit suite reads that file itself).
  summary:
    'Claude Code and Codex through OpenRouter with one key, on Anthropic and OpenAI models or any other it routes to.',
  variables: [
    {
      name: 'ANTHROPIC_BASE_URL',
      kind: 'plain',
      value: 'https://or.example.test/anthropic',
      required: true,
      allowEmpty: false,
      harnesses: ['claude-code'],
    },
    {
      name: 'ANTHROPIC_AUTH_TOKEN',
      kind: 'secret',
      secret: 'OPENROUTER_API_KEY',
      required: true,
      allowEmpty: false,
      harnesses: ['claude-code'],
    },
    {
      name: 'OPENAI_BASE_URL',
      kind: 'plain',
      value: 'https://or.example.test/openai',
      required: true,
      allowEmpty: false,
      harnesses: ['codex'],
    },
    {
      name: 'OPENAI_API_KEY',
      kind: 'secret',
      secret: 'OPENROUTER_API_KEY',
      required: true,
      allowEmpty: false,
      harnesses: ['codex'],
    },
  ],
  halves: [
    { harness: 'claude-code', offered: { available: true }, models: [] },
    { harness: 'codex', offered: { available: true }, models: [] },
  ],
};
/** One provider per tool, so a locked panel's grid can be checked for who is NOT in it. */
const PRESETS = [
  preset('zai-glm', 'GLM / Z.ai', 'claude-code'),
  preset('ollama-local', 'Local Ollama', 'codex'),
  preset('azure-openai', 'Azure OpenAI', 'codex'),
  SHARED,
];

/** The flow a start answers with, by case; the n-th start of a case may answer differently. */
let starts = 0;
let made = false;
const startAnswer = () => {
  starts += 1;
  if (CLAUDE_FLOW.has(which)) return claudeFlow(which === 'claude-starting' ? 'starting' : 'awaiting-code');
  if (which === 'codex-device') return codexFlow('awaiting-approval');
  if (which === 'codex-made') return starts === 1 ? codexFlow('failed') : codexFlow('awaiting-approval');
  return { ...codexFlow('awaiting-callback'), verificationUrl: DAEMON_LINK };
};
let current: ReturnType<typeof startAnswer> = codexFlow('starting');

const client = scripted({
  'GET /v1/grants': OPEN,
  'GET /v1/logins': () => loginList(...(which === 'codex-made' && made ? [CODEX_NEW] : [])),
  'GET /v1/logins/presets': (call: { route: string; body: unknown }) => {
    note(call);
    return { presets: PRESETS };
  },
  'POST /v1/logins/changes': (call: { route: string; body: unknown }) => {
    note(call);
    return {
      id: 'chg1',
      change: call.body,
      summary: 'Add a login',
      consequences: [],
      expiresAt: '2026-11-01T10:15:00.000Z',
      state: 'pending',
    };
  },
  'POST /v1/logins/changes/:changeId/apply': (call: { route: string; body: unknown }) => {
    note(call);
    made = true;
    return { outcome: 'applied' };
  },
  'POST /v1/logins/sign-in': (call: { route: string; body: unknown }) => {
    note(call);
    current = startAnswer();
    return current;
  },
  'GET /v1/logins/sign-in/:flowId': () => current,
  // The address is held for a moment before it is answered, so a test can look at the page while the request is in flight.
  'POST /v1/logins/sign-in/:flowId': async (call: { route: string; body: unknown }) => {
    note(call);
    await new Promise(resolve => setTimeout(resolve, CLAUDE_FLOW.has(which) ? CLAUDE_HOLD_MS : 1_200));
    // C59 O5: Claude's code is refused (`claude-fail`), accepted (`claude-done`), or held a long while (`claude-code`).
    if (which === 'claude-fail') return { outcome: 'refused', reason: 'Claude did not accept that code. Try again.' };
    if (which === 'claude-done') {
      current = claudeFlow('complete');
      return { outcome: 'accepted', flow: current };
    }
    current = codexFlow('finishing');
    return { outcome: 'accepted', flow: current };
  },
} as Record<string, unknown>) as LoginsClient;

const registered = (subject: string | undefined): ReactElement => {
  const built = logins.build?.({ client } as never) as unknown as {
    panels: Record<string, (props: { subject?: string }) => ReactElement>;
  };
  const panel = built.panels['add-login'] as (props: { subject?: string }) => ReactElement;
  return panel(subject === undefined ? {} : { subject });
};

/** How long a Claude code submit is held in flight, so a test can measure the busy page. `?hold=` shortens it. */
const CLAUDE_HOLD_MS = Number(params.get('hold') ?? '1200');

const WORDING = { coverage: 'The login is kept on studio-mac. Nothing uses it yet.', signedIn: 'Signed in.' };
const noop = (): void => undefined;

const surface = ((): ReactElement => {
  // C59 O5: the panel itself, over a flow the test chooses, to measure its buttons without a daemon in between.
  if (which === 'claude-idle' || which === 'claude-starting-direct')
    return (
      <ClaudeLoginPanel
        accountLabel="Claude Code login"
        loginId="claude-studio"
        flow={which === 'claude-idle' ? null : claudeFlow('starting')}
        busy={false}
        refusal={null}
        wording={WORDING}
        onStart={noop}
        onSubmitCode={noop}
        onCancel={noop}
        onStartOver={noop}
      />
    );
  if (which === 'codex-add' || which === 'codex-made') return registered('harness:codex');
  if (which === 'claude-add') return registered('harness:claude');
  if (which === 'settings-add') return <AddLoginPanel client={client} />;
  return (
    <LoginSignIn
      login={CLAUDE_FLOW.has(which) ? CLAUDE : CODEX}
      machineName="studio-mac"
      client={client}
      onSignedIn={() => undefined}
      autoStart={which !== 'codex-start'}
      pollMs={600_000}
    />
  );
})();

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="kt-chat-surface" style={{ position: 'fixed', inset: 0, overflow: 'auto', padding: 16 }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>{surface}</div>
    </div>,
  );
