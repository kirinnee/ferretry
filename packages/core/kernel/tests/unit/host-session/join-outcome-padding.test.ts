/**
 * R596, in the owner's suite: the KERNEL session layer pads every member join outcome (`padJoinOutcome`) with spaces to
 * exactly 24 KiB, so the size of the sealed answer says nothing about whether the join worked, and an outcome that cannot
 * be padded is never sent unpadded: the layer sends the (always paddable) generic refusal instead. Catalogs supplies the
 * outcome's content and proves the whole join through its member mode; this is the padding rule itself.
 *
 * The receiving half of the row ("a missing or non-space pad does not parse") is the app's `JoinPadSchema`, proved in
 * the app's wire tests; the daemon sends, it never parses an outcome.
 */
import { describe, expect, test } from 'bun:test';
import {
  MEMBER_JOIN_OUTCOME_BYTES,
  type JoinOutcomeContent,
  padJoinOutcome,
  SESSION_PROTOCOL_ID,
} from '../../../host/session/index.ts';

const bytes = (text: string): number => new TextEncoder().encode(text).length;

const OUTCOMES: readonly JoinOutcomeContent[] = [
  { t: 'joined', protocol: SESSION_PROTOCOL_ID, response: { catalogCount: 2 } },
  { t: 'join-refused', protocol: SESSION_PROTOCOL_ID, reason: 'join_refused' },
  { t: 'join-open', protocol: SESSION_PROTOCOL_ID, why: 'owner-approved' },
  { t: 'join-challenge', protocol: SESSION_PROTOCOL_ID, challenge: 'c'.repeat(43) },
];

describe('a member join outcome is padded to one size', () => {
  test('R596 both join outcomes, and the options answers, are padded with spaces to exactly 24 KiB', () => {
    expect(MEMBER_JOIN_OUTCOME_BYTES).toBe(24 * 1024);
    for (const outcome of OUTCOMES) {
      const text = padJoinOutcome(outcome);
      expect(text).not.toBeNull();
      expect(bytes(text ?? '')).toBe(MEMBER_JOIN_OUTCOME_BYTES);
      const parsed = JSON.parse(text ?? '') as Record<string, unknown>;
      expect(parsed.t).toBe(outcome.t);
      expect(parsed.pad).toMatch(/^ +$/u);
    }
  });

  test('R596 the padding counts bytes, not characters: a multi-byte value still lands on exactly 24 KiB', () => {
    const text = padJoinOutcome({ t: 'joined', protocol: SESSION_PROTOCOL_ID, response: { name: 'Café ☕ 日本語' } });
    expect(bytes(text ?? '')).toBe(MEMBER_JOIN_OUTCOME_BYTES);
  });

  test('R596 an outcome too large to pad, or that cannot be written, is null: it is never sent unpadded', () => {
    const tooBig = {
      t: 'joined',
      protocol: SESSION_PROTOCOL_ID,
      extra: 'x'.repeat(MEMBER_JOIN_OUTCOME_BYTES),
    } as const;
    expect(padJoinOutcome(tooBig)).toBeNull();
    const cyclic: Record<string, unknown> = { t: 'joined', protocol: SESSION_PROTOCOL_ID };
    cyclic.self = cyclic;
    expect(padJoinOutcome(cyclic as unknown as JoinOutcomeContent)).toBeNull();
  });

  test('R596 the generic refusal the layer falls back to always fits, so an unpaddable outcome becomes a padded refusal', () => {
    const refusal = padJoinOutcome({ t: 'join-refused', protocol: SESSION_PROTOCOL_ID, reason: 'join_refused' });
    expect(bytes(refusal ?? '')).toBe(MEMBER_JOIN_OUTCOME_BYTES);
    expect(JSON.parse(refusal ?? '')).toMatchObject({ t: 'join-refused', reason: 'join_refused' });
  });
});
