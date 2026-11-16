/**
 * A MESSAGE HANDED IN BY THE STOP HOOK IS A NORMAL MESSAGE ROW FROM THE FERRET THAT SENT IT — not a "Stop hook feedback"
 * blob. Fake data only: the very record Claude Code 2.1.317 wrote for a hook delivery (measured), walked through the real
 * Claude transcript parser, the daemon's log rendering, the app's log reader and the real `Transcript`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ReferenceSurfaceProvider } from '@ferretry/app';
import { interact, type Mounted, mount } from '@ferretry/app/testing';
import { peerEnvelopePreamble } from '../../../../contract/index.ts';
import { OWNER_NUDGE_TEXT } from '../../../../daemon/delivery/lib/rewake.ts';
import { transcriptEntriesFromLog } from '../../../../app/chat/chat-refresh.ts';
import { chatReferenceSurface } from '../../../../app/chat/reference-surface.ts';
import { Transcript } from '../../../../app/chat/transcript.tsx';
import { ClaudeTranscriptParser } from '../../../../daemon/reader/lib/transcript/claude.ts';
import { renderTranscript } from '../../../../daemon/reader/lib/reads.ts';

const NOW = Date.UTC(2026, 10, 16, 9, 0, 30);

/** The wrapper the harness records around what the Stop hook's listener printed. */
const wrapped = (text: string): string =>
  `<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "Stop": ${text}\n\n</system-reminder>`;

const BANNER = peerEnvelopePreamble({
  name: 'avary',
  sessionId: 'mvavary1-a41c8b02',
  kind: 'message',
  label: 'action',
  clientName: 'fy',
});
const PEER = `${BANNER}Please look at the failing build and tell me what you find.`;
const NOTICE = OWNER_NUDGE_TEXT;

/** The conversation, read the way the app reads it: parser → the daemon's log text → the app's rows. */
const rowsOf = (...records: readonly { readonly text: string; readonly at: string }[]) => {
  const jsonl = records
    .map((record, index) =>
      JSON.stringify({
        type: 'user',
        uuid: `u-${index}`,
        timestamp: record.at,
        origin: { kind: 'task-notification' },
        isMeta: true,
        message: { role: 'user', content: record.text },
      }),
    )
    .join('\n');
  const parsed = new ClaudeTranscriptParser().parse({ text: `${jsonl}\n` });
  return transcriptEntriesFromLog(renderTranscript(parsed.events), NOW);
};

const surface = chatReferenceSurface({ daemonId: 'd', ferretId: 's' });
const mounted: Mounted[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
});

describe('a hook-delivered message in the chat', () => {
  test('is a user row attributed to the sending ferret, with its message and none of the hook’s wrapping', () => {
    const [entry, ...rest] = rowsOf({ text: wrapped(PEER), at: '2026-11-16T09:00:10.000Z' });

    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      kind: 'user',
      peer: { name: 'avary', sessionId: 'mvavary1-a41c8b02', kind: 'message' },
    });
    expect(entry?.text).toBe('Please look at the failing build and tell me what you find.');
    expect(JSON.stringify(entry)).not.toContain('Stop hook');
  });

  test('draws as a normal message from the ferret, never as a “Stop hook feedback” blob', async () => {
    const entries = rowsOf({ text: wrapped(PEER), at: '2026-11-16T09:00:10.000Z' });
    const view = await mount(
      <ReferenceSurfaceProvider surface={surface}>
        <Transcript daemonId="d" entries={entries} sessionId="s" />
      </ReferenceSurfaceProvider>,
    );
    mounted.push(view);
    await interact(async () => undefined);

    const shown = view.container.textContent ?? '';
    expect(shown).toContain('Please look at the failing build and tell me what you find.');
    expect(shown.toLowerCase()).toContain('avary');
    expect(shown).not.toContain('Stop hook');
    expect(shown).not.toContain('task-notification');
    expect(shown).not.toContain('system-reminder');
    expect(view.container.querySelector('.fy-message-peer[data-peer="avary"]')).not.toBeNull();
  });

  test('the owner-waiting nudge is a Ferretry notice row, never an owner message', () => {
    const [entry] = rowsOf({ text: wrapped(NOTICE), at: '2026-11-16T09:00:20.000Z' });

    // A Ferretry NOTICE row (the tag is how the app knows it, and is taken off for the reader), never a user message.
    expect(entry).toMatchObject({
      kind: 'system',
      text: '[delivery] A message from the owner is waiting to be typed into your input box. Finish briefly and end your turn.',
    });
    expect(entry).not.toHaveProperty('peer');
  });

  test('another tool’s Stop-hook feedback stays as it is shown today: the harness’s own, nobody’s message', () => {
    const feedback = wrapped('lint failed: 3 errors in src/index.ts');
    const [entry] = rowsOf({ text: feedback, at: '2026-11-16T09:00:30.000Z' });

    expect(entry).not.toHaveProperty('peer');
    // Shown as the harness's own event, exactly as before this change: nothing of it was re-attributed.
    expect(entry).toMatchObject({ kind: 'system', text: 'Stop hook feedback' });
  });
});
