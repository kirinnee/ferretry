/**
 * The browser entry for the Codex import pages: the REAL pages over a fixed fake daemon, inside the app's own `StepPageFrame`.
 * Nothing reads a network. Every name, path and command below is made up.
 *
 *   ?page=settings|model-set|instructions|skills|mcp|conversations|conversations-pick|run|run-done|run-everything|run-unreviewed
 *   &theme=<family>-<mode>
 *
 * `conversations-pick` is the page after the person chose the other card (Save and Leave it as it is on screen, nothing
 * written). `run-done` is the run page after the import (the daemon's own sentences). `run-unreviewed` is a reload since
 * the pages were seen: everything is left out and the page says so.
 */
import { StepPageFrame } from '@ferretry/app';
import { createRoot } from 'react-dom/client';
import { ConversationsPage } from '../../../../app/features/onboarding/import/conversations-page.tsx';
import { ImportRunPage } from '../../../../app/features/onboarding/import/import-run-page.tsx';
import { KindPage } from '../../../../app/features/onboarding/import/kind-page.tsx';
import { KIND_OF_STEP } from '../../../../app/features/onboarding/import/import-memory.ts';
import type { StepHost } from '../../../../app/features/onboarding/onboarding-api.ts';
import { APPLIED_SENTENCES, CODEX_FULL, MACHINE, scanOf, stagedFrom } from '../../../support/import-fixtures.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const page = params.get('page') ?? 'settings';

const COPY: Record<string, { title: string; line: string; step: number }> = {
  settings: { title: 'Settings', line: 'Choose what to bring over from Codex.', step: 4 },
  'model-set': { title: 'Models', line: 'Choose what to bring over from Codex.', step: 5 },
  instructions: { title: 'AGENTS.md', line: 'Choose what to bring over from Codex.', step: 6 },
  skills: { title: 'Skills', line: 'Choose what to bring over from Codex.', step: 7 },
  mcp: { title: 'MCP servers', line: 'Choose what to bring over from Codex.', step: 8 },
  conversations: { title: 'Conversations', line: 'Your terminal conversations, read one way.', step: 9 },
  run: { title: 'Bring it over', line: 'One import, once.', step: 10 },
};
const copyKey = page.startsWith('run') ? 'run' : page.startsWith('conversations') ? 'conversations' : page;
const copy = COPY[copyKey] ?? COPY.settings;

const REVIEWED = (kind: string, left: readonly string[] = []) => [`review.${kind}`, JSON.stringify({ left, env: [] })];
const segment: Record<string, string | number | boolean | undefined> =
  page === 'run-everything'
    ? { importMode: 'everything' }
    : page === 'run-unreviewed'
      ? { importMode: 'choose' }
      : page.startsWith('run')
        ? {
            importMode: 'choose',
            ...Object.fromEntries([
              REVIEWED('settings'),
              REVIEWED('model-set', ['codex:profile:deep']),
              REVIEWED('instructions'),
              REVIEWED('skills', ['codex:skill:deploy']),
              REVIEWED('mcp'),
            ]),
          }
        : { importMode: 'choose' };

let fileText = page === 'conversations' || page === 'conversations-pick' ? 'permissionMode: skip\n' : '';
const table: Record<string, unknown> = {
  'GET /v1/runtimes/setup/scan': scanOf(CODEX_FULL),
  'GET /v1/claude-code/update': { installed: { state: 'ok', version: '2.1.0' } },
  'GET /v1/codex/update': { installed: { state: 'ok', version: '0.9.0' } },
  'GET /v1/runtimes/machine': MACHINE,
  'POST /v1/runtimes/proposals': (body: unknown) => stagedFrom({ body }),
  'POST /v1/runtimes/proposals/:proposalId/apply': {
    outcome: 'executed',
    executor: 'setup',
    summary: APPLIED_SENTENCES,
  },
  'GET /v1/config/file': () => ({
    path: 'harness-codex.yaml',
    text: fileText,
    etag: 'e1',
    exists: true,
    absolutePath: '/fake/home/config/harness-codex.yaml',
  }),
  'PUT /v1/config/file': (body: unknown) => {
    fileText = (body as { text: string }).text;
    return { outcome: 'applied' };
  },
};
const client = {
  call: async (route: string, options?: { readonly body?: unknown }) => {
    if (!(route in table)) throw new Error(`no route ${route}`);
    const answer = table[route];
    return typeof answer === 'function' ? (answer as (body: unknown) => unknown)(options?.body) : answer;
  },
  subscribe: () => () => undefined,
} as never;

const step: StepHost = {
  phase: 'daemon',
  appliesTo: [],
  segment,
  remember: () => undefined,
  ready: () => undefined,
  skip: () => undefined,
  done: () => undefined,
  busy: () => undefined,
  next: () => undefined,
  back: () => undefined,
};

const kind = KIND_OF_STEP[`import-${page}`];
const body =
  page === 'conversations' || page === 'conversations-pick' ? (
    <ConversationsPage client={client} step={step} />
  ) : page.startsWith('run') ? (
    <ImportRunPage client={client} step={step} />
  ) : kind !== undefined ? (
    <KindPage client={client} step={step} kind={kind} />
  ) : null;

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
      step: copy?.step ?? 4,
      of: 11,
    }}
  >
    {body}
  </StepPageFrame>,
);
