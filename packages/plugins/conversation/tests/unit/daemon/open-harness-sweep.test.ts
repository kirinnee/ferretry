import { describe, expect, it } from 'bun:test';
import { UnsupportedHarnessFamilyError, type TranscriptEntry } from '@ferretry/core-ferrets/contract';
import type { Instant } from '@ferretry/std';
import { describeConversation } from '../../../daemon/links/lib/conversation-describer.ts';
import { transcriptNames } from '../../../daemon/links/lib/conversation-name.ts';
import { EntriesSendEvidence } from '../../../daemon/delivery/adapters/entries-send-evidence.ts';
import { inputObserverFor } from '../../../daemon/reader/adapters/input-proof.ts';

/**
 * The closed-harness sweep of Conversation's daemon (runtimes plan U4b part 3b): a transcript tagged with a harness the
 * family table has no row for (`fake-third`) is never read with Claude's or Codex's rules. Each assertion was a quiet
 * Claude (or Codex) answer before the sweep. Fixture values only.
 */
const THIRD = 'fake-third';
const lines = (...records: unknown[]): string => records.map(record => JSON.stringify(record)).join('\n');
const CLAUDE_TITLED = lines(
  { type: 'custom-title', customTitle: 'FIXTURE mine' },
  { type: 'ai-title', aiTitle: 'FIXTURE gen' },
);

describe('a transcript of a harness the daemon has no family for', () => {
  it('names nothing by Claude’s title records (the shipped two still do)', () => {
    expect(transcriptNames(THIRD, CLAUDE_TITLED)).toEqual({});
    expect(transcriptNames('claude', CLAUDE_TITLED)).toEqual({ chosen: 'FIXTURE mine', generated: 'FIXTURE gen' });
  });

  it('describes no conversation from a Claude-shaped head', () => {
    const text = lines({ type: 'user', cwd: '/work/fixture', message: { role: 'user', content: 'hi' } });
    expect(describeConversation({ harness: THIRD, nameId: 'fixture-id' }, text, [], 0)).toBeUndefined();
  });

  it('has no input observer: it throws by name instead of handing back Codex’s', () => {
    expect(() => inputObserverFor(THIRD)).toThrow(UnsupportedHarnessFamilyError);
    expect(() => inputObserverFor(THIRD)).toThrow(THIRD);
    expect(inputObserverFor('claude').harness).toBe('claude');
    expect(inputObserverFor('codex').harness).toBe('codex');
  });

  it('proves no send: the tracker’s evidence reads it as unreadable, never as Codex', async () => {
    const entries: TranscriptEntry[] = [
      { id: 'u1', role: 'user', text: 'FIXTURE the send', at: '2026-11-09T10:00:30.000Z' as Instant },
    ];
    const evidence = new EntriesSendEvidence(async () => ({
      harness: THIRD,
      reader: { read: async () => entries },
    }));

    expect(await evidence.read('f1', '2026-11-09T10:00:00.000Z')).toEqual({ readable: false, inputs: [] });
  });
});
