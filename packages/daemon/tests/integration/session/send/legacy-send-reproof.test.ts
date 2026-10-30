import { afterEach, describe, it } from 'bun:test';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileSendLedger, FileSendReproofMarker } from '../../../../src/adapters/index.ts';
import { NodeTranscriptSource } from '../../../../src/adapters/transcript/index.ts';
import {
  ClaudeTranscriptParser,
  type ClockPort,
  parseSessionId,
  type SerialExecutor,
  SessionTranscriptReader,
} from '../../../../src/lib/index.ts';
import { LegacySendReproof, TranscriptSendEvidence } from '../../../../src/lib/session/send/index.ts';

/**
 * The old "not delivered" rows, re-proved through the REAL chain: the file ledger the daemon writes, the
 * Claude transcript source and parser it mounts, and the incremental evidence reader the tracker uses —
 * over a transcript far larger than one look reads, so the proof only arrives after many looks.
 *
 * The lost message is the shape Claude Code 2.1.281 recorded on 2026-10-30: a paste wrapped in
 * `<pasted_content>`, its one real image path lifted out as an attachment with `[Image #7]` in front.
 */

const LEAD = parseSessionId('mvgt2oz9-04e28935');
const SENT_AT = '2026-10-30T08:56:48.962Z';
const NOW = '2026-10-30T21:00:00.000Z';
const SHOT = '/tmp/claude-1000/mobile-inbox-after-390-neo-dark-end.png';

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map(async home => await rm(home, { recursive: true, force: true })));
});

const inline: SerialExecutor = { run: async (_key, work) => await work(), runExclusive: async work => await work() };
const clock: ClockPort = { now: () => NOW };

const typed = [
  '[message from ferret kenton (session mvuq4mdo-e8151ebb) — not from the owner]',
  'No reply needed. To reply: fy send kenton "<reply>"',
  '',
  'Bug B23 fix is up: https://github.com/kirinnee/ferretry/pull/967',
  '',
  '  before: /tmp/claude-1000/mobile-inbox-before-<390|412>-<theme>-<top|end>.png',
  `Example: ${SHOT}`,
].join('\n');

/** The record Claude wrote for it: wrapped, re-wrapped, and the real image lifted out in front. */
const lifted = [
  '[Image #7]',
  '',
  '<pasted_content id="703a">',
  typed.replace(`Example: ${SHOT}`, 'Example:').replace('  before: /tmp/', '  before:\n/tmp/'),
  '</pasted_content id="703a">',
].join('\n');

const at = (offsetMs: number): string => new Date(Date.parse(SENT_AT) + offsetMs).toISOString();

const user = (uuid: string, timestamp: string, content: unknown) =>
  `${JSON.stringify({ type: 'user', uuid, timestamp, sessionId: 'claude', message: { role: 'user', content } })}\n`;

const assistant = (uuid: string, timestamp: string, text: string) =>
  `${JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp,
    sessionId: 'claude',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })}\n`;

/** A legacy row exactly as the old tracker left one: typed four times, then called absent. */
const legacyRow = (sendId: string, message: string) =>
  `${JSON.stringify({
    sendId,
    path: 'native-inline',
    message,
    matchText: message,
    acceptedAt: SENT_AT,
    acceptedTurn: 594,
    fate: 'timed_out',
    attempt: 4,
    attemptAt: at(373_000),
    senderKind: 'agent',
    from: 'mvuq4mdo-e8151ebb',
    fromName: 'kenton',
    at: at(375_000),
    fateAt: at(375_000),
    unaccountedReason: 'not_delivered',
    retryable: true,
  })}\n`;

async function world() {
  const home = await mkdtemp(join(tmpdir(), 'fy-send-reproof-'));
  homes.push(home);
  const sessionDirectory = join(home, 'sessions', LEAD);
  await mkdir(join(sessionDirectory, 'channel'), { recursive: true });
  const transcript = join(home, 'transcript.jsonl');
  // A 64 KiB step, so one look reads 4 MiB: the file below takes many looks, as a real 400 MB one does.
  const source = new NodeTranscriptSource(new ClaudeTranscriptParser(), undefined, undefined, {
    maxReadBytes: 64 * 1024,
  });
  const reader = new SessionTranscriptReader([source], {
    file: async sessionId => (sessionId === LEAD ? transcript : undefined),
  });
  const ledger = new FileSendLedger(() => sessionDirectory, clock);
  const marker = join(home, 'send-reproof-migration.json');
  const journal: { event: string; data: Readonly<Record<string, unknown>> }[] = [];
  let looks = 0;
  const reproof = new LegacySendReproof({
    ledger,
    evidence: new TranscriptSendEvidence(async sessionId => ({ sessionId, harness: 'claude' }), reader),
    repository: { journal: async (_id, event, data) => void journal.push({ event, data }) },
    roster: { sessions: () => [LEAD] },
    serial: inline,
    clock,
    marker: new FileSendReproofMarker(marker),
    pause: async () => {
      looks += 1;
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    },
  });
  return { sessionDirectory, transcript, ledger, marker, journal, reproof, looks: () => looks };
}

describe('re-proving the old "not delivered" rows against a giant transcript', () => {
  it('should find the lost message deep in it, call the one nobody received unconfirmed, and run once', async () => {
    // Arrange — two legacy rows; ~30 MB of conversation, with the lost message near its end.
    const { sessionDirectory, transcript, ledger, marker, journal, reproof, looks } = await world();
    await writeFile(
      join(sessionDirectory, 'channel', 'sends.jsonl'),
      legacyRow('lost', typed) + legacyRow('absent', 'a message that truly never arrived anywhere'),
    );
    const padding = 'x'.repeat(600);
    const chunk: string[] = [];
    for (let index = 0; index < 40_000; index += 1) {
      chunk.push(user(`u${index}`, at(index * 100), `an unrelated message number ${index}`));
      chunk.push(assistant(`a${index}`, at(index * 100 + 50), `working on it ${index} ${padding}`));
      if (index === 38_000)
        chunk.push(
          user('the-record', at(index * 100 + 60), [
            { type: 'text', text: lifted },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
          ]),
        );
      if (chunk.length >= 2_000) await appendFile(transcript, chunk.splice(0).join(''));
    }
    await appendFile(transcript, chunk.join(''));

    // Act
    const counts = await reproof.run();
    const again = await reproof.run();

    // Assert — the lost one is delivered, read across many looks; the other is unconfirmed, never red.
    const rows = await ledger.list(LEAD);
    should(rows.find(row => row.sendId === 'lost')).match({
      fate: 'delivered',
      evidence: { proof: 'normal-user-record' },
    });
    should(rows.find(row => row.sendId === 'absent')).match({
      fate: 'unaccounted',
      unaccountedReason: 'landing_unconfirmed',
    });
    should(rows.some(row => row.fate === 'timed_out')).be.false();
    should(looks()).be.above(1);
    should(counts).eql({ sessions: 1, delivered: 1, unconfirmed: 1, unreadable: 0 });
    should(journal.map(entry => entry.event).sort()).eql(['control.send_delivered', 'control.send_unaccounted']);
    should(JSON.parse(await readFile(marker, 'utf8'))).match({ v: 1, ranAt: NOW, delivered: 1, unconfirmed: 1 });
    should(again).be.undefined();
  }, 120_000);
});
