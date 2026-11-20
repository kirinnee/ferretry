/**
 * The browser entry for the Codex segment's first-run pages (r11 O5): the REAL pages over a fixed fake daemon, inside the
 * app's own `StepPageFrame` (the frame the setup flow draws every page in). Nothing reads a network. Every name, path
 * and command below is made up.
 *
 *   ?page=installed|sign-in|sign-in-link|sign-in-checking|import-choice|conversations|permission|permission-auto|
 *         permission-unknown   ?theme=<family>-<mode>
 *
 * The footer's Next runs the page's registered `commit` the way the shell does; every write the pages make is counted on
 * `window.__puts` and what the footer would say about a refusal is on `window.__nextError`. The sign-in pages mount the
 * Logins panel the page chose, in outline, with the subject it chose (`signInPanelFor`).
 */
import { StepPageFrame } from '@ferretry/app';
import { LoginListSchema } from '@ferretry/plugin-logins/contract';
import { type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationsPage } from '../../../../app/features/onboarding/import/conversations-page.tsx';
import { ImportChoicePage } from '../../../../app/features/onboarding/import-choice-page.tsx';
import { InstalledPage } from '../../../../app/features/onboarding/installed-page.tsx';
import { type StepHost, signInFacts } from '../../../../app/features/onboarding/onboarding-api.ts';
import { PermissionPage } from '../../../../app/features/onboarding/permission-page.tsx';
import { SignInPage, signInPanelFor } from '../../../../app/features/onboarding/sign-in-page.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const page = params.get('page') ?? 'installed';

const COPY: Record<string, { title: string; line: string }> = {
  installed: { title: 'Install Codex', line: 'Codex runs your agents on this machine.' },
  'sign-in': { title: 'Sign in to Codex', line: 'Ferretry never sees the sign-in: Codex keeps it.' },
  'import-choice': { title: 'What to bring over', line: 'Copy your setup from the Codex on this computer.' },
  permission: { title: 'Permissions', line: 'How Codex asks before it acts.' },
  'permission-auto': { title: 'Permissions', line: 'How Codex asks before it acts.' },
  'permission-confirm': { title: 'Permissions', line: 'How Codex asks before it acts.' },
  'permission-unknown': { title: 'Permissions', line: 'How Codex asks before it acts.' },
  'sign-in-checking': { title: 'Sign in to Codex', line: 'Ferretry never sees the sign-in: Codex keeps it.' },
  'sign-in-link': { title: 'Sign in to Codex', line: 'Ferretry never sees the sign-in: Codex keeps it.' },
  conversations: { title: 'Conversations', line: 'Your terminal’s Codex history.' },
};

declare global {
  interface Window {
    __puts: unknown[];
    __nextError: string;
  }
}
window.__puts = [];
window.__nextError = '';

const FILE = 'binary: /fake/bin/codex\npermissionMode: skip\n';
const NO_LOGIN = { format: 1, machine: 'studio-mac', logins: [] };
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
const WITHHELD =
  '# ‹hidden›: the text of this file is not shown because it holds a raw secret, which the owner must move into the secret store; edit it at the machine\n';
const fileText =
  page === 'permission-auto' ? 'permissionMode: auto\n' : page === 'permission-unknown' ? WITHHELD : FILE;
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
  'GET /v1/logins':
    page === 'sign-in-checking'
      ? checking
      : page === 'sign-in-link'
        ? needsSignIn
        : page === 'sign-in'
          ? NO_LOGIN
          : needsSignIn,
  'GET /v1/config/file': {
    path: 'harness-codex.yaml',
    text: fileText,
    etag: 'e1',
    exists: true,
    absolutePath: '/fake/home/config/harness-codex.yaml',
  },
  'PUT /v1/config/file': {
    path: 'harness-codex.yaml',
    etag: 'e2',
    outcome: params.get('held') === '1' ? 'pending' : 'applied',
  },
};
const client = {
  call: async (route: string, options?: { readonly body?: { readonly text?: string } }) => {
    if (!(route in table)) throw new Error(`no route ${route}`);
    // The fake file keeps what a write put in it, so a card pressed in the browser reads back as it would on a machine.
    if (route === 'PUT /v1/config/file' && options?.body?.text !== undefined) {
      window.__puts.push(options.body);
      table['GET /v1/config/file'] = { ...(table['GET /v1/config/file'] as object), text: options.body.text };
    }
    return table[route];
  },
  subscribe: () => () => undefined,
} as never;

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
 * The sign-in page mounts Logins' own panel through the shell's slot machinery, and another package is reached only through its
 * contract, so the scene draws the slot in outline: a card that records the panel and the SUBJECT the page's own rule
 * (`signInPanelFor`) chose. Logins' own browser suite mounts the real panel with that subject (`harness:codex`).
 */
const signInPanel = (): ReactElement | null => {
  const facts = signInFacts(LoginListSchema.parse(table['GET /v1/logins']));
  if (facts.state !== 'needs-sign-in' && facts.state !== 'no-login') return null;
  const { panel, subject } = signInPanelFor(facts);
  return (
    <section
      className="kt-panel flex max-w-xl flex-col gap-3 p-panel"
      data-fake-logins={panel}
      data-fake-logins-subject={subject}
    >
      <p className="m-0 text-row font-semibold text-fg">Sign in to Codex</p>
      <div>
        <button type="button" className="kt-button">
          Sign in to Codex
        </button>
      </div>
    </section>
  );
};

const body =
  page === 'installed' ? (
    <InstalledPage client={client} step={step} />
  ) : page === 'conversations' ? (
    <ConversationsPage client={client} step={step} />
  ) : page === 'sign-in' || page === 'sign-in-checking' || page === 'sign-in-link' ? (
    <div className="flex flex-col gap-3">
      <SignInPage client={client} step={step} />
      {signInPanel()}
    </div>
  ) : page === 'import-choice' ? (
    <ImportChoicePage step={step} />
  ) : (
    <PermissionPage client={client} step={step} />
  );

const copy = COPY[page] ?? COPY.installed;
const STEP: Record<string, number> = {
  installed: 1,
  'sign-in': 2,
  'import-choice': 3,
  permission: 4,
  'permission-auto': 4,
  'permission-unknown': 4,
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
