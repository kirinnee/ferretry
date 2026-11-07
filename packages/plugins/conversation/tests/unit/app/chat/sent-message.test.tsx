import { describe, expect, test } from 'bun:test';
import type { FerretView } from '@ferretry/core-ferrets/contract';
import { ReferenceSurfaceProvider } from '@ferretry/app';
import { TranscriptRow } from '../../../../app/chat/transcript-row.tsx';
import { fleetAgentResolver } from '../../../support/app/agents.ts';
import type { DaemonId } from '@ferretry/app';
import { readSentMessage, type SentMessage } from '../../../../app/chat/peer-delivery.ts';
import type { TranscriptEntry } from '../../../../app/chat/transcript-entries.ts';
import { interact, mount, must } from '@ferretry/app/testing';

const sentRow = (
  sent: Partial<SentMessage> = {},
  at: number | null = Date.UTC(2026, 9, 18, 2, 0, 0),
): TranscriptEntry => ({
  id: 'sent:k1',
  kind: 'tool',
  text: 'sent to tanna',
  ...(at === null ? {} : { at }),
  tools: [
    { key: 'k1', use: { name: 'Bash', input: { command: 'fy send tanna "Hello"' } }, result: { text: 'delivered' } },
  ],
  sent: { to: 'tanna', body: 'Hello **there**', ask: false, state: 'delivered', ...sent },
});

/** The state's words, without the separator that ends them on the foot (it is hidden from a screen reader). */
const words = (state: Element | null): string | null | undefined => state?.textContent?.replace(/ ·$/u, '');

const fleet = [
  { config: { id: 'mvtanna-1', teammate: 'tanna' }, state: { status: 'running' } },
] as unknown as FerretView[];

describe('a message this ferret sent', () => {
  test('is a "Sent to" card naming the proved recipient, with the message and where it got to', async () => {
    const view = await mount(
      <ReferenceSurfaceProvider
        surface={{
          agentReferenceResolver: fleetAgentResolver('d1' as DaemonId, fleet),
          onNavigate: () => undefined,
        }}
      >
        <TranscriptRow entry={sentRow()} previous={{ id: 'a', kind: 'assistant', text: 'ok' }} />
      </ReferenceSurfaceProvider>,
    );
    const card = must(view.container.querySelector<HTMLElement>('.fy-message-sent'), 'the card');
    expect(card.dataset['sentState']).toBe('delivered');
    expect(card.dataset['transcriptDensity']).toBe('message');
    expect(card.textContent).toContain('Sent to');
    expect(must(card.querySelector('a'), 'the recipient link').getAttribute('href')).toBe('/d/d1/session/mvtanna-1');
    expect(must(card.querySelector('.fy-sent-body strong'), 'the bold word').textContent).toBe('there');
    expect(words(card.querySelector('.fy-sent-state'))).toBe('Delivered');
    // The separator leads the command, not the state: a wrap never strands it at a line's end.
    expect(card.querySelector('.fy-sent-state .fy-sent-dot')).toBeNull();
    expect(card.querySelector('.fy-sent-command > .fy-sent-dot')?.getAttribute('aria-hidden')).toBe('true');
    expect(card.querySelector('.fy-sent-dot + .fy-sent-command-toggle')).not.toBeNull();
    expect(card.querySelector('[role="alert"]')).toBeNull();
    // The command is one tap away, and folds back.
    expect(card.querySelector('.fy-message-tools, [data-tool-group]')).toBeNull();
    const toggle = must(card.querySelector<HTMLButtonElement>('.fy-sent-command-toggle'), 'the toggle');
    expect(toggle.textContent).toBe('Show command');
    await interact(() => toggle.click());
    expect(toggle.textContent).toBe('Hide command');
    expect(card.textContent).toContain('Bash');
    await interact(() => toggle.click());
    expect(toggle.textContent).toBe('Show command');
    await view.unmount();
  });

  test('says a failed send failed, and why, out loud', async () => {
    const view = await mount(
      <TranscriptRow entry={sentRow({ state: 'failed', reason: 'session not found: tanna' })} />,
    );
    const state = must(view.container.querySelector<HTMLElement>('.fy-sent-state'), 'the state');
    expect(state.getAttribute('role')).toBe('alert');
    // The alert says why: a screen reader hears the reason with the failure, not after it.
    expect(words(state)).toBe('Not delivered: session not found: tanna');
    // For the eye, the reason in the CLI's own words is the one thing that takes a line of its own.
    const reason = must(view.container.querySelector('[data-sent-reason]'), 'the reason');
    expect(reason.textContent).toBe('session not found: tanna');
    expect(reason.getAttribute('aria-hidden')).toBe('true');
    // Unproved, the recipient is a plain name.
    expect(must(view.container.querySelector('.fy-peer-name'), 'the name').textContent).toBe('Tanna');
    await view.unmount();
  });

  test('reads every other state, a question, and a body it could not see', async () => {
    for (const [state, word, shortWord] of [
      ['sending', 'Sending…', 'Sending…'],
      ['queued', 'Queued — it reads this when its current turn ends', 'Queued'],
      ['held', 'Held', 'Held'],
      ['replied', 'Replied', 'Replied'],
    ] as const) {
      const view = await mount(<TranscriptRow entry={sentRow({ state, reason: '' })} />);
      const shown = must(view.container.querySelector<HTMLElement>('.fy-sent-state'), 'the state');
      // One short word on the line; the rest for a screen reader and on hover.
      expect(words(shown)).toBe(word);
      expect(shown.getAttribute('title')).toBe(word);
      expect(must(shown.querySelector('.fy-sent-word'), 'the word').firstChild?.textContent).toBe(shortWord);
      expect(view.container.querySelector('[data-sent-reason]')).toBeNull();
      await view.unmount();
    }
    const asked = await mount(
      <TranscriptRow entry={sentRow({ ask: true, body: null, messageFile: '/tmp/brief.md' }, null)} />,
    );
    expect(asked.container.querySelector('.fy-peer-kind')?.textContent).toBe('waiting for a reply');
    expect(asked.container.querySelector('.fy-sent-unseen')?.textContent).toBe(
      'The message was read from /tmp/brief.md.',
    );
    expect(asked.container.querySelector('time')).toBeNull();
    await asked.unmount();
    const composed = await mount(<TranscriptRow entry={sentRow({ body: null })} />);
    expect(composed.container.querySelector('.fy-sent-unseen')?.textContent).toBe(
      'The message was composed by a shell command.',
    );
    await composed.unmount();
  });

  test('says why a held send waits, in the words of the CLI form it held with (&B157)', async () => {
    for (const [output, detail] of [
      [
        "held as an FYI (not typed yet): it is delivered when the agent's turn ends, or by 10:40:00 at the latest; do not resend",
        "delivered when Tanna's turn ends",
      ],
      [
        'held until 10:38:00 to combine with other messages (action); not typed yet; do not resend',
        'delivered at 10:38, batched with its other messages',
      ],
    ] as const) {
      const sent = must(
        readSentMessage(
          { use: { name: 'Bash', input: { command: 'fy send tanna "Hello"' } }, result: { text: output } },
          'fy',
        ),
        'the send',
      );
      const view = await mount(<TranscriptRow entry={sentRow(sent)} />);
      const shown = must(view.container.querySelector<HTMLElement>('.fy-sent-state'), 'the state');
      // The line reads just "Held" (one line on a phone); the why is the tooltip and the accessible name.
      const visible = must(shown.querySelector('.fy-sent-word'), 'the word').firstChild?.textContent;
      expect(visible).toBe('Held');
      expect(words(shown)).toBe(`Held — ${detail}`);
      expect(shown.getAttribute('title')).toBe(`Held — ${detail}`);
      expect(shown.querySelector('.sr-only')?.textContent).toBe(` — ${detail}`);
      await view.unmount();
    }
  });

  test('opens nothing when the card carries no calls', async () => {
    const { tools: _tools, ...bare } = sentRow();
    const view = await mount(<TranscriptRow entry={bare} />);
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('.fy-sent-command-toggle'), 'toggle').click(),
    );
    expect(view.container.textContent).not.toContain('Bash');
    await view.unmount();
  });
});

describe('the sent card is compact (&F949)', () => {
  test('its foot is ONE row: where it got to · Show command, then the time', async () => {
    const view = await mount(<TranscriptRow entry={sentRow({ state: 'held' })} />);
    const foot = must(view.container.querySelector<HTMLElement>('.fy-sent-foot'), 'the foot');
    // The state, the dot, the command toggle and the time are the foot's own children: no line above it.
    expect(foot.querySelector('.fy-sent-state')).not.toBeNull();
    expect(foot.querySelector('.fy-sent-command-toggle')).not.toBeNull();
    expect(foot.querySelector('time')?.textContent).not.toBe('');
    expect(view.container.querySelectorAll('.fy-message-sent > .fy-sent-state')).toHaveLength(0);
    // The head is a meta line: "Sent to" and the name, in the head's own class.
    expect(view.container.querySelector('.fy-sent-head')?.textContent).toContain('Sent to');
    await view.unmount();
  });
});
