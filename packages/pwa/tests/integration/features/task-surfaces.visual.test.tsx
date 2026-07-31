/**
 * Visual contract for the ported feature surfaces.
 *
 * The port is only finished if it LOOKS like the original, so this renders each
 * ported component beside a verbatim transcription of kteam's own JSX — same
 * data, same compiled stylesheet — and requires the two screenshots to be
 * byte-identical at a phone width and a desktop width.
 *
 * The stylesheet is the REAL one: Tailwind is compiled from
 * `src/styles/index.css` with the shipped config, widened only to also scan
 * this file so the reference markup's classes exist. A hand-written fixture
 * sheet would let a missing class fail both sides equally and pass.
 *
 * The references differ from the port in ARIA only (`role`/`aria-label`
 * attributes and the fieldset/ul elements that carry them). Those carry no
 * rendered box, and where the element itself differs the port adds the reset
 * that keeps the box identical — which is exactly what this test proves.
 */

import { afterAll, beforeAll, describe, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ShieldAlert } from 'lucide-react';
import { Bot, FileText, GitPullRequest } from 'lucide-react';
import type { TaskLive, TaskStatus, TaskSummary, WardenStatusView } from '@ferretry/protocol';
import { chromium, type Browser } from 'playwright-core';
import { renderToStaticMarkup } from 'react-dom/server';
import should from 'should';

import { TaskRow, TaskQuickSummary } from '../../../src/features/tasks/task-row.tsx';
import { TASK_BOARD_LANE_META, taskBoardLane, taskReference } from '../../../src/features/tasks/task-board-model.ts';
import { TASK_STATUS_META, taskStatusCounts } from '../../../src/features/tasks/task-presentation.ts';
import { TaskStatusFilter } from '../../../src/features/tasks/task-status-filter.tsx';
import { WardenStrip } from '../../../src/features/warden/warden-strip.tsx';
import {
  wardenAccountLabel,
  wardenAccountTitle,
  wardenAnomalyCountLabel,
  wardenAnomalyDigest,
} from '../../../src/features/warden/warden-status-model.ts';
import { daemonId } from '../../../src/lib/daemon-connection.ts';
import { relativeTime } from '../../../src/lib/session-screens.ts';

const packageDir = resolve(import.meta.dir, '../../..');
const NOW = Date.parse('2026-07-31T12:00:00.000Z');
const alpha = daemonId('daemon-alpha');

// ─── fixtures ────────────────────────────────────────────────────────────────

const task = (overrides: Partial<Omit<TaskSummary, 'live'>> & { live?: Partial<TaskLive> }): TaskSummary => ({
  v: 1,
  id: 'F12',
  kind: 'feature',
  title: 'Port the remaining PWA components',
  workflow: 'quick',
  phase: 'todo',
  dependsOn: [],
  status: 'todo',
  statusReason: null,
  assignee: null,
  repo: null,
  files: [],
  links: { prs: [], branch: null, commits: [], docs: [] },
  order: null,
  createdAt: '2026-07-30T09:00:00.000Z',
  createdBy: null,
  updatedAt: '2026-07-31T09:00:00.000Z',
  descriptionChars: 0,
  askChars: 40,
  askSource: 'slack',
  clarificationCount: 0,
  blocked: false,
  blockedReason: null,
  blockedSince: null,
  blockedBy: [],
  ...overrides,
  live: {
    assigneeSessionId: null,
    assigneeName: null,
    assigneeStatus: null,
    assigneeHealth: null,
    assigneeDoneMarker: false,
    assigneeLastActivityAt: null,
    staleness: null,
    ...overrides.live,
  },
});

const working = task({
  id: 'F12',
  phase: 'build',
  status: 'in_progress',
  assignee: 'hayden',
  askSource: 'agent: warden',
  files: ['packages/pwa/src/features/tasks/task-row.tsx'],
  links: { prs: ['https://github.com/kirinnee/ferretry/pull/49'], branch: null, commits: [], docs: [] },
  live: { assigneeSessionId: 'sess-1', assigneeName: 'Hayden', assigneeHealth: 'active' },
});

const blockedTask = task({
  id: 'B7',
  kind: 'bug',
  title: 'Transcript detaches on prepend',
  phase: 'build',
  status: 'blocked',
  blocked: true,
  statusReason: 'waiting on the scroller port',
  blockedReason: 'Blocked by the scroller port',
  blockedSince: '2026-07-30T08:00:00.000Z',
  blockedBy: ['F12'],
  dependsOn: ['F12'],
  live: { staleness: 'quiet' },
});

const TASKS = [working, blockedTask, task({ id: 'C3', kind: 'chore', phase: 'done', status: 'done' })];
const COUNTS = taskStatusCounts(TASKS);
const SELECTED: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['blocked']);

const warden: WardenStatusView = {
  config: {
    enabled: true,
    accounts: [{ agent: 'claude-auto-loge' }],
    failover: { policy: 'fallback', failureThreshold: 3, cooldownMinutes: 30 },
    providerOutage: { minDistinctSessions: 2, persistenceSweeps: 2, tailLines: 40 },
    intervalMinutes: 5,
    unattendedMinutes: 20,
    minSpawnGapMinutes: 10,
    susThinkingSeconds: 600,
    susSubprocessSeconds: 900,
    maxAssignedWardens: 2,
    assignedCooldownMinutes: 15,
    blessMinutes: 30,
  },
  lastSweepAt: '2026-07-31T11:57:00.000Z',
  anomalies: [
    { kind: 'sus_thinking', sessionId: 'sess-1', status: 'thinking', detail: 'thinking for 14m', teammate: 'ms-98' },
  ],
  fingerprint: 'visual',
  liveWarden: 'sess-9',
  failover: {
    policy: 'fallback',
    failureThreshold: 3,
    cooldownMinutes: 30,
    accounts: [
      { agent: 'claude-auto-loge', eligible: true },
      { agent: 'codex-auto-terra', eligible: false, reason: 'at limit' },
    ],
    lastSelection: {
      agent: 'claude-auto-loge',
      policy: 'fallback',
      at: '2026-07-31T11:00:00.000Z',
      reason: 'first eligible',
    },
  },
};

// ─── verbatim kteam references ───────────────────────────────────────────────

/** `ui/src/components/TaskStatusFilter.tsx`, transcribed. */
function OriginalStatusFilter() {
  const total = [...COUNTS.values()].reduce((sum, count) => sum + count, 0);
  const statuses = [...COUNTS.keys()].concat([...SELECTED].filter(status => !COUNTS.has(status)));
  const ordered = (Object.keys(TASK_STATUS_META) as TaskStatus[]).filter(status => statuses.includes(status));
  return (
    <div className="flex min-w-0 gap-xs overflow-x-auto overscroll-x-contain pb-1 scroll-thin">
      <button
        type="button"
        className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center gap-xs rounded-control border px-2 text-2xs font-semibold border-border-soft bg-surface text-muted hover:border-accent-border hover:text-fg"
      >
        All <span className="mono text-faint">{total}</span>
      </button>
      {ordered.map(status => {
        const active = SELECTED.has(status);
        const count = COUNTS.get(status) ?? 0;
        const { label, tone } = TASK_STATUS_META[status];
        return (
          <button
            key={status}
            type="button"
            data-tone={tone}
            title={active ? `Remove ${label} from the filter` : `Show ${label} tasks`}
            className={`kt-task-tone inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center gap-xs rounded-control border px-2 text-2xs font-semibold ${
              active
                ? 'kt-task-chip-active'
                : 'border-border-soft bg-surface text-muted hover:border-accent-border hover:text-fg'
            }`}
          >
            <span className="kt-task-tone-dot" aria-hidden="true" />
            {label} <span className={`mono ${active ? 'kt-task-tone-ink' : 'text-faint'}`}>{count}</span>
          </button>
        );
      })}
    </div>
  );
}

/** `ui/src/components/TaskPresentation.tsx` → `TaskRow`, transcribed. */
function OriginalTaskRow({ entry }: { entry: TaskSummary }) {
  const boardState = entry.blocked ? TASK_STATUS_META.blocked : TASK_BOARD_LANE_META[taskBoardLane(entry.phase)];
  const stale = entry.live.staleness ? 'Evidence recorded' : null;
  const phaseNote = !entry.blocked && entry.phase !== 'dropped' ? entry.statusReason : null;
  const pr = entry.links.prs[0];
  return (
    <div data-tone={boardState.tone} className="kt-task-tone kt-task-rail group min-w-0 px-3 py-2 hover:bg-surface-2">
      <button
        type="button"
        className="flex min-h-[44px] w-full min-w-0 flex-col justify-center gap-1 text-left focus-visible:z-10"
      >
        <span className="block w-full whitespace-normal break-words text-row font-semibold leading-tight text-fg">
          {entry.title}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="mono shrink-0 text-2xs font-medium text-faint">{taskReference(entry.id)}</span>
          {entry.askSource.startsWith('agent') && (
            <span className="inline-flex shrink-0 items-center text-faint" title="Original ask came from an agent">
              <Bot size={11} aria-hidden="true" />
              <span className="sr-only">Agent-originated</span>
            </span>
          )}
          <span data-tone={boardState.tone} className="kt-badge shrink-0 whitespace-nowrap">
            {boardState.label}
          </span>
          {stale !== null && (
            <span className="inline-flex shrink-0">
              <span className="sr-only">{stale}</span>
              <span data-tone="warn" className="kt-badge animate-pulse motion-reduce:animate-none">
                !
              </span>
            </span>
          )}
        </span>
        <span className="block w-full min-w-0">
          {entry.blocked && entry.blockedReason !== null && (
            <span className="mt-0.5 block truncate text-xs font-medium text-warn">{entry.blockedReason}</span>
          )}
          {phaseNote !== null && (
            <span className="mt-0.5 block truncate text-xs font-medium text-warn">Phase note · {phaseNote}</span>
          )}
          {entry.blockedBy.length > 0 && (
            <span className="mt-0.5 block truncate text-xs text-warn">
              Blocked by {entry.blockedBy.map(taskReference).join(', ')}
            </span>
          )}
          {entry.dependsOn.length > 0 && (
            <span className="mt-0.5 block truncate text-xs text-muted">
              Depends on {entry.dependsOn.map(taskReference).join(', ')}
            </span>
          )}
          {entry.files.length > 0 && (
            <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted">
              <FileText size={11} aria-hidden="true" className="shrink-0" />
              <span className="truncate">{entry.files.join(', ')}</span>
            </span>
          )}
        </span>
      </button>
      <div className="mt-1 min-w-0 items-center gap-2 flex">
        <span className="flex min-w-0 items-center gap-1 text-xs text-muted max-w-full">
          <span
            aria-hidden="true"
            className={`h-2 w-2 shrink-0 rounded-full ${
              entry.live.staleness
                ? 'bg-warn animate-pulse motion-reduce:animate-none'
                : entry.live.assigneeHealth === 'active'
                  ? 'bg-ok'
                  : 'bg-muted'
            }`}
          />
          {entry.live.assigneeSessionId ? (
            <a
              href={`/d/daemon-alpha/session/${entry.live.assigneeSessionId}`}
              className="min-w-0 truncate font-semibold text-accent hover:underline"
            >
              {entry.live.assigneeName}
            </a>
          ) : (
            <span className="min-w-0 truncate font-semibold text-fg-soft">{entry.assignee ?? 'Unassigned'}</span>
          )}
        </span>
        {pr !== undefined && (
          <a
            href={pr}
            target="_blank"
            rel="noreferrer"
            className="ml-auto hidden shrink-0 items-center gap-1 rounded-control border border-border-soft px-1.5 py-1 text-xs text-muted hover:text-fg sm:inline-flex"
          >
            <GitPullRequest size={13} aria-hidden="true" />
            ferretry#49
          </a>
        )}
      </div>
    </div>
  );
}

/** `ui/src/components/TaskPresentation.tsx` → `TaskQuickSummary`, transcribed. */
function OriginalQuickSummary({ entry }: { entry: TaskSummary }) {
  const state = entry.blocked ? TASK_STATUS_META.blocked : TASK_BOARD_LANE_META[taskBoardLane(entry.phase)];
  return (
    <section data-tone={state.tone} className="kt-task-tone kt-task-summary p-3">
      <span className="kt-label">Quick summary</span>
      <div className="mt-2 flex flex-col gap-1.5 text-ui leading-relaxed text-fg">
        <p>
          <strong>{state.label}.</strong>
        </p>
        <p>{entry.title}</p>
        <p className="whitespace-pre-wrap break-words text-warn">{entry.blockedReason}</p>
        <p>Waiting on {entry.blockedBy.map(taskReference).join(', ')}.</p>
        <p>Blocked since 2026-07-30 08:00:00.</p>
        <p>Unassigned.</p>
        <p>Depends on {entry.dependsOn.map(taskReference).join(', ')}.</p>
      </div>
    </section>
  );
}

/** `ui/src/components/WardenStrip.tsx`, transcribed. */
function OriginalWardenStrip() {
  const digest = wardenAnomalyDigest(warden.anomalies);
  const accounts = warden.failover?.accounts ?? [];
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border-soft bg-surface-2 px-3 py-2 text-[12px]">
      <span className="inline-flex items-center gap-1.5 font-medium text-fg-soft">
        <ShieldAlert size={14} className="text-warn" aria-hidden="true" />
        Fleet checks
      </span>
      <span className="text-border">·</span>
      <span className="mono text-muted">last sweep {relativeTime(warden.lastSweepAt, NOW)}</span>
      <span className="text-border">·</span>
      <span className="mono font-medium text-warn">{wardenAnomalyCountLabel(digest.count)}</span>
      <span className="text-border">·</span>
      <span className="mono text-faint">every {warden.config.intervalMinutes}m</span>
      <span className="text-border">·</span>
      <span className="mono text-accent">warden live</span>
      <span className="text-border">·</span>
      <span className="inline-flex flex-wrap items-center gap-1">
        {accounts.map(account => (
          <span
            key={account.agent}
            title={wardenAccountTitle(account)}
            className={
              account.eligible
                ? 'mono rounded-control bg-ok/10 px-1.5 py-0.5 text-ok'
                : 'mono rounded-control bg-warn/10 px-1.5 py-0.5 text-warn'
            }
          >
            {wardenAccountLabel(account)}
            {account.agent === warden.failover?.lastSelection?.agent ? ' ●' : ''}
          </span>
        ))}
      </span>
      <span className="mono ml-auto min-w-0 truncate text-faint" title={digest.detail}>
        {digest.summary}
      </span>
    </div>
  );
}

// ─── page assembly ───────────────────────────────────────────────────────────

function Port() {
  return (
    <>
      <TaskStatusFilter counts={COUNTS} selected={SELECTED} onSelect={() => {}} onShowAll={() => {}} />
      {TASKS.slice(0, 2).map(entry => (
        <TaskRow daemonId={alpha} key={entry.id} onOpen={() => {}} task={entry} />
      ))}
      <TaskQuickSummary task={blockedTask} />
      <WardenStrip now={NOW} status={warden} />
    </>
  );
}

function Reference() {
  return (
    <>
      <OriginalStatusFilter />
      {TASKS.slice(0, 2).map(entry => (
        <OriginalTaskRow entry={entry} key={entry.id} />
      ))}
      <OriginalQuickSummary entry={blockedTask} />
      <OriginalWardenStrip />
    </>
  );
}

const documentFor = (css: string, body: string): string => `<!doctype html>
<html lang="en" data-theme="studio-dark">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${css}</style></head>
  <body><div id="root" class="p-panel">${body}</div></body>
</html>`;

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1_440, height: 900 },
] as const;

let workspace = '';
let browser: Browser | undefined;
let css = '';

const buildCss = (outFile: string): void => {
  const result = spawnSync(
    './node_modules/.bin/tailwindcss',
    [
      '--config',
      'tailwind.config.ts',
      '--input',
      'src/styles/index.css',
      '--output',
      outFile,
      '--content',
      './src/**/*.{ts,tsx},./tests/integration/features/*.tsx',
    ],
    { cwd: packageDir, stdio: 'pipe' },
  );
  if (result.status !== 0) throw new Error(`tailwind build failed: ${result.stderr?.toString() ?? ''}`);
};

describe('ported feature surfaces visual contract', () => {
  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'fy-visual-'));
    const outFile = join(workspace, 'app.css');
    buildCss(outFile);
    css = await readFile(outFile, 'utf8');
    const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
    should(chrome).be.type('string');
    browser = await chromium.launch({ executablePath: chrome as string, headless: true });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    if (workspace !== '') await rm(workspace, { recursive: true, force: true });
  });

  it('should render pixel-identically to the original kteam markup at both viewports', async () => {
    const target = documentFor(css, renderToStaticMarkup(<Port />));
    const reference = documentFor(css, renderToStaticMarkup(<Reference />));
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const body = new URL(request.url).pathname === '/reference' ? reference : target;
        return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      },
    });

    try {
      for (const viewport of VIEWPORTS) {
        const context = await (browser as Browser).newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: 'dark',
          reducedMotion: 'reduce',
        });
        // A public static bundle must never reach the network, and a live
        // daemon runs on the machine that executes this suite.
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) {
            await route.abort();
            return;
          }
          await route.continue();
        });
        const page = await context.newPage();

        await page.goto(new URL('/target', server.url).toString());
        const overflow = await page.evaluate<{ inner: number; scroll: number }>(
          `({ inner: window.innerWidth, scroll: document.documentElement.scrollWidth })`,
        );
        should(overflow.scroll).be.belowOrEqual(overflow.inner);
        const shot = await page.screenshot({ animations: 'disabled', fullPage: true });

        await page.goto(new URL('/reference', server.url).toString());
        const original = await page.screenshot({ animations: 'disabled', fullPage: true });

        should(shot.equals(original)).be.true();
        await context.close();
      }
    } finally {
      server.stop(true);
    }
  }, 120_000);
});
