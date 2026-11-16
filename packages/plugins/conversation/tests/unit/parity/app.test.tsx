/**
 * Parity rows S-* that Conversation owns (docs/design/rebuild-parity.tsv). Conversation's app half is a skeleton listed
 * in ports-pending.json `pendingHalves` (design D2 #4): every row waits on that port. The voice and warden settings rows
 * are their plugins' own screens.
 */
import { describe, test } from 'bun:test';

describe('the app surfaces Conversation owns', () => {
  test.skip('S-0191 S-0192 S-0193 S-0194 S-0352 S-0378 S-0403 the queue page, its rows and route — pending port: Conversation app half', () => {});
  test.skip('S-0319 the queue-view feature — pending port: Conversation app half', () => {});
  test.skip('S-0332 the stuck-messages feature — pending port: Conversation app half', () => {});
  test.skip('S-0394 the imported-history screen, now links — pending port: Conversation app half', () => {});
  test.skip('S-0531 the All queues palette destination — pending port: Conversation app half', () => {});
  test.skip('S-0509 the message-marks setting — pending port: Conversation app half', () => {});
  test.skip('S-0272 the transcription log setting — pending port: Conversation app half', () => {});
  test.skip('S-0475 S-0498 voice chat reading every message or the last of a turn — not Conversation’s: voice', () => {});
  test.skip('S-0530 the warden setting for a question asked — not Conversation’s: warden', () => {});
});
