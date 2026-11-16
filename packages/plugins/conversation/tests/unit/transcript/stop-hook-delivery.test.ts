import { describe, it } from 'bun:test';
import should from 'should';
import {
  combinedDelivery,
  ferretryNotice,
  peerEnvelopePreamble,
  unwrapStopHookDelivery,
} from '../../../contract/index.ts';
import { ClaudeTranscriptParser } from '../../../daemon/reader/lib/transcript/claude.ts';

/**
 * A message Ferretry handed to an idle Claude Code agent through the Stop hook's listener, as Claude Code 2.1.317 RECORDS
 * it (measured): a `user` entry whose text is a hook-feedback wrapper around what the listener printed.
 */
const wrapped = (text: string): string =>
  `<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "Stop": ${text}\n\n</system-reminder>`;

const BANNER = peerEnvelopePreamble({
  name: 'avary',
  sessionId: 'mvavary1-a41c8b02',
  kind: 'message',
  label: 'action',
  clientName: 'fy',
});
const PEER = `${BANNER}Please look at the failing build.`;
const NOTICE = ferretryNotice(
  '[delivery] A message from the owner is waiting to be typed into your input box. Finish briefly and end your turn.',
);

const line = (text: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'user',
    uuid: 'wake-1',
    timestamp: '2026-11-16T09:00:05.000Z',
    message: { role: 'user', content: text },
    ...extra,
  });

describe('unwrapStopHookDelivery', () => {
  it('unwraps a ferret’s message, a combined delivery and a Ferretry notice, trailing blank lines gone', () => {
    should(unwrapStopHookDelivery(wrapped(PEER))).equal(PEER);
    const combined = combinedDelivery(
      [
        { sender: { name: 'avary', sessionId: 's1', kind: 'message' }, body: 'one' },
        { sender: { name: 'bram', sessionId: 's2', kind: 'message' }, body: 'two' },
      ],
      'fy',
    );
    should(unwrapStopHookDelivery(wrapped(combined))).equal(combined);
    should(unwrapStopHookDelivery(wrapped(NOTICE))).equal(NOTICE);
  });

  it('tolerates the harness’s own “not user input” line before the wrapper', () => {
    should(
      unwrapStopHookDelivery(
        `[SYSTEM NOTIFICATION - NOT USER INPUT] This is NOT a message from the user.\n${wrapped(PEER)}`,
      ),
    ).equal(PEER);
  });

  it('leaves every other Stop-hook feedback, and any text that is no Stop-hook delivery, alone', () => {
    should(unwrapStopHookDelivery(wrapped('lint failed: 3 errors in src/index.ts'))).be.null();
    should(unwrapStopHookDelivery(wrapped('[ferretry-ish] not our tag'))).be.null();
    should(unwrapStopHookDelivery(PEER)).be.null();
    should(unwrapStopHookDelivery(wrapped(''))).be.null();
    // A banner in the MIDDLE of other feedback is a quote, not a delivery.
    should(unwrapStopHookDelivery(wrapped(`my hook says:\n${PEER}`))).be.null();
  });
});

describe('Claude’s transcript reads a hook delivery', () => {
  it('shows the unwrapped text as a normal user message, not the harness’s own feedback', () => {
    const parsed = new ClaudeTranscriptParser().parse({
      text: `${line(wrapped(PEER), { origin: { kind: 'task-notification' }, isMeta: true })}\n`,
    });

    should(parsed.events).have.length(1);
    const [event] = parsed.events;
    should(event).containDeep({ kind: 'message', role: 'user', text: PEER });
    // Not marked as written by the harness: the chat shows the ferret that sent it as a normal message.
    should((event as { inputSource?: string }).inputSource).be.undefined();
  });

  it('proves the delivery by the text it carried (the tracker looks for the message, not the wrapper)', () => {
    const parsed = new ClaudeTranscriptParser().parse({ text: `${line(wrapped(PEER))}\n` });

    should(parsed.observedInputs.map(input => input.text)).deepEqual([PEER]);
    should(parsed.observedInputs[0]).containDeep({ proof: 'normal-user-record' });
  });

  it('leaves any other Stop-hook feedback exactly as the harness wrote it, still the harness’s own', () => {
    const feedback = wrapped('lint failed: 3 errors in src/index.ts');
    const parsed = new ClaudeTranscriptParser().parse({
      text: `${line(feedback, { origin: { kind: 'task-notification' }, isMeta: true })}\n`,
    });

    should(parsed.events).have.length(1);
    should(parsed.events[0]).containDeep({ kind: 'message', role: 'user', text: feedback, inputSource: 'harness' });
  });

  it('reads the owner-waiting notice as a Ferretry notice text, never as a message of the owner', () => {
    const parsed = new ClaudeTranscriptParser().parse({ text: `${line(wrapped(NOTICE))}\n` });

    should(parsed.events[0]).containDeep({ kind: 'message', role: 'user', text: NOTICE });
    should(NOTICE).not.containEql('SECRET');
  });
});
