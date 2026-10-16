/**
 * Learning fixtures and an in-memory learning daemon for the PWA suites: every route the hub, the scan
 * dialog and Settings › Learning dial, answered from state a test can read and steer.
 */

import type {
  EvidenceView,
  LearningApplyPreview,
  LearningConfig,
  LearningScanEstimate,
  LearningScanProgress,
  ProposalView,
  SessionLearning,
} from '@ferretry/protocol';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';

export const learningDaemon = daemonConnection({
  daemonId: 'daemon/a',
  baseUrl: 'https://a.example.test',
  deviceId: 'token-a',
});

export const AT = '2026-10-16T09:40:00.000Z';

export const evidence = (overrides: Partial<EvidenceView> = {}): EvidenceView => ({
  observationId: 'o-1',
  sessionId: 'session-hadi',
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

export const config = (overrides: Partial<LearningConfig> = {}): LearningConfig => ({
  enabled: true,
  agent: 'claude-default',
  intervalMinutes: 60,
  batchSize: 10,
  maxMinersPerRun: 2,
  maxSessionsPerRun: 20,
  minSpawnGapMinutes: 5,
  passiveDefault: true,
  ...overrides,
});

export const estimate = (overrides: Partial<LearningScanEstimate> = {}): LearningScanEstimate => ({
  sessions: 2,
  sessionIds: ['session-hadi', 'session-kofi'],
  skipped: 0,
  tokens: 320_000,
  usd: 0.32,
  miners: 1,
  agent: 'claude-default',
  beyondLimit: 0,
  ...overrides,
});

export const progress = (overrides: Partial<LearningScanProgress> = {}): LearningScanProgress => ({
  runId: 'run-1',
  state: 'running',
  total: 4,
  done: 1,
  startedAt: AT,
  added: 0,
  merged: 0,
  ...overrides,
});

export const preview = (overrides: Partial<LearningApplyPreview> = {}): LearningApplyPreview => ({
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

interface LearningCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** What a test answers one call with: a body (200), or a status with an error document. */
type Answer = { readonly status: number; readonly body: unknown } | { readonly body: unknown };

export interface FakeLearningDaemon {
  readonly calls: LearningCall[];
  /** Answers the next call to `METHOD path` (exact pathname) once, ahead of the default. */
  readonly once: (key: string, answer: Answer | (() => Promise<Answer>)) => void;
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly state: {
    lessons: ProposalView[];
    scan: LearningScanProgress | undefined;
    sessions: SessionLearning[];
    config: LearningConfig;
    estimate: LearningScanEstimate;
  };
}

export const fakeLearningDaemon = (lessons: readonly ProposalView[] = [lesson()]): FakeLearningDaemon => {
  const calls: LearningCall[] = [];
  const queued = new Map<string, (Answer | (() => Promise<Answer>))[]>();
  const state: FakeLearningDaemon['state'] = {
    lessons: [...lessons],
    scan: undefined,
    sessions: [],
    config: config(),
    estimate: estimate(),
  };
  const respond = (answer: Answer): Response =>
    new Response(JSON.stringify(answer.body), { status: 'status' in answer ? answer.status : 200 });
  const fallback = (method: string, path: string, body: Record<string, unknown>): Answer => {
    if (path === '/v1/learning/proposals') return { body: state.lessons };
    if (path === '/v1/learning/config') {
      if (method === 'PATCH') state.config = { ...state.config, passiveDefault: body.passiveDefault === true };
      return { body: state.config };
    }
    if (path === '/v1/learning/sessions') return { body: state.sessions };
    if (path === '/v1/learning/scan/estimate') return { body: state.estimate };
    if (path === '/v1/learning/scan' && method === 'POST') {
      state.scan = progress();
      return { body: state.scan };
    }
    if (path === '/v1/learning/scan') return { body: state.scan === undefined ? {} : { scan: state.scan } };
    if (path === '/v1/learning/scan/cancel') {
      state.scan = progress({ state: 'cancelled', finishedAt: AT });
      return { body: state.scan };
    }
    const session = /^\/v1\/sessions\/([^/]+)\/learning$/u.exec(path);
    if (session?.[1] !== undefined) {
      const learning: SessionLearning = {
        sessionId: decodeURIComponent(session[1]),
        passive: body.passive === true,
        since: AT,
        setBy: 'owner',
      };
      state.sessions = [...state.sessions.filter(entry => entry.sessionId !== learning.sessionId), learning];
      return { body: { learning, reinstructed: true, sendId: 'send-1', note: 'Re-instructed; it costs one turn.' } };
    }
    const match = /^\/v1\/learning\/proposals\/([^/]+)(\/apply-preview|\/apply)?$/u.exec(path);
    const found = state.lessons.find(candidate => candidate.id === decodeURIComponent(match?.[1] ?? ''));
    if (match === null || found === undefined) return { status: 404, body: { error: 'no such lesson' } };
    if (match[2] === '/apply-preview') return { body: preview({ proposalId: found.id, path: found.target.path }) };
    const next: ProposalView =
      match[2] === '/apply'
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
  return {
    calls,
    state,
    once: (key, answer) => queued.set(key, [...(queued.get(key) ?? []), answer]),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      calls.push({ method, path: `${url.pathname}${url.search}`, body });
      const key = `${method} ${url.pathname}`;
      const next = queued.get(key)?.shift();
      if (next !== undefined) return respond(typeof next === 'function' ? await next() : next);
      return respond(fallback(method, url.pathname, body));
    },
  };
};
