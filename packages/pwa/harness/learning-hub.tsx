/**
 * The Learning hub, Settings › Learning and the passive chip against an in-page daemon, for review
 * captures (`?app-chrome=learning`, `?learning-settings`). Every learning route is answered here from
 * memory, so Accept, Apply and a scan can be driven by clicks and nothing leaves the page.
 */

import type {
  LearningApplyPreview,
  LearningScanProgress,
  ProposalView,
  SessionLearning,
  SessionView,
} from '@ferretry/protocol';
import { useMemo } from 'react';
import { LearningPage } from '../src/features/learning/learning-page.tsx';
import { LearningSettingsSurface } from '../src/features/learning/learning-settings.tsx';
import type { PickerAccount } from '../src/lib/account-picker-catalog.ts';
import type { DaemonConnection } from '../src/lib/daemon-connection.ts';
import type { DaemonFetch } from '../src/lib/runtime-models.ts';

const AT = '2026-10-16T09:40:00.000Z';

const evidence = (id: string, sessionId: string, quote: string, at: string, turn: number) => ({
  observationId: id,
  sessionId,
  repo: 'ferretry',
  at,
  quote,
  source: 'human' as const,
  kind: 'suggestion' as const,
  turn,
});

const lesson = (overrides: Partial<ProposalView> & Pick<ProposalView, 'id' | 'ruleText'>): ProposalView => ({
  category: 'repo',
  state: 'pending',
  title: overrides.ruleText,
  target: { kind: 'repo-instructions', path: '/work/ferretry/AGENTS.md' },
  observationIds: ['o-1'],
  occurrences: 1,
  crossRepoCount: 1,
  firstSeen: '2026-10-14T08:00:00.000Z',
  lastSeen: AT,
  identity: overrides.id,
  history: [{ at: AT, event: 'created', by: 'ferret' }],
  source: 'passive',
  project: '/work/ferretry',
  suggestedCategory: 'repo',
  count: 1,
  evidence: [evidence('o-1', 'harness-workspace', 'No — run the gate before you push, every time.', AT, 41)],
  ...overrides,
});

const LESSONS: readonly ProposalView[] = [
  lesson({
    id: 'gate-first',
    ruleText: 'Run `task test:gate` before pushing; a green suite is not a green gate.',
    count: 9,
    occurrences: 9,
    evidence: [
      evidence('o-1', 'harness-workspace', 'No — run the gate before you push, every time.', AT, 41),
      evidence('o-2', 'harness-jaylynn', 'The ledger failed again. Gate first.', '2026-10-15T16:12:00.000Z', 18),
    ],
  }),
  lesson({
    id: 'biome',
    category: 'global',
    suggestedCategory: 'global',
    source: 'scan',
    target: { kind: 'global-instructions', path: '~/.local/share/ferretry/fleet/components/global-instructions.md' },
    ruleText: 'Never run `biome check --write` on a whole directory in a shared worktree.',
    count: 2,
    occurrences: 2,
    evidence: [
      evidence(
        'o-3',
        'harness-kamila',
        'You just reformatted 140 files that other ferrets own. Undo that.',
        '2026-10-12T10:00:00.000Z',
        31,
      ),
    ],
  }),
  lesson({
    id: 'nix-fmt',
    ruleText: 'Use `nix fmt` before committing in home-manager.',
    project: '/work/home-manager',
    target: { kind: 'repo-instructions', path: '/work/home-manager/CLAUDE.md' },
    evidence: [evidence('o-4', 'harness-jaylynn', 'Format with nix fmt, not by hand.', '2026-10-16T08:10:00.000Z', 7)],
  }),
  lesson({
    id: 'tflock',
    state: 'accepted',
    ruleText: 'Release a stale Terraform state lock with `force-unlock` only after checking no apply is running.',
    project: '/work/acme-infra',
    target: { kind: 'repo-instructions', path: '/work/acme-infra/AGENTS.md' },
    source: 'scan',
    count: 2,
  }),
  lesson({
    id: 'bun',
    state: 'applied',
    category: 'global',
    target: { kind: 'global-instructions', path: '~/.local/share/ferretry/fleet/components/global-instructions.md' },
    ruleText: 'Prefer bun over python for scripts.',
    applied: {
      at: '2026-10-15T12:30:00.000Z',
      path: '~/.local/share/ferretry/fleet/components/global-instructions.md',
    },
    count: 4,
  }),
  lesson({ id: 'tabs', state: 'rejected', ruleText: 'Indent with tabs.', count: 1 }),
];

const PREVIEW = (proposal: ProposalView): LearningApplyPreview => ({
  proposalId: proposal.id,
  category: proposal.category,
  path: proposal.target.path,
  exists: true,
  etag: 'sha256:7f3a',
  diff: [
    `--- a/${proposal.target.path.split('/').at(-1)}`,
    `+++ b/${proposal.target.path.split('/').at(-1)}`,
    '@@ -18,5 +18,6 @@',
    ' # Agent guide',
    ' ',
    ' ## Lessons',
    ' - Use `nix fmt` before committing.',
    ' - Keep commits small and conventional.',
    `+- ${proposal.ruleText}`,
  ].join('\n'),
  capability: proposal.category === 'global' ? 'fleet' : 'filesystem',
  notes: proposal.category === 'repo' ? ['A paired phone confirms a repo write with its passkey.'] : [],
});

const LEARNING_SESSIONS: readonly SessionLearning[] = [
  { sessionId: 'harness-workspace', passive: true, since: AT, setBy: 'default' },
  { sessionId: 'harness-jaylynn', passive: true, since: AT, setBy: 'owner' },
  { sessionId: 'harness-kamila', passive: false, since: AT, setBy: 'default' },
  { sessionId: 'harness-marin', passive: false, since: AT, setBy: 'default' },
];

export const LEARNING_PASSIVE: ReadonlySet<string> = new Set(
  LEARNING_SESSIONS.filter(entry => entry.passive).map(entry => entry.sessionId),
);

const ACCOUNTS: readonly PickerAccount[] = [
  {
    id: 'claude-default',
    wrapper: 'claude-default',
    displayName: 'claude-default',
    kind: 'claude',
    agent: true,
    credentialId: 'claude-default',
    defaultModel: 'claude-haiku-5-5',
    models: [
      { id: 'claude-haiku-5-5', available: true },
      { id: 'claude-sonnet-5-5', available: true },
    ],
    available: true,
    unavailableReason: null,
  },
];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** One in-memory daemon per mount. `scanRunning` starts a scan that sits at 3 of 7. */
const harnessLearningFetch = (scanRunning: boolean): DaemonFetch => {
  let lessons = [...LESSONS];
  let scan: LearningScanProgress | undefined = scanRunning
    ? { runId: 'run-1', state: 'running', total: 7, done: 3, startedAt: AT, added: 0, merged: 0 }
    : undefined;
  let passiveDefault = true;
  let sessions = [...LEARNING_SESSIONS];
  return async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (path === '/v1/learning/proposals') return json(lessons);
    if (path === '/v1/learning/config') {
      if (method === 'PATCH') passiveDefault = body.passiveDefault === true;
      return json({
        enabled: true,
        agent: 'claude-default',
        intervalMinutes: 60,
        batchSize: 10,
        maxMinersPerRun: 2,
        maxSessionsPerRun: 20,
        minSpawnGapMinutes: 5,
        passiveDefault,
      });
    }
    if (path === '/v1/learning/sessions') return json(sessions);
    if (path === '/v1/learning/scan/estimate')
      return json({
        sessions: 7,
        sessionIds: ['harness-kamila', 'harness-marin', 's-3', 's-4', 's-5', 's-6', 's-7'],
        skipped: 1,
        tokens: 1_120_000,
        usd: 1.12,
        miners: 2,
        agent: 'claude-default',
        model: 'claude-haiku-5-5',
        beyondLimit: 0,
      });
    if (path === '/v1/learning/scan') {
      if (method === 'POST') {
        scan = { runId: 'run-2', state: 'running', total: 7, done: 3, startedAt: AT, added: 0, merged: 0 };
        return json(scan);
      }
      return json(scan === undefined ? {} : { scan });
    }
    if (path === '/v1/learning/scan/cancel') {
      scan = scan === undefined ? undefined : { ...scan, state: 'cancelled', finishedAt: AT };
      return json(scan);
    }
    const sessionPatch = /^\/v1\/sessions\/([^/]+)\/learning$/u.exec(path);
    if (sessionPatch?.[1] !== undefined) {
      const sessionId = decodeURIComponent(sessionPatch[1]);
      const learning: SessionLearning = { sessionId, passive: body.passive === true, since: AT, setBy: 'owner' };
      sessions = [...sessions.filter(entry => entry.sessionId !== sessionId), learning];
      return json({
        learning,
        reinstructed: true,
        sendId: 'send-1',
        note: 'Re-instructed: a queued message, no interrupt. It costs this ferret one turn.',
      });
    }
    const proposal = /^\/v1\/learning\/proposals\/([^/]+)(\/apply-preview|\/apply)?$/u.exec(path);
    const found = lessons.find(candidate => candidate.id === decodeURIComponent(proposal?.[1] ?? ''));
    if (proposal === null || found === undefined) return json({ error: 'not found' }, 404);
    if (proposal[2] === '/apply-preview') return json(PREVIEW(found));
    const next: ProposalView =
      proposal[2] === '/apply'
        ? { ...found, state: 'applied', applied: { at: AT, path: found.target.path } }
        : body.action === 'accept'
          ? { ...found, state: 'accepted' }
          : body.action === 'reject'
            ? { ...found, state: 'rejected' }
            : body.action === 'reopen'
              ? { ...found, state: 'pending' }
              : body.action === 'categorize'
                ? { ...found, category: body.category === 'global' ? 'global' : 'repo' }
                : { ...found, ruleText: String(body.ruleText ?? found.ruleText) };
    lessons = lessons.map(candidate => (candidate.id === next.id ? next : candidate));
    return json(next);
  };
};

export function LearningHubHarness({
  connection,
  sessions,
  scanRunning,
}: {
  readonly connection: DaemonConnection;
  readonly sessions: readonly SessionView[];
  readonly scanRunning: boolean;
}) {
  const fetcher = useMemo(() => harnessLearningFetch(scanRunning), [scanRunning]);
  return (
    <LearningPage
      connection={connection}
      sessions={sessions}
      projects={[
        { name: 'ferretry', path: '/work/ferretry' },
        { name: 'home-manager', path: '/work/home-manager' },
      ]}
      accounts={ACCOUNTS}
      fetcher={fetcher}
      timeZone="UTC"
      now={() => Date.parse(AT)}
      estimateDelayMs={50}
    />
  );
}

export function LearningSettingsHarness({
  connection,
  sessions,
}: {
  readonly connection: DaemonConnection;
  readonly sessions: readonly SessionView[];
}) {
  const fetcher = useMemo(() => harnessLearningFetch(false), []);
  return <LearningSettingsSurface connection={connection} sessions={sessions} fetcher={fetcher} />;
}
