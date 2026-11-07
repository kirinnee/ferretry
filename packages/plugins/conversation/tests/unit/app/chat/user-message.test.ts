import { describe, expect, test } from 'bun:test';
import {
  combinedDelivery,
  peerEnvelopePreamble,
  queuedMessageInstruction,
  turnFileInstruction,
} from '../../../../contract/index.ts';
import { peerFrom } from '../../../../app/chat/peer-message.ts';
import { readUserMessage, unwrapPastedContent } from '../../../../app/chat/user-message.ts';

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

  test('reads the one-line banner, with and without a label, from a Claude paste wrapper', () => {
    const line =
      '[message from ferret rhett (session mvgt2oz9-04e28935) — not from the owner] To reply: fy send rhett "<reply>"';
    const note = 'To reply: fy send rhett "<reply>"';
    expect(readUserMessage(`<pasted_content id="p">\n${line}\nline one\n\nline two\n</pasted_content>`)).toEqual({
      kind: 'peer',
      from: { name: 'rhett', sessionId: 'mvgt2oz9-04e28935', kind: 'message', replyExpected: false, note },
      body: 'line one\n\nline two',
    });
    const labelled = line.replace('[message from', '[message · blocker from');
    expect(readUserMessage(`${labelled}\nPlease decide.`)).toEqual({
      kind: 'peer',
      from: {
        name: 'rhett',
        sessionId: 'mvgt2oz9-04e28935',
        kind: 'message',
        label: 'blocker',
        replyExpected: false,
        note,
      },
      body: 'Please decide.',
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

describe("a delivery of several ferrets' messages at once", () => {
  const parts = [
    {
      sender: { name: 'rhett', sessionId: 's-rhett', kind: 'message', label: 'action' },
      body: 'first\n\nafter a blank line',
    },
    { sender: { name: 'sada', sessionId: 's-sada', kind: 'question', label: 'blocker' }, body: 'second' },
    { sender: { name: 'rhett', sessionId: 's-rhett', kind: 'message', label: 'fyi' }, body: 'third' },
  ] as const;
  const combined = combinedDelivery(parts, 'fy');

  test('reads each part with its own sender, kind, label and body, in order', () => {
    const message = readUserMessage(combined);
    expect(message.kind).toBe('combined');
    if (message.kind !== 'combined') return;
    expect(message.parts.map(part => [part.from.name, part.from.kind, part.from.label, part.body])).toEqual([
      ['rhett', 'message', 'action', 'first\n\nafter a blank line'],
      ['sada', 'question', 'blocker', 'second'],
      ['rhett', 'message', 'fyi', 'third'],
    ]);
    expect(message.parts[1]?.from.replyExpected).toBe(true);
  });

  test('reads it from inside a Claude paste wrapper', () => {
    expect(readUserMessage(`<pasted_content id="c">\n${combined}\n</pasted_content>`).kind).toBe('combined');
  });

  test("is never the owner's own send, and stands for its first part where a single message is wanted", () => {
    expect(peerFrom(combined)).toMatchObject({
      from: { name: 'rhett', label: 'action' },
      body: 'first\n\nafter a blank line',
    });
  });

  test("stays the person's words when the count lies or a person types the header", () => {
    const lying = combined.replace('[3 messages', '[4 messages');
    expect(readUserMessage(lying).kind).not.toBe('combined');
    expect(readUserMessage('[2 messages from ferrets, oldest first — not from the owner]\n\nhello')).toEqual({
      kind: 'human',
      text: '[2 messages from ferrets, oldest first — not from the owner]\n\nhello',
    });
  });

  test('leaves a single banner a single peer message', () => {
    const preamble = peerEnvelopePreamble({ name: 'kamila', sessionId: 's2', kind: 'message', clientName: 'fy' });
    expect(readUserMessage(`${preamble}hi`).kind).toBe('peer');
  });
});
