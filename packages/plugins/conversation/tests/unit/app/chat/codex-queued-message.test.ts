import { describe, expect, test } from 'bun:test';
import { renderTranscript } from '../../../../daemon/reader/lib/reads.ts';
import type { TranscriptEvent } from '../../../../daemon/reader/lib/transcript/types.ts';
import { transcriptEntriesFromLog } from '../../../../app/chat/chat-refresh.ts';
import { CODEX_QUEUED_EVENTS, CODEX_QUEUED_LOG, OWNER_BODY, TORREY_BODY } from '../../../support/codex-queued-log.ts';

/**
 * codex-protocol-send: a message handed to Codex through `codex queue` is an ordinary user turn in the rollout, so the
 * chat must draw it as a NORMAL message row with its sender — the ferret for an agent send (the banner is parsed off),
 * the owner for an owner send — never a system or hook blob. Fake data only.
 */
describe('a Codex-queued message in the chat', () => {
  test('the reader renders the parser’s user events as the log the chat reads', () => {
    expect(renderTranscript(CODEX_QUEUED_EVENTS as readonly TranscriptEvent[])).toBe(CODEX_QUEUED_LOG);
  });

  const entries = transcriptEntriesFromLog(CODEX_QUEUED_LOG, Date.parse('2026-11-16T10:05:00.000Z'));

  test('an agent send is a normal user row attributed to the ferret, its banner taken off', () => {
    const row = entries[0];
    expect(row).toMatchObject({ kind: 'user', text: TORREY_BODY });
    expect(row?.peer).toMatchObject({ name: 'torrey', sessionId: 'mvtorre1-a41c8b02', kind: 'message' });
    expect(row?.text).not.toContain('not from the owner');
  });

  test('an owner send is a normal user row with no sender chip (the owner)', () => {
    const row = entries[2];
    expect(row).toMatchObject({ kind: 'user', text: OWNER_BODY });
    expect(row?.peer).toBeUndefined();
  });

  test('neither is a system row, and the assistant replies stay assistant rows', () => {
    expect(entries.map(entry => entry.kind)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });
});
