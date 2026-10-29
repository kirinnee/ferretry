import { describe, expect, it } from 'bun:test';
import type { AttentionItem, ResolvedAttentionItem } from '@ferretry/protocol';
import { AttentionAskMessage } from '../../../src/features/attention/attention-ask-message.tsx';
import type { InboxAction } from '../../../src/lib/attention-inbox.ts';
import { attentionItem, choices } from '../../support/attention-inbox.tsx';
import { interact, mount, must } from '../../support/dom.ts';

const open = (overrides: Partial<AttentionItem> = {}): AttentionItem =>
  attentionItem('A5', {
    subject: 'Which database?',
    ask: choices('SQLite', 'Postgres'),
    waitingOn: 'ferret',
    waitingFor: 'discussion',
    askedAt: '2026-08-01T11:00:00.000Z',
    recommendation: { decision: 'SQLite', why: 'No server to run.' },
    ...overrides,
  });

const resolved = (item: AttentionItem, extra: Record<string, unknown>): ResolvedAttentionItem =>
  ({
    ...item,
    resolvedAt: '2026-08-01T12:00:00.000Z',
    resolutionNote: null,
    resolvedBy: 'human',
    resolvedBySession: null,
    resolvedByName: null,
    ...extra,
  }) as ResolvedAttentionItem;

const noop = (): void => undefined;

describe('AttentionAskMessage', () => {
  it('reads as a message: an Ask label, the question, and chips with the recommended one tagged', async () => {
    const view = await mount(<AttentionAskMessage item={open()} onAct={noop} onReplyTo={noop} replying={false} />);
    const root = must(view.container.querySelector('[data-attention-ask]'), 'the ask');
    expect(root.getAttribute('data-state')).toBe('discussion');
    expect(root.querySelector('[data-attention-ask-label]')?.textContent).toBe('Ask · !A5');
    expect(root.querySelector('[data-attention-ask-question]')?.textContent).toBe('Which database?');
    expect(root.querySelector('[data-attention-ask-chip="SQLite"] [data-attention-recommended]')).not.toBeNull();
    expect(root.querySelector('[data-attention-ask-chip="Postgres"] [data-attention-recommended]')).toBeNull();
    expect(root.querySelector('[data-attention-ask-surfaced]')).toBeNull();
    await view.unmount();
  });

  it('a chip answers through onAct, bare — the host attaches the composer text', async () => {
    const acts: InboxAction[] = [];
    const view = await mount(
      <AttentionAskMessage item={open()} onAct={a => acts.push(a)} onReplyTo={noop} replying={false} />,
    );
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-attention-ask-chip="Postgres"]'), 'chip').click(),
    );
    expect(acts).toEqual([
      { kind: 'respond', label: 'Postgres', response: { kind: 'multiple-choice', choice: 'Postgres' } },
    ]);
    await view.unmount();
  });

  it('Reply makes it the reply target and reads "Replying" while it is', async () => {
    let replied = 0;
    const view = await mount(
      <AttentionAskMessage
        item={open()}
        onAct={noop}
        onReplyTo={() => {
          replied += 1;
        }}
        replying={false}
      />,
    );
    const reply = (): HTMLButtonElement =>
      must(view.container.querySelector<HTMLButtonElement>('[data-attention-ask-reply]'), 'reply');
    expect(reply().textContent).toContain('Reply');
    await interact(() => reply().click());
    expect(replied).toBe(1);
    await view.render(<AttentionAskMessage item={open()} onAct={noop} onReplyTo={noop} replying />);
    expect(reply().textContent).toContain('Replying');
    expect(reply().getAttribute('aria-pressed')).toBe('true');
    await view.unmount();
  });

  it('Details shows only when the host can open it', async () => {
    let opened = 0;
    const view = await mount(
      <AttentionAskMessage
        item={open()}
        onAct={noop}
        onOpenDetail={() => {
          opened += 1;
        }}
        onReplyTo={noop}
        replying={false}
      />,
    );
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-attention-ask-details]'), 'details').click(),
    );
    expect(opened).toBe(1);
    await view.render(<AttentionAskMessage item={open()} onAct={noop} onReplyTo={noop} replying={false} />);
    expect(view.container.querySelector('[data-attention-ask-details]')).toBeNull();
    await view.unmount();
  });

  it('⋯ Not needed dismisses', async () => {
    const acts: InboxAction[] = [];
    const view = await mount(
      <AttentionAskMessage item={open()} onAct={a => acts.push(a)} onReplyTo={noop} replying={false} />,
    );
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-attention-more]'), 'more').click(),
    );
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-attention-dismiss]'), 'not needed').click(),
    );
    expect(acts.map(a => a.kind)).toEqual(['dismiss']);
    await view.unmount();
  });

  it('a surfaced ask says it moved to the Attention queue and keeps its chips live', async () => {
    const view = await mount(
      <AttentionAskMessage
        item={open({ waitingOn: undefined, waitingFor: undefined, askedAt: undefined })}
        onAct={noop}
        onReplyTo={noop}
        replying={false}
      />,
    );
    const root = must(view.container.querySelector('[data-attention-ask]'), 'the ask');
    expect(root.getAttribute('data-state')).toBe('surfaced');
    expect(root.querySelector('[data-attention-ask-surfaced]')?.textContent).toBe('Moved to your Attention queue');
    expect(root.querySelector<HTMLButtonElement>('[data-attention-ask-chip="SQLite"]')?.disabled).toBe(false);
    await view.unmount();
  });

  it('an answered ask disables its chips, drops Reply and says what was picked', async () => {
    const item = resolved(open(), {
      disposition: 'done',
      response: { kind: 'multiple-choice', choice: 'Postgres' },
    });
    const view = await mount(<AttentionAskMessage item={item} onAct={noop} onReplyTo={noop} replying={false} />);
    const root = must(view.container.querySelector('[data-attention-ask]'), 'the ask');
    expect(root.getAttribute('data-state')).toBe('answered');
    expect(
      [...root.querySelectorAll<HTMLButtonElement>('[data-attention-ask-chip]')].every(chip => chip.disabled),
    ).toBe(true);
    expect(root.querySelector('[data-attention-ask-result]')?.textContent).toContain('Postgres');
    expect(root.querySelector('[data-attention-ask-reply]')).toBeNull();
    await view.unmount();
  });

  it('a dismissed ask has no chips and says it was not needed, with the reason', async () => {
    const item = resolved(open(), { disposition: 'dismissed', resolutionNote: 'already shipped' });
    const view = await mount(<AttentionAskMessage item={item} onAct={noop} onReplyTo={noop} replying={false} />);
    const root = must(view.container.querySelector('[data-attention-ask]'), 'the ask');
    expect(root.getAttribute('data-state')).toBe('dismissed');
    expect(root.querySelector('[data-attention-ask-chip]')).toBeNull();
    expect(root.querySelector('[data-attention-ask-result]')?.textContent).toBe('Not needed: already shipped');
    await view.unmount();
  });
});
