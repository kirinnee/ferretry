import { afterEach, describe, expect, test } from 'bun:test';
import { AttentionBriefSections } from '../../../src/features/attention/attention-brief.tsx';
import { attentionItem, choices } from '../../support/attention-inbox.tsx';
import { type Mounted, mount, must } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const item = attentionItem('A1', {
  title: 'Database for the board',
  subject: 'Which database should keep the board’s finished items?',
  ask: choices('SQLite', 'Postgres'),
  recommendation: { decision: 'SQLite', why: 'No server to run.' },
});

const recommendationOf = (root: ParentNode): Element | null =>
  root.querySelector('[data-attention-section="recommendation"]');

describe('the brief sections', () => {
  test('draw the recommendation and its reason where nothing above them already does (the board)', async () => {
    view = await mount(<AttentionBriefSections item={item} renderProse={text => text} />);
    const section = must(recommendationOf(must(view.container, 'view')), 'the recommendation section');
    expect(section.textContent).toContain('SQLite — No server to run.');
  });

  test('leave the recommendation out where the card draws it under its ask', async () => {
    view = await mount(<AttentionBriefSections item={item} renderProse={text => text} showRecommendation={false} />);
    expect(recommendationOf(must(view.container, 'view'))).toBeNull();
  });
});
