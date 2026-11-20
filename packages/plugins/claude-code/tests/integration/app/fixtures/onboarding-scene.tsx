/**
 * The browser entry for the Claude segment's first-run pages: the REAL pages over a fixed fake daemon, drawn the way the
 * setup flow draws a page — inside the shared `StepPageFrame`, with a host whose `commit` the footer's Next runs (contract
 * rule 8). Nothing reads a network. Every name, path and command below is made up. The daemon records what reached it on
 * `window.__fake` (every PUT of the config file, with its YAML), so the visual test can prove what Next wrote.
 *
 *   ?page=installed|installed-manual|sign-in|import-choice|conversations|permission|permission-auto
 *   ?theme=<family>-<mode>   ?save=fail (the first PUT is refused)
 */
import { StepPageFrame } from '@ferretry/app';
import type { StepHost } from '@ferretry/kernel/contract';
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../../app/features/onboarding/onboarding.css';
import { ConversationsPage } from '../../../../app/features/onboarding/import/conversations-page.tsx';
import { ImportChoicePage } from '../../../../app/features/onboarding/import-choice-page.tsx';
import { InstalledPage } from '../../../../app/features/onboarding/installed-page.tsx';
import { PermissionPage } from '../../../../app/features/onboarding/permission-page.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const page = params.get('page') ?? 'installed';
let refuse = params.get('save') === 'fail';

const TITLES: Record<string, string> = {
  installed: 'Install Claude Code',
  'installed-manual': 'Install Claude Code',
  'sign-in': 'Sign in to Claude',
  'import-choice': 'What to bring over',
  conversations: 'Conversations',
  permission: 'Permissions',
  'permission-auto': 'Permissions',
};

interface Fake {
  /** Every PUT of `harness-claude-code.yaml` the page made, in order. */
  puts: { path: string; text: string }[];
  advanced: boolean;
  done: number;
}
const fake: Fake = { puts: [], advanced: false, done: 0 };
(window as unknown as { __fake: Fake }).__fake = fake;

const FILE = 'binary: /fake/bin/claude\npermissionMode: skip\nhostHistory: true\n';
const AUTO_FILE = 'binary: /fake/bin/claude\npermissionMode: auto\nhostHistory: true\n';
let etag = 1;
const table: Record<string, (request?: { body?: unknown }) => unknown> = {
  'GET /v1/claude-code/update': () => ({ location: { state: 'absent', searched: ['/fake/bin'] } }),
  'GET /v1/runtimes/setup/scan': () => ({
    tools: [
      {
        harness: 'claude-code',
        label: 'Claude Code',
        installed: false,
        install:
          page === 'installed-manual'
            ? {
                kind: 'no-package-manager',
                reason: 'No package manager was found on this machine.',
                manualCommand: 'curl -fsSL https://example.invalid/install | sh',
              }
            : { kind: 'runnable', command: 'npm install --global @fake/claude-code' },
      },
    ],
  }),
  'GET /v1/config/file': () => ({
    path: 'harness-claude-code.yaml',
    text: fake.puts.at(-1)?.text ?? (page === 'permission-auto' ? AUTO_FILE : FILE),
    etag: `e${String(etag)}`,
    exists: true,
  }),
  'PUT /v1/config/file': request => {
    if (refuse) {
      refuse = false;
      throw new Error('The machine refused the write.');
    }
    const body = request?.body as { path: string; text: string };
    fake.puts.push({ path: body.path, text: body.text });
    etag += 1;
    return { path: body.path, etag: `e${String(etag)}`, outcome: 'applied' };
  },
};
const client = {
  call: async (route: string, request?: { body?: unknown }) => {
    const answer = table[route];
    if (answer === undefined) throw new Error(`no route ${route}`);
    return answer(request);
  },
  subscribe: () => () => undefined,
} as never;

/**
 * The sign-in page's shape: its own intro line, then what Logins draws in the slot (in outline: a card with its one
 * button). The page itself needs the shell's slot machinery, which a browser scene cannot import (context-imports), so
 * its slot is shown filled here; the page's behaviour is covered by the unit suite and the app-wide onboarding walk.
 */
const signIn = (
  <div className="cc-step" data-onboarding-step="claude-code.sign-in">
    <p className="cc-step__line">Sign in to your Claude account on this machine. Ferretry never sees it.</p>
    <section className="kt-panel flex flex-col gap-3 p-panel" data-fake-logins="">
      <p className="m-0 text-row font-semibold text-fg">Sign in to Claude Code</p>
      <p className="m-0 text-cell text-muted">Signs in on studio-mac, for every runtime that uses it.</p>
      <button type="button" className="kt-button">
        Sign in to Claude Code
      </button>
    </section>
  </div>
);

function Host() {
  const save = useRef<(() => Promise<void>) | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [moved, setMoved] = useState(false);
  const hostRef = useRef<StepHost | null>(null);
  hostRef.current ??= {
    phase: 'daemon',
    appliesTo: [],
    segment: {},
    remember: () => undefined,
    ready: () => setReady(true),
    skip: () => undefined,
    notNeeded: () => undefined,
    commit: next => {
      save.current = next;
    },
    done: () => {
      fake.done += 1;
    },
    busy: () => undefined,
    next: () => undefined,
    back: () => undefined,
  };
  const press = () => {
    if (busy) return;
    const run = save.current;
    if (run === null) {
      fake.advanced = true;
      setMoved(true);
      return;
    }
    setBusy(true);
    setError(null);
    new Promise<void>(resolve => resolve(run()))
      .then(
        () => {
          fake.advanced = true;
          setMoved(true);
        },
        (cause: unknown) => setError(cause instanceof Error ? cause.message : 'That could not be saved.'),
      )
      .finally(() => setBusy(false));
  };
  if (moved) return <main data-next-page="">The next page</main>;
  const step = hostRef.current;
  const body =
    page === 'installed' || page === 'installed-manual' ? (
      <InstalledPage client={client} step={step} />
    ) : page === 'sign-in' ? (
      signIn
    ) : page === 'import-choice' ? (
      <ImportChoicePage client={client} step={step} />
    ) : page === 'conversations' ? (
      <ConversationsPage client={client} step={step} />
    ) : (
      <PermissionPage client={client} step={step} />
    );
  return (
    <div style={{ height: '100vh', overflow: 'auto' }}>
      <StepPageFrame
        title={TITLES[page] ?? 'Claude Code'}
        back={{ onClick: () => undefined }}
        next={{ label: 'Next', disabled: page !== 'sign-in' && !ready, busy, onClick: press }}
        {...(error === null
          ? {}
          : {
              note: (
                <p role="alert" data-flow-commit-error="">
                  {error}
                </p>
              ),
            })}
      >
        {body}
      </StepPageFrame>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Host />);
