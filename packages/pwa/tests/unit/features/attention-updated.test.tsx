import { describe, expect, it } from 'bun:test';
import type { AttentionRevision } from '@ferretry/protocol';
import { AttentionCard } from '../../../src/features/attention/attention-card.tsx';
import { AttentionDetail } from '../../../src/features/attention/attention-detail.tsx';
import { AttentionUpdated } from '../../../src/features/attention/attention-updated.tsx';
import { attentionItem, choices } from '../../support/attention-inbox.tsx';
import { interact, type Mounted, mount, must, pressKey } from '../../support/dom.ts';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const revisions: AttentionRevision[] = [
  {
    at: '2026-07-31T09:00:00.000Z',
    by: 'agent',
    changed: ['decided'],
    previous: { decided: '- Use SQLite' },
  } as AttentionRevision,
  {
    at: '2026-08-01T11:55:00.000Z',
    by: 'agent',
    changed: ['decided', 'stillOpen', 'why'],
    previous: { decided: '- Use SQLite', why: 'Old reason.' },
  } as AttentionRevision,
];

const living = attentionItem('A5', {
  subject: 'Ship Monday?',
  ask: choices('Yes', 'No'),
  why: 'New reason.',
  decided: '- Use SQLite\n- Ship Monday',
  stillOpen: '- Who owns the rollback?',
  revisions,
});

const at = (view: Mounted, selector: string, what: string): HTMLElement =>
  must(view.container.querySelector<HTMLElement>(selector), what);

describe('AttentionUpdated', () => {
  it('draws nothing for an item never edited', async () => {
    const view = await mount(<AttentionUpdated item={attentionItem('A5')} now={NOW} />);
    expect(view.container.querySelector('[data-attention-updated]')).toBeNull();
    await view.unmount();
  });

  it('says how long ago, and opens a read-only list of earlier versions, newest first', async () => {
    const view = await mount(<AttentionUpdated item={living} now={NOW} />);
    const button = at(view, '[data-attention-updated]', 'Updated');
    expect(button.textContent).toContain('Updated 5 min ago');
    expect(view.container.querySelector('[data-attention-revisions]')).toBeNull();
    await interact(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const list = at(view, '[data-attention-revisions]', 'the list');
    const items = [...list.querySelectorAll('[data-attention-revision]')];
    expect(items.map(item => item.getAttribute('data-attention-revision'))).toEqual([
      '2026-08-01T11:55:00.000Z',
      '2026-07-31T09:00:00.000Z',
    ]);
    expect(items[0]?.textContent).toContain('The ferret changed Decided so far, Still open, Why it matters');
    expect(items[0]?.textContent).toContain('Old reason.');
    expect(items[0]?.textContent).toContain('Still open was empty');
    expect(list.querySelector('button, input, textarea')).toBeNull();
    await view.unmount();
  });

  it('closes on Esc and hands focus back to the button', async () => {
    const view = await mount(<AttentionUpdated item={living} now={NOW} />);
    const button = at(view, '[data-attention-updated]', 'Updated');
    await interact(() => button.click());
    await interact(() => pressKey(at(view, '[data-attention-revisions]', 'the list'), 'Escape'));
    expect(view.container.querySelector('[data-attention-revisions]')).toBeNull();
    expect(document.activeElement).toBe(button);
    await view.unmount();
  });
});

describe('the detail as a living summary', () => {
  it('draws Decided so far and Still open after Why it matters, with the new points marked', async () => {
    const view = await mount(
      <AttentionDetail item={{ ...living, context: 'It blocks the release.' }} layout="panel" />,
    );
    const names = [...view.container.querySelectorAll('[data-attention-section]')].map(node =>
      node.getAttribute('data-attention-section'),
    );
    expect(names.indexOf('context')).toBeLessThan(names.indexOf('decided'));
    expect(names.indexOf('decided')).toBeLessThan(names.indexOf('still-open'));
    expect(at(view, '[data-attention-section="decided"] h4', 'heading').textContent).toContain('Decided so far');
    const fresh = [...view.container.querySelectorAll('[data-attention-changed="new"]')].map(node => node.textContent);
    expect(fresh.some(text => text?.includes('Ship Monday'))).toBe(true);
    expect(fresh.some(text => text?.includes('Use SQLite'))).toBe(false);
    expect(fresh.some(text => text?.includes('Who owns the rollback?'))).toBe(true);
    for (const node of view.container.querySelectorAll('[data-attention-changed="new"]'))
      expect(node.textContent).toContain('new');
    expect(view.container.querySelector('[data-attention-updated]')).not.toBeNull();
    await view.unmount();
  });

  it('draws no marks and no Updated button for an item never edited', async () => {
    const view = await mount(
      <AttentionDetail item={attentionItem('A5', { decided: '- a', stillOpen: '- b' })} layout="panel" />,
    );
    expect(view.container.querySelector('[data-attention-changed]')).toBeNull();
    expect(view.container.querySelector('[data-attention-updated]')).toBeNull();
    await view.unmount();
  });
});

describe('the card', () => {
  it('says "N decided · M still open" and Updated, and marks a changed why line', async () => {
    const card = await mount(<AttentionCard item={living} onAct={() => undefined} />);
    expect(at(card, '[data-attention-summary]', 'summary').textContent).toBe('2 decided · 1 still open');
    expect(at(card, '[data-attention-updated]', 'Updated').textContent).toContain('Updated');
    expect(at(card, '[data-attention-why]', 'why').getAttribute('data-attention-changed')).toBe('changed');
    await card.unmount();
  });

  it('draws neither for an item with no lists and no edits', async () => {
    const plain = attentionItem('A5', { ask: choices('Yes', 'No') });
    const card = await mount(<AttentionCard item={plain} onAct={() => undefined} />);
    expect(card.container.querySelector('[data-attention-living]')).toBeNull();
    await card.unmount();
  });
});
