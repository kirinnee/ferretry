import { describe, expect, test } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import { ReferenceSurfaceProvider } from '../../src/components/reference-surface.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { createAgentReferenceResolver } from '../../src/lib/agent-references.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import type { SentMessage } from '../../src/lib/peer-delivery.ts';
import type { TranscriptEntry } from '../../src/lib/session-screens.ts';
import { interact, mount, must } from '../support/dom.ts';

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
] as unknown as SessionView[];

describe('a message this ferret sent', () => {
  test('is a "Sent to" card naming the proved recipient, with the message and where it got to', async () => {
    const view = await mount(
      <ReferenceSurfaceProvider
        surface={{
          agentReferenceResolver: createAgentReferenceResolver('d1' as DaemonId, fleet),
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
    expect(card.querySelector('.fy-sent-state .fy-sent-dot')?.getAttribute('aria-hidden')).toBe('true');
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
    expect(words(state)).toBe('Not delivered');
    // The reason, in the CLI's own words, is the one thing that takes a line of its own.
    expect(view.container.querySelector('[data-sent-reason]')?.textContent).toBe('session not found: tanna');
    // Unproved, the recipient is a plain name.
    expect(must(view.container.querySelector('.fy-peer-name'), 'the name').textContent).toBe('Tanna');
    await view.unmount();
  });

  test('reads every other state, a question, and a body it could not see', async () => {
    for (const [state, word] of [
      ['sending', 'Sending…'],
      ['queued', 'Queued — it reads this when its current turn ends'],
      ['held', "Held — delivered when Tanna's turn ends"],
      ['replied', 'Replied'],
    ] as const) {
      const view = await mount(<TranscriptRow entry={sentRow({ state, reason: '' })} />);
      const shown = must(view.container.querySelector<HTMLElement>('.fy-sent-state'), 'the state');
      // One short word on the line; the rest for a screen reader and on hover.
      expect(words(shown)).toBe(word);
      expect(shown.getAttribute('title')).toBe(word);
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
