import { afterEach, describe, expect, it } from 'bun:test';
import type { PackGuideAcceptRequest, PackGuideSuggestion } from '@ferretry/protocol';
import { GuideReviewView } from '../../../../src/features/pack/guide-review-view.tsx';
import { type Mounted, mount, must } from '../../../support/dom.ts';
import { byText, click, textOf } from '../../../support/learning-dom.ts';
import { CURRENT_GUIDE, SUGGESTION } from '../../../support/pack.ts';

let shown: Mounted | undefined;
afterEach(async () => {
  await shown?.unmount();
  shown = undefined;
});

type Edit = Parameters<React.ComponentProps<typeof GuideReviewView>['onEdit']>[0];

const review = async (suggestion: PackGuideSuggestion = SUGGESTION, busy = false) => {
  const accepts: PackGuideAcceptRequest[] = [];
  const edits: Edit[] = [];
  let discards = 0;
  shown = await mount(
    <GuideReviewView
      suggestion={suggestion}
      busy={busy}
      onAccept={request => accepts.push(request)}
      onEdit={guide => edits.push(guide)}
      onDiscard={() => {
        discards += 1;
      }}
    />,
  );
  return { root: shown.container, accepts, edits, discards: () => discards };
};

const action = (root: HTMLElement, name: string) =>
  must(root.querySelector<HTMLButtonElement>(`[data-review-action="${name}"]`), name);
const rowOf = (root: HTMLElement, id: string) => must(root.querySelector<HTMLElement>(`[data-review-row="${id}"]`), id);
const tick = (root: HTMLElement, id: string) =>
  must(rowOf(root, id).querySelector<HTMLInputElement>('[data-review-accept]'), `tick ${id}`);
const routingTick = (root: HTMLElement) =>
  must(root.querySelector<HTMLInputElement>('[data-review-accept-routing]'), 'routing tick');

describe('GuideReviewView', () => {
  it('says who suggested it, and shows one row per use case with its status', async () => {
    const { root } = await review();
    expect(must(root.querySelector('[data-review-header]'), 'header').textContent).toContain('gpt-6-astra');
    const statuses = Object.fromEntries(
      [...root.querySelectorAll('[data-review-row]')].map(r => [
        r.getAttribute('data-review-row'),
        r.getAttribute('data-review-status'),
      ]),
    );
    expect(statuses).toEqual({ hard: 'same', bulk: 'changed', docs: 'added', legacy: 'removed' });
    expect(rowOf(root, 'hard').querySelector('[data-review-accept]') === null).toBe(true);
    expect(textOf(rowOf(root, 'hard'))).toContain('no change');
    expect(textOf(rowOf(root, 'docs'))).toContain('Not in the current guide.');
    expect(textOf(rowOf(root, 'legacy'))).toContain('Taken out of the guide.');
    expect(rowOf(root, 'bulk').querySelector('[data-review-changes]')).not.toBeNull();
    expect(textOf(rowOf(root, 'bulk'))).toContain('description reworded');
  });

  it('shows the routing before and after, and the dropped and flagged notes', async () => {
    const { root } = await review();
    const routing = must(root.querySelector('[data-review-routing]'), 'routing');
    expect(routing.getAttribute('data-review-routing')).toBe('changed');
    expect(textOf(routing)).toContain('Opus plans, Sonnet edits, Haiku does chores');
    expect(textOf(must(root.querySelector('[data-review-dropped]'), 'dropped'))).toContain('glm-9');
    expect(textOf(must(root.querySelector('[data-review-flagged]'), 'flagged'))).toContain('ultra');
  });

  it('starts with every change ticked, and Accept all sends everything', async () => {
    const { root, accepts } = await review();
    expect(['bulk', 'docs', 'legacy'].map(id => tick(root, id).checked)).toEqual([true, true, true]);
    expect(routingTick(root).checked).toBe(true);
    await click(action(root, 'accept-all'));
    expect(accepts).toHaveLength(1);
    expect(accepts[0]?.partial).not.toBe(true);
    expect(accepts[0]?.routing).toEqual(SUGGESTION.routing);
    expect(accepts[0]?.useCases.map(u => u.id)).toEqual(['hard', 'bulk', 'docs']);
    expect(accepts[0]?.suggested).toEqual(SUGGESTION.suggested);
  });

  it('keeps what is unticked as it is (an unticked removal stays), and leaves the routing out', async () => {
    const { root, accepts } = await review();
    await click(tick(root, 'docs'));
    await click(tick(root, 'legacy'));
    await click(routingTick(root));
    await click(action(root, 'accept-selected'));
    expect(accepts[0]?.partial).toBe(true);
    expect(accepts[0]?.routing).toBeUndefined();
    expect(accepts[0]?.useCases.map(u => u.id).sort()).toEqual(['bulk', 'hard', 'legacy']);
    await click(tick(root, 'docs'));
    await click(action(root, 'accept-selected'));
    expect(accepts[1]?.useCases.map(u => u.id).sort()).toEqual(['bulk', 'docs', 'hard', 'legacy']);
  });

  it('cannot accept or edit with nothing ticked, but can still discard', async () => {
    const { root, discards } = await review();
    for (const id of ['bulk', 'docs', 'legacy']) await click(tick(root, id));
    await click(routingTick(root));
    expect(action(root, 'accept-selected').disabled).toBe(true);
    expect(action(root, 'edit').disabled).toBe(true);
    await click(action(root, 'discard'));
    expect(discards()).toBe(1);
  });

  it('Edit hands the ticked result over instead of saving it', async () => {
    const { root, accepts, edits } = await review();
    await click(tick(root, 'legacy'));
    await click(action(root, 'edit'));
    expect(accepts).toHaveLength(0);
    expect(edits[0]?.useCases.map(u => u.id).sort()).toEqual(['bulk', 'docs', 'hard', 'legacy']);
    expect(edits[0]?.routing).toEqual(SUGGESTION.routing);
  });

  it('is locked while a write is going', async () => {
    const { root } = await review(SUGGESTION, true);
    expect(action(root, 'accept-all').disabled).toBe(true);
    expect(action(root, 'discard').disabled).toBe(true);
    expect(tick(root, 'docs').disabled).toBe(true);
    expect(routingTick(root).disabled).toBe(true);
  });

  it('says so when nothing differs, and shows an unchanged routing as such', async () => {
    const same: PackGuideSuggestion = {
      ...SUGGESTION,
      useCases: CURRENT_GUIDE.useCases,
      routing: { prompt: CURRENT_GUIDE.routing?.prompt ?? '', short: CURRENT_GUIDE.routing?.short ?? '' },
      dropped: [],
      flagged: [],
    };
    const { root } = await review(same);
    expect(textOf(root)).toContain('suggests nothing that differs');
    expect(root.querySelector('[data-review-routing]')?.getAttribute('data-review-routing')).toBe('same');
    expect(root.querySelector('[data-review-accept-routing]') === null).toBe(true);
    expect(action(root, 'accept-all').disabled).toBe(true);
    expect(root.querySelector('[data-review-dropped]') === null).toBe(true);
    expect(byText(root, 'button', 'Discard')).not.toBeNull();
  });

  it('shows a routing that is new where the current guide had none', async () => {
    const { root } = await review({ ...SUGGESTION, current: { ...CURRENT_GUIDE, routing: undefined } });
    expect(textOf(must(root.querySelector('[data-review-routing]'), 'routing'))).toContain('No routing guidance yet.');
  });
});
