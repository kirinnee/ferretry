/**
 * The layout previews: every choice key draws a scene whose one lit part is the thing it changes, the loop plays "the word
 * before → the word now" and shows only the final frame when motion is off, a replay follows a new choice, and the
 * navigation list draws five rows in their final order.
 */
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { afterEach, describe, expect, test } from 'bun:test';
import { LayoutPreview } from '../../../app/features/layout/previews/layout-preview.tsx';
import { NavListPreview } from '../../../app/features/layout/previews/nav-list-preview.tsx';
import { stateFor, wordBefore } from '../../../app/features/layout/previews/scene.ts';
import { type ChoiceSetting, LAYOUT_SETTINGS } from '../../../app/lib/layout-model.ts';

const choices = LAYOUT_SETTINGS.filter((setting): setting is ChoiceSetting => setting.kind === 'choice');
const choice = (path: ChoiceSetting['path']): ChoiceSetting =>
  must(
    choices.find(setting => setting.path === path),
    path,
  );

describe('the scene for a layout key', () => {
  test('a menu side puts the menu there and lights the menu', () => {
    for (const word of ['left', 'right', 'top', 'bottom'] as const)
      expect(stateFor('nav.side', word)).toMatchObject({ side: word, lit: 'nav', column: false, device: 'wide' });
  });

  test('a menu style changes only the style', () => {
    expect(stateFor('nav.style', 'list')).toMatchObject({ style: 'list', side: 'left', lit: 'nav' });
  });

  test('the second column is drawn for wide-only and always on a wide screen, and for always alone on a phone', () => {
    expect(stateFor('side.show', 'never')).toMatchObject({ column: false, narrowColumn: false, pair: true });
    expect(stateFor('side.show', 'wide-only')).toMatchObject({ column: true, narrowColumn: false, lit: 'column' });
    expect(stateFor('side.show', 'always')).toMatchObject({ column: true, narrowColumn: true });
    expect(stateFor('phone.side.show', 'wide-only')).toMatchObject({ column: false, device: 'phone', pair: false });
    expect(stateFor('phone.side.show', 'always')).toMatchObject({ column: true, device: 'phone' });
  });

  test('density lights the rows', () => {
    expect(stateFor('density', 'compact')).toMatchObject({ density: 'compact', lit: 'rows' });
    expect(stateFor('phone.density', 'comfortable')).toMatchObject({ density: 'comfortable', device: 'phone' });
  });

  test('a word it does not know draws the key neutral frame instead of throwing', () => {
    expect(stateFor('nav.side', 'sideways')).toMatchObject({ side: 'left' });
  });

  test('the loop starts from the word before, wrapping round', () => {
    const options = choice('nav.side').options;
    expect(wordBefore(options, 'right')).toBe('left');
    expect(wordBefore(options, 'left')).toBe('bottom');
  });
});

describe('the previews', () => {
  let mounted: Mounted | undefined;
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
    delete document.documentElement.dataset.motion;
  });

  const frame = (container: HTMLElement): HTMLElement =>
    must(container.querySelector('[data-setting-preview]'), 'the frame');
  const sides = (container: HTMLElement): string[] =>
    [...container.querySelectorAll('.fy-ls-nav')].map(node => node.getAttribute('data-side') ?? '');

  test('every choice key draws, decorative, with its word in the label and one lit part per frame', async () => {
    for (const setting of choices)
      for (const option of setting.options) {
        mounted = await mount(<LayoutPreview setting={setting} value={option.id} />);
        const root = frame(mounted.container);
        expect(root.getAttribute('aria-hidden')).toBe('true');
        expect(root.getAttribute('data-sp-label')).toBe(`${setting.name}: ${option.label}`);
        expect(root.getAttribute('data-sp-value')).toBe(option.id);
        const final = root.querySelector('.fy-sp__layer--after');
        // One highlight per frame: a frame lights the one part its key changes. The second column's `never` draws no
        // column, so its frame has nothing to light.
        for (const each of final?.querySelectorAll('.fy-ls-frame') ?? [])
          expect(each.querySelectorAll('[data-lit]').length).toBeLessThanOrEqual(1);
        // Only a second column that is not drawn leaves a frame with nothing lit.
        const hasColumn = (final?.querySelectorAll('.fy-ls-col').length ?? 0) > 0;
        expect(final?.querySelectorAll('[data-lit]').length).toBeGreaterThanOrEqual(
          setting.path.endsWith('side.show') && !hasColumn ? 0 : 1,
        );
        await mounted.unmount();
        mounted = undefined;
      }
  });

  test('it plays the word before then the word now, and shows only the word now when motion is reduced', async () => {
    const setting = choice('nav.side');
    mounted = await mount(<LayoutPreview setting={setting} value="right" />);
    expect(frame(mounted.container).getAttribute('data-sp-state')).toBe('playing');
    expect(sides(mounted.container)).toEqual(['left', 'right']);
    await mounted.unmount();
    document.documentElement.dataset.motion = 'reduced';
    mounted = await mount(<LayoutPreview setting={setting} value="right" />);
    expect(frame(mounted.container).getAttribute('data-sp-state')).toBe('still');
    expect(sides(mounted.container)).toEqual(['right']);
  });

  test('choosing another word replays from the word that was showing', async () => {
    const setting = choice('nav.side');
    mounted = await mount(<LayoutPreview setting={setting} value="left" />);
    expect(sides(mounted.container)).toEqual(['bottom', 'left']);
    await mounted.render(<LayoutPreview setting={setting} value="top" />);
    await interact(() => undefined);
    expect(sides(mounted.container)).toEqual(['left', 'top']);
  });

  test('a pair of frames is drawn for the second column on a wide screen', async () => {
    mounted = await mount(<LayoutPreview setting={choice('side.show')} value="wide-only" />);
    const after = must(mounted.container.querySelector('.fy-sp__layer--after'), 'the final layer');
    expect(after.querySelectorAll('.fy-ls-frame').length).toBe(2);
    expect(after.querySelectorAll('.fy-ls-col').length).toBe(1);
  });

  test('the navigation list draws five rows in their final order, the lifted one lit, one dimmed', async () => {
    mounted = await mount(<NavListPreview items={['ferrets', 'agenda', 'board', 'projects']} label="Items" />);
    const rows = [...mounted.container.querySelectorAll('.fy-ls-nrow')].map(node => node.getAttribute('data-role'));
    expect(rows).toEqual(['still', 'shift', 'shift', 'lift', 'hide']);
    expect(frame(mounted.container).getAttribute('data-sp-label')).toBe('Items');
  });

  test('the navigation list is one still frame when motion is reduced', async () => {
    document.documentElement.dataset.motion = 'reduced';
    mounted = await mount(<NavListPreview items={[]} label="Items" />);
    expect(frame(mounted.container).getAttribute('data-sp-state')).toBe('still');
    expect(mounted.container.querySelectorAll('.fy-ls-nrow').length).toBe(5);
  });
});
