/**
 * The browser entry for the Claude IMPORT pages: the REAL pages over a fixed fake daemon and a fake host scan, inside a plain
 * stand-in for the step frame (the real frame is O4's). Nothing reads a network; every name is made up.
 *
 *   ?page=settings|model-set|instructions|skills|mcp|conversations|run|run-everything|run-lost   ?theme=<family>-<mode>
 *   `run` is "Choose" mode with some items left out; `run-everything` is the everything mode's single page;
 *   `run-lost` is what a reload leaves (no memory of the choice).
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
};

const table: Record<string, unknown> = {
  ...importRoutes(scanOf()),
  'GET /v1/config/file': {
    path: 'harness-claude-code.yaml',
    text: 'binary: /fake/bin/claude\npermissionMode: skip\n',
    etag: 'e1',
    exists: true,
  },
  'PUT /v1/config/file': { path: 'harness-claude-code.yaml', etag: 'e2', outcome: 'applied' },
};
const client = {
  call: async (route: string, init?: unknown) => {
    const answer = table[route];
    if (answer === undefined) throw new Error(`no route ${route}`);
    return typeof answer === 'function' ? (answer as (init?: unknown) => unknown)(init) : answer;
  },
  subscribe: () => () => undefined,
} as never;

const CHOOSE: StepSegmentMemory = {
  importMode: 'choose',
  'skip:mcp': JSON.stringify(['claude-code:mcp:issues']),
  'skip:skills': JSON.stringify(['claude-code:skill:release-notes']),
};
const segment: StepSegmentMemory =
  page === 'run-everything' ? { importMode: 'everything' } : page === 'run-lost' ? {} : CHOOSE;

const step: StepHost = {
  phase: 'daemon',
  appliesTo: [],
  segment,
  remember: () => undefined,
  ready: () => undefined,
  skip: () => undefined,
  notNeeded: () => undefined,
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
