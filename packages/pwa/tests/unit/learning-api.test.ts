import { describe, expect, it } from 'bun:test';
import type { LearningStatus, ProposalView } from '@ferretry/protocol';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import {
  actOnLearningProposal,
  fetchLearningPatch,
  fetchLearningProposals,
  fetchLearningStatus,
  runLearningScan,
} from '../../src/lib/learning-api.ts';

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'token-a' });
const status = {
  enabled: true,
  intervalMinutes: 10,
  lastRunAt: '2026-07-31T12:00:00.000Z',
  pending: { total: 1, strong: 1, weak: 0 },
  totals: { observations: 2, proposals: 1, tombstones: 0 },
  running: false,
} satisfies LearningStatus;
const proposal = {
  id: 'proposal/a',
  category: 'global',
  state: 'pending',
  title: 'Use the paired daemon',
  ruleText: 'Always pair first.',
  target: { kind: 'global-agent-guidance', path: 'AGENTS.md' },
  observationIds: ['o1'],
  occurrences: 5,
  crossRepoCount: 1,
  firstSeen: '2026-07-30T12:00:00.000Z',
  lastSeen: '2026-07-31T12:00:00.000Z',
  identity: 'paired-daemon',
  history: [{ at: '2026-07-31T12:00:00.000Z', event: 'created', by: 'miner' }],
  evidence: [
    {
      observationId: 'o1',
      sessionId: 'session/a',
      repo: 'ferretry',
      at: '2026-07-31T12:00:00.000Z',
      quote: 'pair it',
      source: 'human',
      kind: 'correction',
    },
  ],
} satisfies ProposalView;
const manifest = {
  runId: 'run-a',
  startedAt: '2026-07-31T12:00:00.000Z',
  sessionsScanned: 1,
  sessionsWithSignal: 1,
  minerSessions: [],
  observationsProposed: 1,
  observationsVerified: 1,
  rejectedQuotes: 0,
  malformedFiles: 0,
  proposalsCreated: 1,
  proposalsStrengthened: 0,
  proposalsSuppressedByTombstone: 0,
  perHarness: { claude: 0, codex: 1 },
};
const response = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code });

describe('learning transport', () => {
  it('uses the paired daemon for every learning endpoint and validates responses', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return response(
        [status, [proposal], proposal, { path: 'AGENTS.md', contents: 'rule' }, manifest][calls.length - 1],
      );
    };
    expect(await fetchLearningStatus(daemon, fetcher)).toEqual(status);
    expect(await fetchLearningProposals(daemon, 'pending', fetcher)).toEqual([proposal]);
    expect(await actOnLearningProposal(daemon, 'proposal/a', { action: 'edit', ruleText: 'better' }, fetcher)).toEqual(
      proposal,
    );
    expect(await fetchLearningPatch(daemon, 'proposal/a', fetcher)).toEqual({ path: 'AGENTS.md', contents: 'rule' });
    expect(await runLearningScan(daemon, true, fetcher)).toEqual(manifest);
    expect(calls.map(call => call.url)).toEqual([
      'https://a.example.test/v1/learning/status',
      'https://a.example.test/v1/learning/proposals?state=pending',
      'https://a.example.test/v1/learning/proposals/proposal%2Fa',
      'https://a.example.test/v1/learning/proposals/proposal%2Fa/patch',
      'https://a.example.test/v1/learning/run',
    ]);
    expect(new Headers(calls[2]?.init?.headers).get('authorization')).toBe('Bearer token-a');
    expect(JSON.parse(String(calls[4]?.init?.body))).toEqual({ spawn: true });
  });

  it('retains daemon errors and refuses malformed views', async () => {
    await expect(
      fetchLearningStatus(daemon, async () => response({ error: 'offline', code: 'gone' }, 503)),
    ).rejects.toMatchObject({ status: 503, code: 'gone' });
    await expect(fetchLearningProposals(daemon, undefined, async () => response([{ nope: true }]))).rejects.toThrow();
  });
});

export { proposal, status };
