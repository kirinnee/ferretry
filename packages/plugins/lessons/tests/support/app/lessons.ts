/**
 * Lessons fixtures and an in-memory Lessons daemon for the app suites: every route the screen, the scan dialog,
 * the toolbar panel and the Settings tab call, answered from state a test can read and steer. It stands behind a
 * `PluginClient`, so the suites exercise the same `client.call(route, init)` the generated client gives a half.
 */

import { DaemonCallError } from '@ferretry/app';
import { GLOBAL_LESSONS_DOCUMENT } from '../../../contract/index.ts';
import type {
  EvidenceView,
  FerretLessons,
  LessonsApplyPreview,
  LessonsConfig,
  LessonsFerret,
  LessonsScanEstimate,
  LessonsScanProgress,
  ProposalView,
} from '../../../contract/index.ts';
import type { LessonsConnection } from '../../../app/src/api.ts';

export const AT = '2026-10-16T09:40:00.000Z';

export const evidence = (overrides: Partial<EvidenceView> = {}): EvidenceView => ({
  observationId: 'o-1',
  ferretId: 'ferret-hadi',
  repo: 'ferretry',
  at: AT,
  quote: 'Run the gate first.',
  source: 'human',
  kind: 'suggestion',
  turn: 41,
  ...overrides,
});

export const lesson = (overrides: Partial<ProposalView> = {}): ProposalView => ({
  id: 'lesson-a',
  category: 'repo',
  state: 'pending',
  title: 'Gate first',
  ruleText: 'Run the gate before pushing.',
  target: { kind: 'repo-instructions', path: '/work/ferretry/AGENTS.md' },
  observationIds: ['o-1'],
  occurrences: 1,
  crossRepoCount: 1,
  firstSeen: AT,
  lastSeen: AT,
  identity: 'gate-first',
  history: [{ at: AT, event: 'created', by: 'ferret' }],
  source: 'passive',
  project: '/work/ferretry',
  suggestedCategory: 'repo',
  count: 1,
  evidence: [evidence()],
  ...overrides,
});

export const config = (overrides: Partial<LessonsConfig> = {}): LessonsConfig => ({
  enabled: true,
  agent: 'claude-default',
  intervalMinutes: 60,
  batchSize: 10,
  maxMinersPerRun: 2,
  maxFerretsPerRun: 20,
  minSpawnGapMinutes: 5,
  passiveDefault: true,
  ...overrides,
});

export const estimate = (overrides: Partial<LessonsScanEstimate> = {}): LessonsScanEstimate => ({
  ferrets: 2,
  ferretIds: ['ferret-hadi', 'ferret-kofi'],
  skipped: 0,
  tokens: 320_000,
  usd: 0.32,
  miners: 1,
  agent: 'claude-default',
  beyondLimit: 0,
  ...overrides,
});

export const progress = (overrides: Partial<LessonsScanProgress> = {}): LessonsScanProgress => ({
  runId: 'run-1',
  state: 'running',
  total: 4,
  done: 1,
  startedAt: AT,
  added: 0,
  merged: 0,
  ...overrides,
});

export const preview = (overrides: Partial<LessonsApplyPreview> = {}): LessonsApplyPreview => ({
  proposalId: 'lesson-a',
  category: 'repo',
  path: '/work/ferretry/AGENTS.md',
  exists: true,
  etag: 'etag-1',
  diff: '--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1,2 +1,3 @@\n # Agent guide\n-old line\n+- Run the gate before pushing.\n\n',
  capability: 'filesystem',
  notes: [],
  ...overrides,
});

export const directory: readonly LessonsFerret[] = [
  { ferretId: 'ferret-hadi', name: 'hadi', folder: '/work/ferretry' },
  { ferretId: 'ferret-kofi', name: 'kofi', folder: '/work/other' },
];

interface LessonsCall {
  readonly route: string;
  readonly params: Readonly<Record<string, string>> | undefined;
  readonly query: Readonly<Record<string, string>> | undefined;
  readonly body: unknown;
}

/** What a test answers one call with: a body (200), or a refusal with a status and code. */
type Answer =
  | { readonly refuse: { readonly status: number; readonly code: string; readonly message: string } }
  | { readonly body: unknown };

export interface FakeLessonsDaemon {
  readonly connection: LessonsConnection;
  readonly calls: LessonsCall[];
  /** Answers the next call to `route` once, ahead of the default. */
  readonly once: (route: string, answer: Answer | (() => Promise<Answer>)) => void;
  readonly state: {
    lessons: ProposalView[];
    scan: LessonsScanProgress | undefined;
    ferrets: FerretLessons[];
    config: LessonsConfig;
    estimate: LessonsScanEstimate;
    directory: readonly LessonsFerret[];
    global: { text: string; etag: string };
  };
}

let machines = 0;

export const fakeLessonsDaemon = (lessons: readonly ProposalView[] = [lesson()]): FakeLessonsDaemon => {
  machines += 1;
  const calls: LessonsCall[] = [];
  const queued = new Map<string, (Answer | (() => Promise<Answer>))[]>();
  const state: FakeLessonsDaemon['state'] = {
    lessons: [...lessons],
    scan: undefined,
    ferrets: [],
    config: config(),
    estimate: estimate(),
    global: { text: '', etag: 'absent' },
    directory,
  };
  const fallback = (route: string, params: Record<string, string>, body: Record<string, unknown>): Answer => {
    switch (route) {
      case 'GET /v1/lessons/proposals':
        return { body: state.lessons };
      case 'GET /v1/lessons/config':
        return { body: state.config };
      case 'PATCH /v1/lessons/config':
        state.config = { ...state.config, passiveDefault: body.passiveDefault === true };
        return { body: state.config };
      case 'GET /v1/lessons/global':
        return { body: { name: GLOBAL_LESSONS_DOCUMENT, ...state.global, notes: [] } };
      case 'PUT /v1/lessons/global': {
        if (body.etag !== state.global.etag)
          return { refuse: { status: 409, code: 'apply_conflict', message: 'the Global lessons document changed' } };
        state.global = { text: String(body.text ?? ''), etag: `etag-${String(calls.length)}` };
        return { body: { name: GLOBAL_LESSONS_DOCUMENT, ...state.global, notes: [] } };
      }
      case 'GET /v1/lessons/ferrets':
        return { body: state.ferrets };
      case 'GET /v1/lessons/directory':
        return { body: state.directory };
      case 'POST /v1/lessons/scan/estimate':
        return { body: state.estimate };
      case 'POST /v1/lessons/scan':
        state.scan = progress();
        return { body: state.scan };
      case 'GET /v1/lessons/scan':
        return { body: state.scan === undefined ? {} : { scan: state.scan } };
      case 'POST /v1/lessons/scan/cancel':
        state.scan = progress({ state: 'cancelled', finishedAt: AT });
        return { body: state.scan };
      case 'PATCH /v1/ferrets/:ferretId/lessons': {
        const entry: FerretLessons = {
          ferretId: params.ferretId ?? '',
          passive: body.passive === true,
          since: AT,
          setBy: 'owner',
        };
        state.ferrets = [...state.ferrets.filter(existing => existing.ferretId !== entry.ferretId), entry];
        return {
          body: { lessons: entry, reinstructed: true, sendId: 'send-1', note: 'Re-instructed; it costs one turn.' },
        };
      }
      default:
    }
    const found = state.lessons.find(candidate => candidate.id === params.id);
    if (found === undefined) return { refuse: { status: 404, code: 'not_found', message: 'no such lesson' } };
    if (route === 'GET /v1/lessons/proposals/:id/apply-preview')
      return { body: preview({ proposalId: found.id, path: found.target.path }) };
    const next: ProposalView =
      route === 'POST /v1/lessons/proposals/:id/apply'
        ? { ...found, state: 'applied', applied: { at: AT, path: found.target.path } }
        : body.action === 'accept'
          ? { ...found, state: 'accepted' }
          : body.action === 'reject'
            ? { ...found, state: 'rejected' }
            : body.action === 'reopen'
              ? { ...found, state: 'pending' }
              : body.action === 'categorize'
                ? { ...found, category: body.category === 'global' ? 'global' : 'repo' }
                : { ...found, ruleText: String(body.ruleText) };
    state.lessons = state.lessons.map(candidate => (candidate.id === next.id ? next : candidate));
    return { body: next };
  };
  const client: LessonsConnection['client'] = {
    call: async <Value>(
      route: string,
      init: {
        readonly params?: Readonly<Record<string, string>>;
        readonly query?: Readonly<Record<string, string>>;
        readonly body?: unknown;
      } = {},
    ): Promise<Value> => {
      calls.push({ route, params: init.params, query: init.query, body: init.body });
      const queuedAnswer = queued.get(route)?.shift();
      const answer =
        queuedAnswer !== undefined
          ? typeof queuedAnswer === 'function'
            ? await queuedAnswer()
            : queuedAnswer
          : fallback(route, { ...init.params }, (init.body ?? {}) as Record<string, unknown>);
      if ('refuse' in answer)
        throw new DaemonCallError(answer.refuse.status, answer.refuse.code, answer.refuse.message);
      return answer.body as Value;
    },
  };
  return {
    connection: { key: `daemon/${machines}`, client },
    calls,
    state,
    once: (route, answer) => queued.set(route, [...(queued.get(route) ?? []), answer]),
  };
};
