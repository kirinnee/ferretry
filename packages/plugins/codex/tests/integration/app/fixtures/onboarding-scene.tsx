/**
 * The browser entry for the Codex segment's four first-run pages: the REAL pages over a fixed fake daemon, inside the
 * app's own `StepPageFrame` (the frame the setup flow draws every page in). Nothing reads a network. Every name, path
 * and command below is made up.
 *
 *   ?page=installed|sign-in|sign-in-checking|import-choice|permission|permission-auto|
 *         permission-confirm|permission-unknown   ?theme=<family>-<mode>
 *
 * `permission-confirm` is the Auto file; the test presses the Skip card, so the warning and its confirm are on screen.
 */
import { StepPageFrame } from '@ferretry/app';
import { createRoot } from 'react-dom/client';
import { ImportChoicePage } from '../../../../app/features/onboarding/import-choice-page.tsx';
import { InstalledPage } from '../../../../app/features/onboarding/installed-page.tsx';
import type { StepHost } from '../../../../app/features/onboarding/onboarding-api.ts';
import { PermissionPage } from '../../../../app/features/onboarding/permission-page.tsx';
import { SignInPage } from '../../../../app/features/onboarding/sign-in-page.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const page = params.get('page') ?? 'installed';

const COPY: Record<string, { title: string; line: string }> = {
  installed: { title: 'Install Codex', line: 'Codex runs your agents on this machine.' },
  'sign-in': { title: 'Sign in to Codex', line: 'Ferretry never sees the sign-in: Codex keeps it.' },
  'import-choice': { title: 'Bring over from Codex', line: 'Copy your setup from the Codex on this computer.' },
  permission: { title: 'Permissions', line: 'How Codex asks before it acts.' },
  'permission-auto': { title: 'Permissions', line: 'How Codex asks before it acts.' },
  'permission-confirm': { title: 'Permissions', line: 'How Codex asks before it acts.' },
  'permission-unknown': { title: 'Permissions', line: 'How Codex asks before it acts.' },
  'sign-in-checking': { title: 'Sign in to Codex', line: 'Ferretry never sees the sign-in: Codex keeps it.' },
};

const FILE = 'binary: /fake/bin/codex\npermissionMode: skip\n';
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
  page === 'permission-auto' || page === 'permission-confirm'
    ? 'permissionMode: auto\n'
    : page === 'permission-unknown'
      ? WITHHELD
      : FILE;
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
  'GET /v1/logins': page === 'sign-in-checking' ? checking : needsSignIn,
  'GET /v1/config/file': {
    path: 'harness-codex.yaml',
    text: fileText,
    etag: 'e1',
    exists: true,
    absolutePath: '/fake/home/config/harness-codex.yaml',
  },
  'PUT /v1/config/file': { path: 'harness-codex.yaml', etag: 'e2', outcome: 'applied' },
};
const client = {
  call: async (route: string, options?: { readonly body?: { readonly text?: string } }) => {
    if (!(route in table)) throw new Error(`no route ${route}`);
    // The fake file keeps what a write put in it, so a card pressed in the browser reads back as it would on a machine.
    if (route === 'PUT /v1/config/file' && options?.body?.text !== undefined)
      table['GET /v1/config/file'] = { ...(table['GET /v1/config/file'] as object), text: options.body.text };
    return table[route];
  },
  subscribe: () => () => undefined,
} as never;

const step: StepHost = {
  phase: 'daemon',
  appliesTo: [],
  segment: {},
  remember: () => undefined,
  ready: () => undefined,
  skip: () => undefined,
  notNeeded: () => undefined,
  done: () => undefined,
  busy: () => undefined,
  next: () => undefined,
  back: () => undefined,
};

/**
 * The sign-in page mounts Logins' own Codex sign-in through the shell's slot machinery, which a browser scene cannot
 * import, so the slot is drawn in outline (a card with its one button); the page's behaviour is the unit suite's.
 */
const slotOutline = (
  <section className="kt-panel flex max-w-xl flex-col gap-3 p-panel" data-fake-logins="">
    <p className="m-0 text-row font-semibold text-fg">Sign in to Codex</p>
    <p className="m-0 text-cell text-muted">Signs in on studio-mac, with a device code.</p>
    <div>
      <button type="button" className="kt-button">
        Sign in to Codex
      </button>
    </div>
  </section>
);

const body =
  page === 'installed' ? (
    <InstalledPage client={client} step={step} />
  ) : page === 'sign-in' || page === 'sign-in-checking' ? (
    <div className="flex flex-col gap-3">
      <SignInPage client={client} step={step} />
      {slotOutline}
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
  'permission-confirm': 4,
  'permission-unknown': 4,
  'sign-in-checking': 2,
};
createRoot(document.getElementById('root') as HTMLElement).render(
  <StepPageFrame
    title={copy?.title ?? 'Codex'}
    {...(copy === undefined ? {} : { line: copy.line })}
    back={{}}
    next={{ label: 'Next' }}
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
