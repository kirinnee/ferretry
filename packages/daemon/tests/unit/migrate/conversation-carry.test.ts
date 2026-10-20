import { describe, it } from 'bun:test';
import type { TranscriptProvenance } from '@ferretry/protocol';
import should from 'should';
import {
  type ConversationCarryRequest,
  planConversationCarry,
  previousConversation,
} from '../../../src/lib/migrate/conversation-carry.ts';

const CWD = '/work/repo';
const ID = 'cc4c82a7-0000-4000-8000-000000000001';
const CLAUDE: TranscriptProvenance = {
  v: 1,
  home: '/homes/origin',
  harnessSessionId: ID,
  identity: 'minted',
  file: `/homes/origin/projects/-work-repo/${ID}.jsonl`,
  resolvedAt: '2026-10-20T06:00:00.000Z',
};
const CODEX: TranscriptProvenance = {
  v: 1,
  home: '/homes/codex-a',
  harnessSessionId: ID,
  identity: 'correlated',
  baseline: ['older'],
  correlationToken: '/state/sessions/s1',
  file: `/homes/codex-a/sessions/2026/10/20/rollout-${ID}.jsonl`,
  resolvedAt: '2026-10-20T06:00:00.000Z',
};

const request = (overrides: Partial<ConversationCarryRequest>): ConversationCarryRequest => ({
  harness: 'claude',
  source: CLAUDE,
  sourceWritten: true,
  targetHome: '/homes/origin',
  targetAgent: 'claude-target',
  cwd: CWD,
  ...overrides,
});

describe('planConversationCarry', () => {
  it('should resume the same conversation in place on a Restart, copying nothing', () => {
    // Act
    const carry = planConversationCarry(request({}));

    // Assert
    should(carry).deepEqual({ kind: 'carry', provenance: CLAUDE });
  });

  it('should copy a Claude conversation into another login at the path that login resumes it from', () => {
    // Act
    const carry = planConversationCarry(request({ targetHome: '/homes/target' }));

    // Assert
    const to = `/homes/target/projects/-work-repo/${ID}.jsonl`;
    should(carry).deepEqual({
      kind: 'carry',
      provenance: { ...CLAUDE, home: '/homes/target', file: to },
      copy: { from: CLAUDE.file, to },
    });
  });

  it('should keep the id of a Claude conversation the harness never wrote, with nothing to copy', () => {
    // Act
    const carry = planConversationCarry(request({ targetHome: '/homes/target', sourceWritten: false }));

    // Assert
    should(carry).match({ kind: 'carry', provenance: { harnessSessionId: ID, home: '/homes/target' } });
    should(carry).not.have.property('copy');
  });

  it('should carry a Codex rollout to the same place under the target home', () => {
    // Act
    const carry = planConversationCarry(request({ harness: 'codex', source: CODEX, targetHome: '/homes/codex-b' }));

    // Assert
    const to = `/homes/codex-b/sessions/2026/10/20/rollout-${ID}.jsonl`;
    should(carry).deepEqual({
      kind: 'carry',
      provenance: { ...CODEX, home: '/homes/codex-b', file: to },
      copy: { from: CODEX.file, to },
    });
  });

  it('should refuse, naming Start fresh, whenever the conversation cannot go with the session', () => {
    // Arrange
    const refusals = [
      request({ source: undefined }),
      request({ source: { v: 1, home: '/homes/codex-a', identity: 'undiscovered', baseline: [] }, harness: 'codex' }),
      request({ targetHome: undefined }),
      request({ harness: 'codex', source: { ...CODEX, file: '/elsewhere/rollout.jsonl' } }),
      request({ harness: 'codex', source: { ...CODEX, file: CODEX.home } }),
      request({ harness: 'codex', source: CODEX, targetHome: '/homes/codex-a', sourceWritten: false }),
    ];

    // Act
    const answers = refusals.map(planConversationCarry);

    // Assert
    should(answers.map(answer => answer.kind)).deepEqual(Array(refusals.length).fill('unresumable'));
    for (const answer of answers) should(answer).have.property('reason').containEql('Start fresh');
    should(answers[0]).have.property('reason').containEql('no recorded conversation');
    should(answers[1]).have.property('reason').containEql("hasn't matched");
    should(answers[2]).have.property('reason').containEql('claude-target');
    should(answers[3]).have.property('reason').containEql("isn't inside its login's home");
    should(answers[5]).have.property('reason').containEql('is gone');
  });
});

describe('previousConversation', () => {
  const candidate = (id: string, modifiedMs: number, mentionsSession: boolean) => ({
    id,
    file: `/homes/origin/projects/-work-repo/${id}.jsonl`,
    modifiedMs,
    mentionsSession,
  });

  it('should rebind to the newest OTHER conversation that names the session, never the current one', () => {
    // Arrange: the broken state — bound to NEW, the real conversation older beside it, a stranger newest.
    const current: TranscriptProvenance = { ...CLAUDE, harnessSessionId: 'new', file: '/x/new.jsonl' };

    // Act
    const carry = previousConversation({
      harness: 'claude',
      current,
      home: '/homes/origin',
      candidates: [
        candidate('new', 30, true),
        candidate('real', 10, true),
        candidate('older', 5, true),
        candidate('stranger', 40, false),
      ],
      at: '2026-10-20T07:00:00.000Z',
    });

    // Assert
    should(carry).deepEqual({
      kind: 'carry',
      provenance: {
        v: 1,
        home: '/homes/origin',
        harnessSessionId: 'real',
        identity: 'minted',
        file: '/homes/origin/projects/-work-repo/real.jsonl',
        resolvedAt: '2026-10-20T07:00:00.000Z',
      },
    });
  });

  it('should adopt a Codex thread and keep the evidence the current record holds', () => {
    // Act
    const kept = previousConversation({
      harness: 'codex',
      current: { ...CODEX, harnessSessionId: 'new' },
      home: '/homes/codex-a',
      candidates: [candidate('real', 10, true)],
      at: '2026-10-20T07:00:00.000Z',
    });
    const bare = previousConversation({
      harness: 'codex',
      current: { v: 1, home: '/homes/codex-a', identity: 'minted', harnessSessionId: 'new', file: '/x' },
      home: '/homes/codex-a',
      candidates: [candidate('real', 10, true)],
      at: '2026-10-20T07:00:00.000Z',
    });

    // Assert
    should(kept).match({
      kind: 'carry',
      provenance: {
        identity: 'adopted',
        harnessSessionId: 'real',
        baseline: ['older'],
        correlationToken: '/state/sessions/s1',
      },
    });
    should((bare as { provenance: object }).provenance).not.have.properties('baseline', 'correlationToken');
  });

  it('should refuse when no earlier conversation names the session', () => {
    // Act
    const carry = previousConversation({
      harness: 'claude',
      current: undefined,
      home: '/homes/origin',
      candidates: [candidate('stranger', 40, false)],
      at: '2026-10-20T07:00:00.000Z',
    });

    // Assert
    should(carry).have.property('kind', 'unresumable');
    should(carry).have.property('reason').containEql('earlier conversation');
  });
});
