import { afterEach, describe, expect, it } from 'bun:test';
import { AgendaDetail, agendaHasDetail } from '../../../src/features/agenda/agenda-detail.tsx';
import { agendaItem, choices } from '../../support/agenda-inbox.tsx';
import { type Mounted, mount, must } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const full = agendaItem('A5', {
  subject: 'Which database?',
  ask: choices('SQLite', 'Postgres'),
  premise: '- We store runs',
  context: '- Reads drop to **12 ms**\n- Nothing else changes',
  decided: '- No hosted services',
  terms: [{ term: 'WAL', meaning: 'write-ahead log' }],
  steps: ['Back up the file'],
  body: 'The long story.',
  links: [{ label: 'Spec', target: 'https://example.com/spec' }],
});

const sections = (root: ParentNode): string[] =>
  [...root.querySelectorAll('[data-agenda-section]')].map(node => node.getAttribute('data-agenda-section') ?? '');

describe('AgendaDetail', () => {
  it('draws the sections in the fixed order: premise, context, decided, terms, steps, more, links', async () => {
    view = await mount(<AgendaDetail item={full} layout="panel" />);
    expect(sections(view.container)).toEqual(['premise', 'context', 'decided', 'terms', 'steps', 'more', 'links']);
    const titles = [...view.container.querySelectorAll('[data-agenda-section] > :first-child')].map(n => n.textContent);
    expect(titles.join(' | ')).toContain('Premise');
    expect(titles.join(' | ')).toContain('Context');
    expect(titles.join(' | ')).not.toMatch(/why now/iu);
  });

  it('leaves out every section the item does not have', async () => {
    view = await mount(<AgendaDetail item={agendaItem('A5', { context: '- one point' })} layout="panel" />);
    expect(sections(view.container)).toEqual(['context']);
  });

  it('draws terms as a two-column table and bolds key numbers', async () => {
    view = await mount(<AgendaDetail item={full} layout="panel" />);
    const table = must(view.container.querySelector('table[data-agenda-terms]'), 'the terms table');
    expect(table.querySelector('th[scope="row"]')?.textContent).toBe('WAL');
    expect(table.querySelector('td')?.textContent).toBe('write-ahead log');
    expect(view.container.querySelector('strong')?.textContent).toBe('12 ms');
  });

  it('marks its layout, and never adds an inner scroller or fixed height in the full layout', async () => {
    view = await mount(<AgendaDetail item={full} layout="full" />);
    const root = must(view.container.querySelector<HTMLElement>('[data-agenda-detail]'), 'the detail');
    expect(root.getAttribute('data-layout')).toBe('full');
    expect(root.style.overflow).toBe('');
    expect(root.style.height).toBe('');
    expect(root.style.maxHeight).toBe('');
    expect(root.querySelector('[data-agenda-scroll]')).toBeNull();
    await view.render(<AgendaDetail item={full} layout="panel" />);
    expect(must(view.container.querySelector('[data-agenda-detail]'), 'the detail').getAttribute('data-layout')).toBe(
      'panel',
    );
  });

  it('reports whether there is anything to read beyond the question', () => {
    expect(agendaHasDetail(full)).toBe(true);
    expect(agendaHasDetail(agendaItem('A5', { ask: choices('A', 'B') }))).toBe(false);
    expect(agendaHasDetail(agendaItem('A5', { steps: ['one'] }))).toBe(true);
    expect(agendaHasDetail(agendaItem('A5', { context: '   ' }))).toBe(false);
  });
});
