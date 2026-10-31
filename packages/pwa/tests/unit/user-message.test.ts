import { describe, expect, test } from 'bun:test';
import { peerEnvelopePreamble, queuedMessageInstruction, turnFileInstruction } from '@ferretry/protocol';
import { peerFrom } from '../../src/lib/peer-message.ts';
import { readUserMessage, unwrapPastedContent } from '../../src/lib/user-message.ts';

/** The record Aniya's transcript held, verbatim from the owner's report. */
const OWNER_SAMPLE = [
  '<pasted_content id="1fd4">',
  '[peer message from teammate torrey (session mvb0sw7d-27f71326) — not from the human lead]',
  'No reply is required; torrey has carried on. Reply with `fy send torrey "…"` if useful.',
  '',
  "Hey! How's your day going?",
  '</pasted_content id="1fd4">',
].join('\n');

describe('unwrapPastedContent', () => {
  test('takes the paste markup off and keeps exactly what was pasted', () => {
    expect(unwrapPastedContent('<pasted_content id="a1">\nline one\nline two\n</pasted_content>')).toBe(
      'line one\nline two',
    );
  });

  test('unwraps every block, keeping typed text around them, and a closing tag with attributes', () => {
    expect(
      unwrapPastedContent(
        'see <pasted_content id="a">first</pasted_content> and <pasted_content>$1 second</pasted_content id="b">',
      ),
    ).toBe('see first and $1 second');
  });

  test('leaves text with no paste alone', () => {
    expect(unwrapPastedContent('just typed <b>text</b>')).toBe('just typed <b>text</b>');
  });
});

describe('readUserMessage', () => {
  test("reads the owner's wrapped peer message as a message FROM torrey", () => {
    expect(readUserMessage(OWNER_SAMPLE)).toEqual({
      kind: 'peer',
      from: {
        name: 'torrey',
        sessionId: 'mvb0sw7d-27f71326',
        kind: 'message',
        replyExpected: false,
        note: 'No reply is required; torrey has carried on. Reply with `fy send torrey "…"` if useful.',
      },
      body: "Hey! How's your day going?",
    });
  });

  test("reads whatever the daemon's own writer produces, parked or not", () => {
    const preamble = peerEnvelopePreamble({ name: 'kamila', sessionId: 's2', kind: 'question', clientName: 'fy' });
    const message = readUserMessage(`<pasted_content id="x">\n${preamble}Is CI green?\n</pasted_content>`);
    expect(message).toMatchObject({
      kind: 'peer',
      from: { name: 'kamila', kind: 'question', replyExpected: true },
      body: 'Is CI green?',
    });
  });

  test('reads a Codex record, which carries the banner bare, the same way', () => {
    const preamble = peerEnvelopePreamble({
      name: 'tomi',
      sessionId: 'mveq0r0r-ddd75d7b',
      kind: 'reply',
      clientName: 'fy',
    });
    expect(readUserMessage(`${preamble}Hello from home-manager-fd.`)).toEqual({
      kind: 'peer',
      from: {
        name: 'tomi',
        sessionId: 'mveq0r0r-ddd75d7b',
        kind: 'reply',
        replyExpected: false,
        note: 'To reply: fy send tomi "<reply>"',
      },
      body: 'Hello from home-manager-fd.',
    });
  });

  test('reads the banner an older daemon wrote, "No reply needed" and all, the same way', () => {
    // Transcripts recorded before the rewording keep the old second line.
    const older =
      '[reply from ferret tomi (session mveq0r0r-ddd75d7b) — not from the owner]\n' +
      'No reply needed. To reply: fy send tomi "<reply>"\n\n';
    expect(readUserMessage(`${older}Hello from home-manager-fd.`)).toEqual({
      kind: 'peer',
      from: {
        name: 'tomi',
        sessionId: 'mveq0r0r-ddd75d7b',
        kind: 'reply',
        replyExpected: false,
        note: 'No reply needed. To reply: fy send tomi "<reply>"',
      },
      body: 'Hello from home-manager-fd.',
    });
  });

  test("reads Ferretry's own notice as a notice, wrapped or bare", () => {
    const notice = '[ferretry] Your message to aniya (send s-1) did not reach it.';
    expect(readUserMessage(notice)).toEqual({
      kind: 'notice',
      text: 'Your message to aniya (send s-1) did not reach it.',
    });
    expect(readUserMessage(`<pasted_content id="n">\n${notice}\n</pasted_content>`)).toMatchObject({ kind: 'notice' });
  });

  test("reads Ferretry's own turn pointer as a hand-off, never as the person's words", () => {
    const pointer = turnFileInstruction('/home/kirin/.ferretry/state/sessions/s1/turns/turn-008.md');
    expect(readUserMessage(pointer)).toEqual({
      kind: 'handoff',
      pointer: {
        kind: 'turn',
        name: 'turn-008',
        turn: 8,
        path: '/home/kirin/.ferretry/state/sessions/s1/turns/turn-008.md',
      },
      text: pointer,
    });
    const queued = queuedMessageInstruction('/fy/state/sessions/s1/channel/queued-send-1.md');
    expect(readUserMessage(`<pasted_content id="q">\n${queued}\n</pasted_content>`)).toMatchObject({
      kind: 'handoff',
      pointer: { kind: 'queued', sendId: 'send-1' },
    });
    expect(readUserMessage(`is this legit? ${pointer}`)).toMatchObject({ kind: 'human' });
  });

  test("reads anything else as the person's own words, with a paste unwrapped", () => {
    expect(readUserMessage('<pasted_content id="p">\nmy long\npaste\n</pasted_content>')).toEqual({
      kind: 'human',
      text: 'my long\npaste',
    });
    expect(readUserMessage('[peer message from someone] not a banner')).toEqual({
      kind: 'human',
      text: '[peer message from someone] not a banner',
    });
  });
});

describe('peerFrom', () => {
  test('recognises a peer message inside a paste block', () => {
    expect(peerFrom(OWNER_SAMPLE)).toMatchObject({ from: { name: 'torrey' }, body: "Hey! How's your day going?" });
  });

  test("returns a person's paste unwrapped, so it matches what they sent", () => {
    expect(peerFrom('<pasted_content id="p">\nlong\ntext\n</pasted_content>')).toEqual({
      from: null,
      body: 'long\ntext',
    });
  });
});
