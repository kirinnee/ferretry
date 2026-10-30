import { describe, expect, test } from 'bun:test';
import {
  subFerretEffort,
  subFerretLive,
  subFerretModel,
  subFerretName,
  subFerretState,
  subFerretSummary,
  subFerretsOf,
} from '../../src/lib/sub-ferret-state.ts';
import { type SessionFixtureOverrides, sessionView } from '../support/sessions.ts';

const child = (
  id: string,
  state: SessionFixtureOverrides['state'] = {},
  config: SessionFixtureOverrides['config'] = {},
) => sessionView(id, { config: { parent: 'lead', ...config }, state });

describe('subFerretState', () => {
  test('reads every daemon status as one of the parent reader’s words, with the reason when there is one', () => {
    const cases: Array<[Parameters<typeof child>[1], string, string | undefined]> = [
      [{ status: 'created' }, 'Starting', undefined],
      [{ status: 'starting' }, 'Starting', undefined],
      [{ status: 'running' }, 'Working', undefined],
      [{ status: 'tool_running' }, 'Working', undefined],
      [{ status: 'rate_limited' }, 'Working', 'rate limited'],
      [{ status: 'running', turnState: 'your-turn' }, 'At its prompt', undefined],
      [{ status: 'awaiting_user' }, 'Needs you', undefined],
      [
        { status: 'running', turnState: 'needs-input', turnPrompt: 'Trust this folder?' },
        'Needs you',
        'Trust this folder?',
      ],
      [{ status: 'running', needsHuman: 'Which branch?' }, 'Needs you', 'Which branch?'],
      [
        { status: 'running', pendingQuestion: { toolUseId: 't', questions: [{ question: 'q' }] } },
        'Needs you',
        undefined,
      ],
      [{ status: 'completed' }, 'Done', undefined],
      [{ status: 'stopped', reason: 'its result was collected' }, 'Done', undefined],
      [{ status: 'stopped', reason: 'stopped by the operator' }, 'Stopped', 'stopped by the operator'],
      [{ status: 'stopped' }, 'Stopped', undefined],
      [{ status: 'failed', reason: '  out of quota  ' }, 'Failed', 'out of quota'],
      [{ status: 'stalled', reason: ' ' }, 'Failed', undefined],
    ];
    for (const [state, word, reason] of cases) {
      const reading = subFerretState(child('c', state));
      expect([reading.word, reading.reason]).toEqual([word, reason]);
    }
  });

  test('only the finished states are not live', () => {
    expect(subFerretLive(subFerretState(child('c', { status: 'running' })))).toBe(true);
    expect(subFerretLive(subFerretState(child('c', { status: 'awaiting_user' })))).toBe(true);
    for (const status of ['completed', 'failed', 'stopped'] as const)
      expect(subFerretLive(subFerretState(child('c', { status })))).toBe(false);
  });
});

describe('a sub-ferret as the parent lists it', () => {
  test('is named by callsign, task or short id, and shows its observed model and effort first', () => {
    expect(subFerretName(child('c', {}, { teammate: 'nadia' }))).toBe('Nadia');
    expect(subFerretName(child('c', {}, { label: 'Review it' }))).toBe('Session c');
    expect(subFerretName(child('c'))).toBe('Session c');
    expect(subFerretName(child('mvabcdefghij', {}, { name: '' }))).toBe('mvabcdef…');
    expect(subFerretModel(child('c', { observedModel: 'opus[1m]' }, { model: 'opus' }))).toBe('opus[1m]');
    expect(subFerretModel(child('c', {}, { model: 'opus' }))).toBe('opus');
    expect(subFerretEffort(child('c', { observedReasoningEffort: 'max' }, { launchReasoningEffort: 'high' }))).toBe(
      'max',
    );
    expect(subFerretEffort(child('c', {}, { launchReasoningEffort: 'high' }))).toBe('high');
  });

  test('a parent’s sub-ferrets are its children, newest first, and never itself', () => {
    const sessions = [
      sessionView('lead', { config: { parent: 'lead' } }),
      child('old', {}, { createdAt: '2026-10-20T00:00:00.000Z' }),
      child('new', {}, { createdAt: '2026-10-20T01:00:00.000Z' }),
      sessionView('other', { config: { parent: 'someone' } }),
    ];
    expect(subFerretsOf('lead', sessions).map(view => view.config.id)).toEqual(['new', 'old']);
  });

  test('the summary counts the total, then only what wants attention or is still running', () => {
    expect(subFerretSummary([child('a')])).toBe('1 sub-ferret · 1 running');
    expect(
      subFerretSummary([
        child('a'),
        child('b', { status: 'starting' }),
        child('c', { status: 'awaiting_user' }),
        child('d', { status: 'failed' }),
        child('e', { status: 'completed' }),
      ]),
    ).toBe('5 sub-ferrets · 1 needs you · 2 running · 1 failed');
    expect(subFerretSummary([child('e', { status: 'completed' }), child('f', { status: 'completed' })])).toBe(
      '2 sub-ferrets',
    );
  });
});
