/**
 * The browser entry for the Claude IMPORT pages: the REAL pages over a fixed fake daemon and a fake host scan, inside a plain
 * stand-in for the step frame (the real frame is O4's). Nothing reads a network; every name is made up.
 *
 *   ?page=settings|model-set|instructions|skills|mcp|conversations|run|run-everything|run-lost|run-slow|run-locked   ?theme=<family>-<mode>
 *   `run` is "Choose" mode with some items left out; `run-everything` is the everything mode's single page;
 *   `run-lost` is what a reload leaves (no memory of the choice); `run-slow` holds the first import's first POST
 *   (it never answers, and ignores the abort) until `window.__import.releaseFirst()`; `?hold=<ms>` holds the import's apply; `run-locked` refuses every POST
 *   with `401 unlock_required` and raises an unlock prompt until `window.__import.unlock()`.
 */
import type { StepHost, StepSegmentMemory } from '@ferretry/kernel/contract';
import { createRoot } from 'react-dom/client';
import '../../../../app/features/onboarding/import/import.css';
import '../../../../app/features/onboarding/onboarding.css';
import { ConversationsPage } from '../../../../app/features/onboarding/import/conversations-page.tsx';
import { ImportRunPage } from '../../../../app/features/onboarding/import/import-run-page.tsx';
import {
  InstructionsPage,
  McpPage,
  ModelSetPage,
  SettingsPage,
  SkillsPage,
} from '../../../../app/features/onboarding/import/kind-page.tsx';
import { importRoutes, scanOf } from '../../../fixtures/onboarding/scan.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const page = params.get('page') ?? 'settings';

const TITLES: Record<string, string> = {
  settings: 'Settings',
  'model-set': 'Models',
  instructions: 'CLAUDE.md',
  skills: 'Skills',
  mcp: 'MCP servers',
  conversations: 'Conversations',
  run: 'Bring it over',
  'run-everything': 'Bring it over',
  'run-lost': 'Bring it over',
  'run-slow': 'Bring it over',
  'run-locked': 'Bring it over',
};

/** `?hold=<ms>`: the import's apply is held this long, so a test can look at the page while it works (C59 O5). */
const hold = Number(params.get('hold') ?? '0');
const routes = importRoutes(scanOf());
const applied = routes['POST /v1/runtimes/proposals/:proposalId/apply'];
const table: Record<string, unknown> = {
  ...routes,
  'POST /v1/runtimes/proposals/:proposalId/apply': async () => {
    await new Promise(resolve => setTimeout(resolve, hold));
    return applied;
  },
  'GET /v1/config/file': {
    path: 'harness-claude-code.yaml',
    text: 'binary: /fake/bin/claude\npermissionMode: skip\n',
    etag: 'e1',
    exists: true,
  },
  'PUT /v1/config/file': { path: 'harness-claude-code.yaml', etag: 'e2', outcome: 'applied' },
};
const answerOf = (route: string, init?: unknown): unknown => {
  const answer = table[route];
  if (answer === undefined) throw new Error(`no route ${route}`);
  return typeof answer === 'function' ? (answer as (init?: unknown) => unknown)(init) : answer;
};

/** What the C59 O5-10 timeout and unlock cases let the test see and drive (a browser fact, not a scene detail). */
interface ImportProbe {
  /** Every POST the page sent, in order, with whether its signal had aborted by now. */
  sent: { route: string; signal: AbortSignal | undefined }[];
  /** `run-slow`: answers the FIRST attempt's held stage POST late. */
  releaseFirst: () => void;
  /** `run-locked`: how many times the machine asked for the unlock. */
  unlockPrompts: number;
  /** `run-locked`: the person confirms with the passkey: POSTs go through from here on. */
  unlock: () => void;
}
const probe: ImportProbe = {
  sent: [],
  releaseFirst: () => undefined,
  unlockPrompts: 0,
  unlock: () => undefined,
};
(window as unknown as { __import: ImportProbe }).__import = probe;

const isPost = (route: string): boolean => route.startsWith('POST ');

/** `run-slow`: the first POST never answers until `releaseFirst` (and ignores the abort, the worst case); later ones answer. */
let firstHeld = true;
/** `run-locked`: every POST raises the unlock prompt and is refused until the person unlocks. */
let locked = page === 'run-locked';
probe.unlock = () => {
  locked = false;
};

const client = {
  call: async (route: string, init?: { readonly signal?: AbortSignal }) => {
    if (!isPost(route)) return answerOf(route, init);
    probe.sent.push({ route, signal: init?.signal });
    if (locked) {
      probe.unlockPrompts += 1;
      const prompt = document.createElement('div');
      prompt.setAttribute('role', 'dialog');
      prompt.setAttribute('data-unlock-prompt', String(probe.unlockPrompts));
      document.body.append(prompt);
      throw Object.assign(new Error('this machine asks you to confirm it is you with a passkey'), {
        status: 401,
        code: 'unlock_required',
      });
    }
    if (page === 'run-slow' && firstHeld) {
      firstHeld = false;
      return await new Promise(resolve => {
        probe.releaseFirst = () => resolve(answerOf(route, init));
      });
    }
    return answerOf(route, init);
  },
  subscribe: () => () => undefined,
} as never;

const CHOOSE: StepSegmentMemory = {
  importMode: 'choose',
  'skip:mcp': JSON.stringify(['claude-code:mcp:issues']),
  'skip:skills': JSON.stringify(['claude-code:skill:release-notes']),
};
const segment: StepSegmentMemory =
  page === 'run-everything' || page === 'run-slow' || page === 'run-locked'
    ? { importMode: 'everything' }
    : page === 'run-lost'
      ? {}
      : CHOOSE;

const step: StepHost = {
  phase: 'daemon',
  appliesTo: [],
  segment,
  remember: () => undefined,
  ready: () => undefined,
  skip: () => undefined,
  notNeeded: () => undefined,
  commit: () => undefined,
  done: () => undefined,
  busy: () => undefined,
  next: () => undefined,
  back: () => undefined,
};

const PAGES = {
  settings: SettingsPage,
  'model-set': ModelSetPage,
  instructions: InstructionsPage,
  skills: SkillsPage,
  mcp: McpPage,
  conversations: ConversationsPage,
} as const;
const Page = PAGES[page as keyof typeof PAGES] ?? ImportRunPage;

createRoot(document.getElementById('root') as HTMLElement).render(
  <main className="scene-step">
    <p className="scene-progress">Claude Code · 4 of 11</p>
    <h1 className="scene-title">{TITLES[page] ?? 'Claude Code'}</h1>
    <div className="scene-body">
      <Page client={client} step={step} />
    </div>
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
