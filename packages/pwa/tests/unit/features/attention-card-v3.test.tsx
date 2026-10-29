import { describe, expect, it } from 'bun:test';
import type { AttentionAsk } from '@ferretry/protocol';
import { AttentionCard } from '../../../src/features/attention/attention-card.tsx';
import { DISMISS_ACTION, type InboxAction } from '../../../src/lib/attention-inbox.ts';
import { attentionItem, choices } from '../../support/attention-inbox.tsx';
import { interact, type Mounted, mount, must, pressKey } from '../../support/dom.ts';

const pick = <T extends HTMLElement>(view: Mounted, selector: string, what: string): T =>
  must(view.container.querySelector<T>(selector), what);

const click = (view: Mounted, selector: string, what: string) =>
  interact(() => pick<HTMLButtonElement>(view, selector, what).click());

const mountCard = async (
  ask: AttentionAsk,
  onAct: (action: InboxAction) => void,
  props: { flat?: boolean; extra?: Record<string, unknown> } = {},
) =>
  mount(
    <AttentionCard
      flat={props.flat}
      item={attentionItem('A5', { subject: 'Which database?', ask, ...props.extra })}
      onAct={onAct}
    />,
  );

describe('the minimal card', () => {
  it('has no text box, no Other-answer box, no note link and no Discuss button', async () => {
    const view = await mountCard(choices('SQLite', 'Postgres'), () => undefined);
    expect(view.container.querySelector('textarea')).toBeNull();
    expect(view.container.querySelector('[data-attention-other]')).toBeNull();
    expect(view.container.querySelector('[data-attention-reply-toggle]')).toBeNull();
    expect(view.container.querySelector('[data-attention-discuss]')).toBeNull();
    expect(view.container.querySelector('[data-attention-dismiss-box]')).toBeNull();
    await view.unmount();
  });

  it('reads: the question, one why line, the option buttons, then a quiet second row', async () => {
    const view = await mountCard(choices('SQLite', 'Postgres'), () => undefined, {
      extra: { why: 'It blocks the release.', context: 'More to read' },
    });
    expect(pick(view, '[data-attention-title]', 'the question').textContent).toContain('Which database?');
    expect(view.container.textContent).toContain('It blocks the release.');
    expect(
      [...view.container.querySelectorAll('[data-attention-option]')]
        .map(n => n.getAttribute('data-attention-option'))
        .sort(),
    ).toEqual(['Postgres', 'SQLite']);
    const actions = pick(view, '[data-attention-actions]', 'the actions');
    expect(actions.querySelector('[data-attention-more]')).not.toBeNull();
    await view.unmount();
  });

  it('picks an option as a bare response; the host adds the composer text', async () => {
    const acts: InboxAction[] = [];
    const view = await mountCard(choices('SQLite', 'Postgres'), a => acts.push(a));
    await click(view, '[data-attention-option="Postgres"]', 'Postgres');
    expect(acts).toEqual([
      { kind: 'respond', label: 'Postgres', response: { kind: 'multiple-choice', choice: 'Postgres' } },
    ]);
    await view.unmount();
  });

  it('a text-only ask offers no options and says to reply in the message box', async () => {
    const view = await mountCard({ kind: 'open-question' }, () => undefined);
    expect(view.container.querySelector('[data-attention-option]')).toBeNull();
    expect(pick(view, '[data-attention-composer-hint]', 'the hint').textContent).toContain('message box');
    await view.unmount();
  });
});

describe('Details ›', () => {
  it('shows only when the item has more to read, and opens the detail', async () => {
    let opened = 0;
    const withDetail = await mount(
      <AttentionCard
        item={attentionItem('A5', { ask: choices('A', 'B'), context: 'Reads drop' })}
        onAct={() => undefined}
        onOpenDetail={() => {
          opened += 1;
        }}
      />,
    );
    await click(withDetail, '[data-attention-details]', 'Details');
    expect(opened).toBe(1);
    await withDetail.unmount();
    const without = await mount(
      <AttentionCard
        item={attentionItem('A5', { ask: choices('A', 'B'), why: 'Because.' })}
        onAct={() => undefined}
        onOpenDetail={() => undefined}
      />,
    );
    expect(without.container.querySelector('[data-attention-details]')).toBeNull();
    await without.unmount();
  });

  it('is absent when the host gives no way to open it', async () => {
    const view = await mountCard(choices('A', 'B'), () => undefined, { extra: { context: 'Reads drop' } });
    expect(view.container.querySelector('[data-attention-details]')).toBeNull();
    await view.unmount();
  });
});

describe('Not needed… (the ⋯ menu)', () => {
  it('dismisses at once with no box; the host attaches the composer text', async () => {
    const acts: InboxAction[] = [];
    const view = await mountCard(choices('A', 'B'), a => acts.push(a));
    await click(view, '[data-attention-more]', 'the ⋯ button');
    const item = pick(view, '[role="menu"] [data-attention-dismiss]', 'Not needed');
    expect(item.textContent).toContain('Not needed…');
    await interact(() => item.click());
    expect(acts).toEqual([DISMISS_ACTION]);
    expect(view.container.querySelector('textarea')).toBeNull();
    await view.unmount();
  });

  it('closes on Esc and hands focus back to the ⋯ button', async () => {
    const view = await mountCard(choices('A', 'B'), () => undefined);
    const opener = pick<HTMLButtonElement>(view, '[data-attention-more]', 'the ⋯ button');
    await interact(() => opener.click());
    await interact(() => pressKey(pick(view, '[role="menu"]', 'the menu'), 'Escape'));
    expect(view.container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
    await view.unmount();
  });
});

describe('the recommendation', () => {
  it('is a tag read aloud on the option and one reason line, not a box', async () => {
    const view = await mountCard(choices('SQLite', 'Postgres'), () => undefined, {
      extra: { recommendation: { decision: 'SQLite', why: 'No server to run.' } },
    });
    const option = pick(view, '[data-attention-option="SQLite"]', 'SQLite');
    expect(option.textContent).toContain('Recommended');
    expect(option.querySelector('[data-attention-recommended]')).not.toBeNull();
    expect(pick(view, '[data-attention-option="Postgres"]', 'Postgres').textContent).not.toContain('Recommended');
    expect(pick(view, '[data-attention-recommendation]', 'the reason').textContent).toBe('No server to run.');
    expect(view.container.querySelector('[data-attention-section="recommendation"]')).toBeNull();
    await view.unmount();
  });
});

describe('the flat card', () => {
  it('marks itself flat and draws no swipe arrows, while a plain card keeps them', async () => {
    const flat = await mountCard(choices('SQLite', 'Postgres'), () => undefined, { flat: true });
    expect(flat.container.querySelector('[data-flat]')).not.toBeNull();
    expect(flat.container.querySelector('.fy-attn-answer svg')).toBeNull();
    await flat.unmount();
    const card = await mountCard(choices('SQLite', 'Postgres'), () => undefined);
    expect(card.container.querySelector('[data-flat]')).toBeNull();
    await card.unmount();
  });

  it('still answers, with the same buttons', async () => {
    const acts: InboxAction[] = [];
    const view = await mountCard(choices('SQLite', 'Postgres'), a => acts.push(a), { flat: true });
    await click(view, '[data-attention-option="SQLite"]', 'SQLite');
    expect(acts.map(a => a.kind)).toEqual(['respond']);
    await view.unmount();
  });
});
