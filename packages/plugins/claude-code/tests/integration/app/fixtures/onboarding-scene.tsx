/**
 * The browser entry for the Claude segment's four first-run pages: the REAL pages over a fixed fake daemon, inside a
 * plain stand-in for the step frame (the real frame is O4's; this one only gives the page a title, a body and a footer so
 * the page can be looked at). Nothing reads a network. Every name, path and command below is made up.
 *
 *   ?page=installed|sign-in|import-choice|permission|permission-auto   ?theme=<family>-<mode>
 */
import { createRoot } from 'react-dom/client';
import { InstalledPage } from '../../../../app/features/onboarding/installed-page.tsx';
import { ImportChoicePage } from '../../../../app/features/onboarding/import-choice-page.tsx';
import { PermissionPage } from '../../../../app/features/onboarding/permission-page.tsx';
import type { StepHost } from '../../../../app/features/onboarding/kit.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const page = params.get('page') ?? 'installed';

const TITLES: Record<string, string> = {
  installed: 'Install Claude Code',
  'sign-in': 'Sign in to Claude',
  'import-choice': 'What to bring over',
  permission: 'Permissions',
  'permission-auto': 'Permissions',
};

const FILE = 'binary: /fake/bin/claude\npermissionMode: skip\n';
const table: Record<string, unknown> = {
  'GET /v1/claude-code/update': { location: { state: 'absent', searched: ['/fake/bin'] } },
  'GET /v1/runtimes/setup/scan': {
    tools: [
      {
        harness: 'claude-code',
        label: 'Claude Code',
        installed: false,
        install: { kind: 'runnable', command: 'npm install --global @fake/claude-code' },
      },
    ],
  },
  'GET /v1/config/file': {
    path: 'harness-claude-code.yaml',
    text: page === 'permission-auto' ? 'permissionMode: auto\n' : FILE,
    etag: 'e1',
    exists: true,
  },
};
table['PUT /v1/config/file'] = { path: 'harness-claude-code.yaml', etag: 'e2', outcome: 'applied' };
const client = {
  call: async (route: string) => {
    if (!(route in table)) throw new Error(`no route ${route}`);
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
  done: () => undefined,
  busy: () => undefined,
  next: () => undefined,
  back: () => undefined,
};

/**
 * The sign-in page's shape: its own intro line, then what Logins draws in the slot (in outline: a card with its one
 * button). The page itself needs the shell's slot machinery, which a browser scene cannot import (context-imports), so
 * its slot is shown filled here; the page's behaviour is covered by the unit suite.
 */
const signIn = (
  <div className="cc-step" data-onboarding-step="claude-code.sign-in">
    <p className="cc-step__line">
      Sign in to your Claude account on this machine. Ferretry never sees the sign-in: Claude Code keeps it.
    </p>
    <section className="kt-panel flex flex-col gap-3 p-panel" data-fake-logins="">
      <p className="m-0 text-row font-semibold text-fg">Sign in to Claude Code</p>
      <p className="m-0 text-cell text-muted">Signs in on studio-mac, for every runtime that uses it.</p>
      <div className="cc-actions">
        <button type="button" className="kt-button">
          Sign in to Claude Code
        </button>
      </div>
    </section>
  </div>
);

const body =
  page === 'installed' ? (
    <InstalledPage client={client} step={step} />
  ) : page === 'sign-in' ? (
    signIn
  ) : page === 'import-choice' ? (
    <ImportChoicePage client={client} step={step} />
  ) : (
    <PermissionPage client={client} step={step} />
  );

createRoot(document.getElementById('root') as HTMLElement).render(
  <main className="scene-step">
    <p className="scene-progress">Claude Code · 1 of 4</p>
    <h1 className="scene-title">{TITLES[page] ?? 'Claude Code'}</h1>
    <div className="scene-body">{body}</div>
    <footer className="scene-footer">
      <button type="button" className="kt-button">
        Back
      </button>
      <button type="button" className="kt-button kt-button--primary">
        Next
      </button>
    </footer>
  </main>,
);
