/**
 * The browser entry for the Claude segment's first-run pages: the REAL pages over a fixed fake daemon, drawn the way the
 * setup flow draws a page — inside the shared `StepPageFrame`, with a host whose `commit` the footer's Next runs (contract
 * rule 8). Nothing reads a network. Every name, path and command below is made up. The daemon records what reached it on
 * `window.__fake` (every PUT of the config file, with its YAML), so the visual test can prove what Next wrote.
 *
 *   ?page=installed|installed-manual|sign-in|import-choice|conversations
 *        |kind-settings|kind-model-set|kind-instructions|kind-skills|kind-mcp
 *   ?theme=<family>-<mode>   ?save=fail (the first PUT is refused)
 *   ?reread=withheld (the read AFTER a refused PUT is withheld, the one after that readable again)
 *   ?read=pending (the file carries a change held for the owner)   ?read=pending-once (held at the first read only: the owner confirmed it)   ?signin=chooser (the sign-in slot draws a harness chooser)
 *   ?signin=real (the REAL SignInPage, outside a shell so its slot is empty and it draws its "not available" line; the host locks the whole footer on `busy(label)` as the shell does)
 */
import { StepPageFrame } from '@ferretry/app';
import type { StepHost, StepSegmentMemory } from '@ferretry/kernel/contract';
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../../app/features/onboarding/onboarding.css';
import { ConversationsPage } from '../../../../app/features/onboarding/import/conversations-page.tsx';
import { ImportChoicePage } from '../../../../app/features/onboarding/import-choice-page.tsx';
import { InstalledPage } from '../../../../app/features/onboarding/installed-page.tsx';
import {
  InstructionsPage,
  McpPage,
  ModelSetPage,
  SettingsPage,
  SkillsPage,
} from '../../../../app/features/onboarding/import/kind-page.tsx';
import { SignInPage } from '../../../../app/features/onboarding/sign-in-page.tsx';
import { importRoutes, scanOf } from '../../../fixtures/onboarding/scan.ts';

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
  'kind-settings': 'Settings',
  'kind-model-set': 'Models',
  'kind-instructions': 'CLAUDE.md',
  'kind-skills': 'Skills',
  'kind-mcp': 'MCP servers',
};
const KIND_PAGES = {
  'kind-settings': SettingsPage,
  'kind-model-set': ModelSetPage,
  'kind-instructions': InstructionsPage,
  'kind-skills': SkillsPage,
  'kind-mcp': McpPage,
} as const;
/** What a run remembers when the person chose "Choose what to import": a couple of items left out. */
const SEGMENT: StepSegmentMemory = page.startsWith('kind-')
  ? { importMode: 'choose', 'skip:mcp': JSON.stringify(['claude-code:mcp:issues']) }
  : {};

interface Fake {
  /** Every PUT of `harness-claude-code.yaml` the page made, in order. */
  puts: { path: string; text: string }[];
  /** Every read of the config file, in order. */
  gets: number;
  advanced: boolean;
  done: number;
}
const fake: Fake = { puts: [], gets: 0, advanced: false, done: 0 };
const WITHHELD =
  '# ‹hidden›: the text of this file is not shown because it holds a raw secret, which the owner must move into the secret store; edit it at the machine\n';
let refusedOnce = false;
let withheldServed = false;
(window as unknown as { __fake: Fake }).__fake = fake;

const FILE = 'binary: /fake/bin/claude\npermissionMode: skip\nhostHistory: true\n';
let etag = 1;
const kindRoutes = page.startsWith('kind-') ? importRoutes(scanOf()) : {};
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
            : { kind: 'runnable', command: 'npm install --global --no-fund @fake/claude-code' },
      },
    ],
  }),
  'GET /v1/config/file': () => {
    fake.gets += 1;
    const withheld = params.get('reread') === 'withheld' && refusedOnce && !withheldServed;
    if (withheld) withheldServed = true;
    return {
      path: 'harness-claude-code.yaml',
      text: withheld ? WITHHELD : (fake.puts.at(-1)?.text ?? FILE),
      etag: `e${String(etag)}`,
      exists: true,
      state:
        params.get('read') === 'pending' || (params.get('read') === 'pending-once' && fake.gets === 1)
          ? 'pending'
          : 'ok',
    };
  },
  'PUT /v1/config/file': request => {
    if (refuse) {
      refuse = false;
      refusedOnce = true;
      throw new Error('The machine refused the write.');
    }
    const body = request?.body as { path: string; text: string };
    fake.puts.push({ path: body.path, text: body.text });
    etag += 1;
    return { path: body.path, etag: `e${String(etag)}`, outcome: 'applied' };
  },
};
// The import pages read the fake host scan (the kind pages) instead of the installer's plan.
for (const [route, answer] of Object.entries(kindRoutes))
  table[route] = typeof answer === 'function' ? (answer as (request?: { body?: unknown }) => unknown) : () => answer;
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
 * its slot is shown filled here. The repo's `context-imports` rule keeps a plugin's tests from importing Logins' app half, so the
 * REAL slot is proved at the two seams it can be: `tests/unit/app/slots.test.ts` pins the registry (the ONLY panel placed in
 * `claude-code.sign-in` is Logins' harness-locked `claude-code-sign-in`, never its generic add-login), and Logins' own
 * `sign-in-harness.visual.test.ts` measures that panel in a browser (zero radios; the generic one keeps its two). The page's
 * behaviour is covered by the unit suite.
 */
const signIn = (
  <div className="cc-step" data-onboarding-step="claude-code.sign-in">
    <p className="cc-step__line">Sign in to Claude on this machine. Ferretry never sees it: Claude Code keeps it.</p>
    {params.get('signin') === 'chooser' ? (
      // What a generic add-login panel draws: a harness chooser. The visual test must catch this in the slot.
      <section className="kt-panel flex flex-col gap-3 p-panel" data-fake-logins="">
        <fieldset className="flex gap-2 border-0 p-0">
          <legend className="sr-only">Harness</legend>
          <label className="kt-button">
            <input type="radio" name="harness" defaultChecked /> Claude Code
          </label>
          <label className="kt-button">
            <input type="radio" name="harness" /> Codex
          </label>
        </fieldset>
      </section>
    ) : (
      <section className="kt-panel flex flex-col gap-3 p-panel" data-fake-logins="">
        <p className="m-0 text-row font-semibold text-fg">Sign in to Claude Code</p>
        <p className="m-0 text-cell text-muted">Signs in on studio-mac, for every runtime that uses it.</p>
        <button type="button" className="kt-button">
          Sign in to Claude Code
        </button>
      </section>
    )}
  </div>
);

function Host() {
  const save = useRef<(() => Promise<void>) | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The label of a `busy(label)` the page raised: the shell locks Back, Later and Next whole while it stands (rule 8). */
  const [held, setHeld] = useState<string | null>(null);
  const [moved, setMoved] = useState(false);
  const hostRef = useRef<StepHost | null>(null);
  hostRef.current ??= {
    phase: 'daemon',
    appliesTo: [],
    segment: SEGMENT,
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
    busy: label => setHeld(label),
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
    ) : page === 'sign-in' && params.get('signin') === 'real' ? (
      <SignInPage client={client} step={step} />
    ) : page === 'sign-in' ? (
      signIn
    ) : page === 'import-choice' ? (
      <ImportChoicePage client={client} step={step} />
    ) : page in KIND_PAGES ? (
      (() => {
        const Kind = KIND_PAGES[page as keyof typeof KIND_PAGES];
        return <Kind client={client} step={step} />;
      })()
    ) : (
      <ConversationsPage client={client} step={step} />
    );
  return (
    <div style={{ height: '100vh', overflow: 'auto' }}>
      <StepPageFrame
        title={TITLES[page] ?? 'Claude Code'}
        back={{ disabled: held !== null, onClick: () => undefined }}
        later={{ disabled: held !== null, onClick: () => undefined }}
        next={{ label: 'Next', disabled: (page !== 'sign-in' && !ready) || held !== null, busy, onClick: press }}
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
