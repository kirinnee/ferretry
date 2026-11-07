import { describe, expect, it } from 'bun:test';

import type { AgendaItem } from '../../../../app/wire/index.ts';

import {
  agendaAge,
  agendaKindMeta,
  agendaReference,
  collapsesByDefault,
  describeResponse,
  resolutionBadge,
} from '../../../../app/features/agenda/agenda-board.tsx';

describe('AgendaBoard', () => {
  it('describes the answer each kind of ask needs, and fails closed on a kind it does not know', () => {
    const meta = (ask: unknown, source: AgendaItem['source'] = 'agent-raised') =>
      agendaKindMeta({ source, ask } as Pick<AgendaItem, 'source' | 'ask'>);
    expect(meta(undefined, 'task')).toMatchObject({ tone: 'none', label: 'Blocked task' });
    expect(meta(undefined, 'question').label).toBe('Question');
    expect(meta(undefined).label).toBe('Agent request');
    expect(meta(undefined, 'future' as AgendaItem['source']).label).toBe('Unknown source');
    expect(meta({ kind: 'permission' }).action).toBe('Approve or reject');
    expect(meta({ kind: 'multiple-choice', options: [] }).action).toBe('Choose an answer');
    expect(meta({ kind: 'answer-review' }).action).toBe('Accept it, or ask for more');
    expect(meta({ kind: 'open-question' }).action).toBe('Write an answer');
    expect(meta({ kind: 'task' }).action).toBe('Do it, then mark it done — or ask for more info');
    expect(meta({ kind: 'future-kind' })).toMatchObject({
      tone: 'unknown',
      label: 'Damaged Inbox',
      action: 'The requested action is malformed. Repair it before treating this as resolved',
    });
  });

  it('distinguishes who dismissed an item from who answered or cleared it', () => {
    const agent = { resolvedBy: 'agent' as const, resolvedBySession: 'sess-agent-7' };
    const person = { resolvedBy: 'human' as const, resolvedBySession: null, resolvedByName: null };
    const daemon = { resolvedBy: 'daemon' as const, resolvedBySession: null, resolvedByName: null };
    expect(resolutionBadge({ ...agent, resolvedByName: 'zoe', disposition: 'dismissed' }).label).toBe(
      'dismissed by agent zoe',
    );
    expect(resolutionBadge({ ...agent, resolvedByName: null, disposition: 'done' }).label).toBe(
      'retracted by agent sess-agent-7',
    );
    expect(resolutionBadge({ ...person, disposition: 'dismissed' }).label).toBe('dismissed by you');
    expect(resolutionBadge({ ...person, disposition: 'done' }).label).toBe('done by you');
    expect(resolutionBadge({ ...daemon, disposition: 'dismissed' }).label).toBe('dismissed by the daemon');
    expect(resolutionBadge({ ...daemon, disposition: 'done' }).label).toBe('cleared by the daemon');
  });

  it('names the acting agent by its session when the ledger records no display name', () => {
    const agent = { resolvedBy: 'agent' as const, resolvedBySession: 'sess-agent-7' };
    // The real daemon leaves the name null far more often than the session, so a
    // session id — not a placeholder — is what the audit has to show.
    expect(resolutionBadge({ ...agent, resolvedByName: null, disposition: 'dismissed' }).label).toBe(
      'dismissed by agent sess-agent-7',
    );
    expect(resolutionBadge({ ...agent, resolvedByName: 'zoe', disposition: 'done' }).label).toBe(
      'retracted by agent zoe',
    );
    // A damaged record that names neither still has to read as an agent action.
    expect(
      resolutionBadge({ resolvedBy: 'agent', resolvedBySession: null, resolvedByName: null, disposition: 'done' })
        .label,
    ).toBe('retracted by agent an unidentified session');
  });

  it('separates an agent that answered for the human from one that retracted its own request', () => {
    const answered = resolutionBadge({
      resolvedBy: 'agent',
      resolvedBySession: 'sess-agent-7',
      resolvedByName: null,
      disposition: 'done',
      response: { kind: 'permission', decision: 'approve' },
    });
    expect(answered.label).toBe('answered by agent sess-agent-7');
    // Answering on the human's behalf is still agent provenance, so it keeps the warn treatment.
    expect(answered.className).toContain('text-warn');
    expect(
      resolutionBadge({
        resolvedBy: 'agent',
        resolvedBySession: 'sess-agent-7',
        resolvedByName: null,
        disposition: 'done',
      }).label,
    ).toBe('retracted by agent sess-agent-7');
  });
});

describe('attention helpers and transport', () => {
  it('uses explicit attention copy and never makes a long context open by default', () => {
    expect(agendaReference('A3')).toBe('!A3');
    expect(agendaAge('2026-07-31T11:30:00.000Z', Date.parse('2026-07-31T12:00:00.000Z'))).toBe('waiting 30m');
    expect(collapsesByDefault('x'.repeat(221))).toBe(true);
    expect(
      describeResponse({ kind: 'answer-review', verdict: 'clarify', clarification: 'Cite the source.' }),
    ).toContain('Cite the source.');
    expect(
      describeResponse({
        kind: 'form',
        answers: [
          { id: '1', picked: 'EU' },
          { id: '2', picked: ['Failures', 'Slow builds'] },
        ],
      }),
    ).toBe('Form answered: 1: EU · 2: Failures, Slow builds');
  });

  // The live-page cases that used to sit here went with `AgendaPage` and
  // `agenda-api.ts`. They asserted a SECOND transport for the same fact; the
  // one that remains is `lib/agenda-client.ts`, proved in
  // `tests/unit/agenda-client.test.ts` and driven for real by the focused
  // action modal. The board keeps what it actually is: a pure render.
});
