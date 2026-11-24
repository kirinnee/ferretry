/**
 * The browser entry for the Codex segment's first-run pages (r11 O5): the REAL pages over a fixed fake daemon, inside the
 * app's own `StepPageFrame` (the frame the setup flow draws every page in). Nothing reads a network. Every name, path
 * and command below is made up.
 *
 *   ?page=installed|sign-in|sign-in-link|sign-in-checking|import-choice|conversations
 *         ?theme=<family>-<mode>   &held=1 (a write is held)   &pending=1 (the file read says a held
 *         edit waits until `window.__clearHeld()`)   &other=1 (another signable Codex login appears beside the one the add makes)
 *
 * The footer's Next runs the page's registered `commit` the way the shell does; every write the pages make is counted on
 * `window.__puts` and what the footer would say about a refusal is on `window.__nextError`.
 *
 * THE SIGN-IN PAGES ARE THE PRODUCTION WIRING: `SignInPage` mounts Logins' panels through the app's own `PanelSlot`, and the
 * slot is filled with the REAL views Logins registers (`logins.build(...).panels`: `add-login` and `codex-login`), so a page
 * that drops its `subject`, mounts the wrong panel or swaps one panel for another mid-flow shows it in the DOM. The fake
 * daemon answers Logins' own routes (the login list, the change and its apply, the sign-in flow) and records every call on
 * `window.__calls`. `sign-in` is a machine with no login: the add is applied the way the daemon does it, the `LoginChanged`
 * event published BEFORE the apply is answered (`?lag=<ms>` is that gap; default 700).
 */
import { StepPageFrame } from '@ferretry/app';
import { noteClientDaemon, registeredPanel, WithSlotPanels } from '@ferretry/app/testing/settings-shell';
import { createRoot } from 'react-dom/client';
import { ConversationsPage } from '../../../../app/features/onboarding/import/conversations-page.tsx';
import { ImportChoicePage } from '../../../../app/features/onboarding/import-choice-page.tsx';
import { InstalledPage } from '../../../../app/features/onboarding/installed-page.tsx';
import type { StepHost } from '../../../../app/features/onboarding/onboarding-api.ts';
import { SignInPage } from '../../../../app/features/onboarding/sign-in-page.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const page = params.get('page') ?? 'installed';

const COPY: Record<string, { title: string; line: string }> = {
  installed: { title: 'Install Codex', line: 'Codex runs your agents on this machine.' },
  'sign-in': { title: 'Sign in to Codex', line: 'Ferretry never sees the sign-in: Codex keeps it.' },
  'import-choice': { title: 'What to bring over', line: 'Copy your setup from the Codex on this computer.' },
  'sign-in-checking': { title: 'Sign in to Codex', line: 'Ferretry never sees the sign-in: Codex keeps it.' },
  'sign-in-link': { title: 'Sign in to Codex', line: 'Ferretry never sees the sign-in: Codex keeps it.' },
  conversations: { title: 'Conversations', line: 'Your terminal’s Codex history.' },
};

declare global {
  interface Window {
    __puts: unknown[];
    __calls: { route: string; body: unknown }[];
    __nextError: string;
    __clearHeld: () => void;
  }
}
window.__puts = [];
window.__calls = [];
window.__nextError = '';
/** `?pending=1`: the file read says a held edit waits, until the test clears it the way Settings does. */
let heldEdit = params.get('pending') === '1';
window.__clearHeld = () => {
  heldEdit = false;
};

/** The authorize link the fake daemon sends: unique, never a value any app file holds. */
const DAEMON_LINK =
  'https://auth.example.test/oauth/authorize?response_type=code&state=unique-3c9d1e7a&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback';
const OPEN = { capabilities: [{ capability: 'fleet', use: true, configure: true, configureRefusal: 'granted' }] };
const lag = Number(params.get('lag') ?? '700');

const FILE = 'binary: /fake/bin/codex\npermissionMode: skip\n';
const NO_LOGIN = { format: 1, machine: 'studio-mac', logins: [] as unknown[] };
const absent = {
  harness: 'codex',
  location: { state: 'absent', searched: ['/fake/bin'] },
  installed: null,
};
const needsSignIn = {
  format: 1,
  machine: 'studio-mac',
  logins: [
    {
      id: 'codex-main',
      harness: 'codex',
      harnesses: ['codex'],
      store: 'host',
      needsLabel: false,
      sharedWithTerminal: true,
      status: {
        word: 'needs_sign_in',
        label: 'Sign in',
        reason: 'not_signed_in',
        explanation: 'Codex is not signed in on this machine.',
        lastCheckInconclusive: false,
      },
      usage: { fiveHour: {}, weekly: {} },
      usedBy: [],
      signIn: { available: true },
      checkNow: { available: false, reason: 'not signed in' },
      signOut: { available: true, sentence: 'Sign out of Codex?', runtimesAffected: 0, signsOutTerminal: false },
    },
  ],
};
const checking = {
  ...needsSignIn,
  logins: needsSignIn.logins.map(login => ({
    ...login,
    status: { ...login.status, word: 'checking', label: 'Checking', reason: 'check_in_flight' },
    signIn: { available: false, reason: 'checking' },
  })),
};
/** The login the add makes: the same row as `needsSignIn`'s, under the id the page's add panel suggests. */
const MADE = { ...needsSignIn.logins[0], id: 'codex-login' };
/** `?other=1`: a second signable Codex login that sorts BEFORE the one the add makes. */
const OTHER = { ...needsSignIn.logins[0], id: 'codex-older' };
let fileText = FILE;
const table: Record<string, unknown> = {
  'GET /v1/codex/update': absent,
  'GET /v1/runtimes/setup/scan': {
    machine: 'studio-mac',
    format: 'none',
    tools: [
      {
        harness: 'codex',
        label: 'Codex',
        installed: false,
        install: { kind: 'runnable', command: 'npm install -g @fake/codex' },
      },
    ],
    harnesses: [],
    runtimes: [],
    updates: [],
    duplicates: [],
    notes: [],
    importing: { available: true },
  },
  'GET /v1/logins': () => (page === 'sign-in-checking' ? checking : page === 'sign-in' ? NO_LOGIN : needsSignIn),
  'GET /v1/grants': OPEN,
  'GET /v1/logins/presets': { presets: [] },
  'POST /v1/logins/changes': (body: unknown) => ({
    id: 'chg1',
    change: body,
    summary: 'Add a login',
    consequences: [],
    expiresAt: '2026-11-01T10:15:00.000Z',
    state: 'pending',
  }),
  // The daemon publishes `LoginChanged` for the new login BEFORE it answers the apply: the page reads the list again while the add is in flight.
  'POST /v1/logins/changes/:changeId/apply': async () => {
    NO_LOGIN.logins = params.get('other') === '1' ? [OTHER, MADE] : [MADE];
    for (const handler of [...handlers]) handler({ id: 'codex-login', kind: 'added' });
    await new Promise(resolve => setTimeout(resolve, lag));
    return { outcome: 'applied' };
  },
  'POST /v1/logins/sign-in': () => FLOW,
  'GET /v1/logins/sign-in/:flowId': () => FLOW,
  'GET /v1/config/file': () => ({
    path: 'harness-codex.yaml',
    text: fileText,
    etag: 'e1',
    exists: true,
    absolutePath: '/fake/home/config/harness-codex.yaml',
    ...(heldEdit ? { state: 'pending' } : {}),
  }),
  'PUT /v1/config/file': {
    path: 'harness-codex.yaml',
    etag: 'e2',
    outcome: params.get('held') === '1' ? 'pending' : 'applied',
  },
};
/** The link sign-in the daemon starts for the new login. */
const FLOW = {
  harness: 'codex',
  flowId: 'flow-one',
  startedAt: '2026-11-01T10:00:00.000Z',
  expiresAt: '2026-11-01T10:10:00.000Z',
  loginId: 'codex-login',
  identity: 'codex:studio',
  state: 'awaiting-callback',
  verificationUrl: DAEMON_LINK,
};
const handlers = new Set<(event: unknown) => void>();
const client = {
  call: async (route: string, options?: { readonly body?: { readonly text?: string } }) => {
    window.__calls.push({ route, body: options?.body });
    if (!(route in table)) throw new Error(`no route ${route}`);
    // The fake file keeps what a write put in it, so a card pressed in the browser reads back as it would on a machine.
    if (route === 'PUT /v1/config/file' && options?.body?.text !== undefined) {
      window.__puts.push(options.body);
      fileText = options.body.text;
    }
    const answer = table[route];
    return typeof answer === 'function' ? await (answer as (body: unknown) => unknown)(options?.body) : answer;
  },
  subscribe: (_event: unknown, handler: (event: unknown) => void) => {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  },
} as never;
noteClientDaemon(client, 'fy_daemon_fake');

let save: (() => Promise<void>) | null = null;
const step: StepHost = {
  phase: 'daemon',
  appliesTo: [],
  segment: {},
  remember: () => undefined,
  ready: () => undefined,
  skip: () => undefined,
  notNeeded: () => undefined,
  commit: next => {
    save = next;
  },
  done: () => undefined,
  busy: () => undefined,
  next: () => undefined,
  back: () => undefined,
};

/**
 * The slot the sign-in page draws into: the app's own `WithSlotPanels` (the shell's `PluginView` path) placing the panels
 * Logins REGISTERS (read from the app's registry, built exactly as the shell builds them). The page picks which one and with
 * which subject; nothing here does. Logins' half gets its OWN client over the same fake daemon, one the shell never noted a
 * daemon for: the stub shell has no grants cache, so Logins reads the change authority from `GET /v1/grants`, as a half
 * outside a shell does.
 */
const loginsClient = { call: (client as unknown as { call: unknown }).call };
const loginsPanels = [
  registeredPanel('logins', 'add-login', loginsClient),
  registeredPanel('logins', 'codex-login', loginsClient),
];

const body =
  page === 'installed' ? (
    <InstalledPage client={client} step={step} />
  ) : page === 'conversations' ? (
    <ConversationsPage step={step} />
  ) : page === 'sign-in' || page === 'sign-in-checking' || page === 'sign-in-link' ? (
    <WithSlotPanels slots={{ settings: loginsPanels }}>
      <SignInPage client={client} step={step} />
    </WithSlotPanels>
  ) : (
    <ImportChoicePage client={client} step={step} />
  );

const copy = COPY[page] ?? COPY.installed;
const STEP: Record<string, number> = {
  installed: 1,
  'sign-in': 2,
  'import-choice': 3,
  'sign-in-checking': 2,
  'sign-in-link': 2,
  conversations: 4,
};
createRoot(document.getElementById('root') as HTMLElement).render(
  <StepPageFrame
    title={copy?.title ?? 'Codex'}
    back={{}}
    later={{}}
    next={{
      label: 'Next',
      onClick: () => {
        window.__nextError = '';
        void (save?.() ?? Promise.resolve()).catch((cause: unknown) => {
          window.__nextError = cause instanceof Error ? cause.message : String(cause);
        });
      },
    }}
    progress={{
      segments: [
        { id: 'machine', label: 'Machine' },
        { id: 'codex', label: 'Codex' },
        { id: 'device', label: 'This device' },
      ],
      current: 'codex',
      step: STEP[page] ?? 1,
      of: 4,
    }}
  >
    {body}
  </StepPageFrame>,
);
