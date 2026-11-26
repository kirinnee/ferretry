import { describe, expect, it } from 'bun:test';
import { UnsupportedHarnessFamilyError } from '@ferretry/core-ferrets/contract';
import {
  byHarnessFamily,
  harnessFamily,
  handoffReadArguments,
  judgeWatchedSends,
  parseSessionId,
  TranscriptRetractionProof,
} from '../../../contract/index.ts';
import type { LedgerRecord as SendRecord, ObservedHumanInput } from '../../../contract/index.ts';
import { at } from '../../support/instant.ts';

/**
 * The closed-harness sweep of the mailbox (runtimes plan U4b part 3b): a harness the family table has no row for
 * (`fake-third`) is neither Claude nor Codex in the send policy, the handoff arguments, the evidence kind and the retraction
 * proof. Each assertion was a quiet Claude (or Codex) answer before the sweep. Fixture values only.
 */
const THIRD = 'fake-third';
const POINTER = 'FIXTURE read turn-001.md';
const KEY = 'aeeeefa4-973d-452a-aff6-c7cde97456e8';

const record = (patch: Partial<SendRecord> = {}): SendRecord => ({
  sendId: 'send-1',
  acceptedAt: at('2026-11-06T08:23:30.000Z'),
  acceptedTurn: 1,
  path: 'direct',
  message: POINTER,
  matchText: POINTER,
  fate: 'accepted',
  attempt: 1,
  attemptAt: at('2026-11-06T08:23:30.000Z'),
  ...patch,
});

const inputOf = (harness: string): ObservedHumanInput => ({
  harness,
  text: POINTER,
  proof: 'normal-user-record',
  observedAt: at('2026-11-06T08:23:31.000Z'),
  proofKey: KEY,
  shapeVersion: 1,
});

describe('a harness the mailbox has no family for', () => {
  it('is no family in the send policy, and a case written out for it runs, never Claude or Codex', () => {
    expect(harnessFamily(THIRD)).toBeUndefined();
    expect(harnessFamily('claude-code')).toBe('claude');
    expect(harnessFamily('codex')).toBe('codex');
    const cases = { claude: () => 'c', codex: () => 'x', unknown: () => 'none' };
    expect(byHarnessFamily(THIRD, cases)).toBe('none');
    expect(byHarnessFamily(undefined, cases)).toBe('none');
    expect(byHarnessFamily('claude-code', cases)).toBe('c');
    expect(byHarnessFamily('codex', cases)).toBe('x');
  });

  it('is refused by name where the handoff arguments would have been "not Claude, so none"', () => {
    expect(() => handoffReadArguments(THIRD, ['work/a'])).toThrow(UnsupportedHarnessFamilyError);
    expect(() => handoffReadArguments(THIRD, ['work/a'])).toThrow(THIRD);
    expect(handoffReadArguments('claude-code', ['work/a'])).toEqual(['--allowedTools=Read(/work/a/**)']);
    expect(handoffReadArguments('codex', ['work/a'])).toEqual([]);
  });

  it('proves no send by an input of its own: the send is not called delivered on a Claude guess', () => {
    const verdicts = judgeWatchedSends([record()], new Set(), [inputOf(THIRD)], 5_000);

    expect(verdicts.get('send-1')?.delivered).toBeUndefined();
    // The shipped two keep their evidence kinds.
    expect(judgeWatchedSends([record()], new Set(), [inputOf('claude')], 5_000).get('send-1')?.delivered?.kind).toBe(
      'chat.user',
    );
    expect(judgeWatchedSends([record()], new Set(), [inputOf('codex')], 5_000).get('send-1')?.delivered?.kind).toBe(
      'response_item',
    );
  });

  it('is not retracted on a parentUuid chain it does not have', async () => {
    const tail = async () => `{"parentUuid":"x","type":"user","uuid":"${KEY}"}`;
    const proof = new TranscriptRetractionProof({ tail });
    const delivered = (harness: string): SendRecord =>
      record({
        fate: 'delivered',
        evidence: {
          key: KEY,
          harness,
          kind: 'chat.user',
          proof: 'normal-user-record',
          observedAt: at('2026-11-06T08:23:31.000Z'),
          shapeVersion: 1,
          matchedTurn: 1,
          tier: 'exact-text',
        },
      });
    const id = parseSessionId('mw4m80sx-5624d777');

    expect(await proof.unanswered(id, delivered(THIRD))).toBe(false);
    expect(await proof.unanswered(id, delivered('claude'))).toBe(true);
  });
});
