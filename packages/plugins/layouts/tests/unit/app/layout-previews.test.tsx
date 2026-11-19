/**
 * The layout previews: every choice key draws a scene whose one lit part is the thing it changes, the loop plays "the word
 * before → the word now" and shows only the final frame when motion is off, a replay follows a new choice, and the
 * navigation list draws five rows in their final order.
 */
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { afterEach, describe, expect, test } from 'bun:test';
import { LayoutPreview } from '../../../app/features/layout/previews/layout-preview.tsx';
import { NavListPreview } from '../../../app/features/layout/previews/nav-list-preview.tsx';
import { captionFor, stateFor, wordBefore } from '../../../app/features/layout/previews/scene.ts';
import { type ChoiceSetting, LAYOUT_SETTINGS } from '../../../app/lib/layout-model.ts';

const choices = LAYOUT_SETTINGS.filter((setting): setting is ChoiceSetting => setting.kind === 'choice');
const choice = (path: ChoiceSetting['path']): ChoiceSetting =>
  must(
    choices.find(setting => setting.path === path),
    path,
  );

describe('the scene for a layout key', () => {
  test('left draws the one left drawer, as the shell does; bottom adds the bar of places; the unoffered words draw the same as left', () => {
    const left = stateFor('nav.side', 'left');
    expect(left).toMatchObject({ drawer: 'rail', bottom: false, lit: 'nav', column: false, device: 'wide' });
    expect(stateFor('nav.side', 'right')).toEqual(left);
    expect(stateFor('nav.side', 'top')).toEqual(left);
    expect(stateFor('nav.side', 'bottom')).toMatchObject({ drawer: 'rail', bottom: true, lit: 'nav' });
  });

  test('a rail starts the drawer as icons; list draws it open, and so does the unoffered bar', () => {
    expect(stateFor('nav.style', 'rail')).toMatchObject({ drawer: 'rail', bottom: false, lit: 'nav' });
    expect(stateFor('nav.style', 'bar')).toMatchObject({ drawer: 'open', bottom: false, lit: 'nav' });
    expect(stateFor('nav.style', 'list')).toEqual(stateFor('nav.style', 'bar'));
  });

  test('a phone has no drawer on screen: its style draws one frame, and only bottom adds the bar', () => {
    for (const word of ['rail', 'bar', 'list'])
      expect(stateFor('phone.nav.style', word)).toEqual(stateFor('phone.nav.style', 'rail'));
    expect(stateFor('phone.nav.style', 'list')).toMatchObject({ device: 'phone', drawer: 'none', bottom: false });
    expect(stateFor('phone.nav.side', 'right')).toEqual(stateFor('phone.nav.side', 'left'));
    expect(stateFor('phone.nav.side', 'bottom')).toMatchObject({ drawer: 'none', bottom: true, device: 'phone' });
  });

  test('a caption says so where a word draws nothing new, and only there', () => {
    expect(captionFor('nav.side', 'left')).toBeUndefined();
    expect(captionFor('nav.side', 'bottom')).toBeUndefined();
    expect(captionFor('nav.style', 'list')).toBeUndefined();
    expect(captionFor('nav.style', 'rail')).toBeUndefined();
    expect(captionFor('phone.nav.style', 'rail')).toContain('phone');
    expect(captionFor('density', 'compact')).toBeUndefined();
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
    expect(stateFor('nav.side', 'sideways')).toMatchObject({ drawer: 'rail', bottom: false });
  });

  test('the loop starts from the word before, wrapping round', () => {
    const options = choice('nav.side').options;
    expect(wordBefore(options, 'bottom')).toBe('left');
    expect(wordBefore(options, 'left')).toBe('bottom');
    expect(wordBefore(options, 'right')).toBe('bottom');
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
  /** What each layer draws of the menu, in layer order: the drawer's form and whether the bar of places is there. */
  const menus = (container: HTMLElement): string[] =>
    [...container.querySelectorAll('.fy-ls-scene')].map(
      scene =>
        `${scene.querySelector('.fy-ls-drawer')?.getAttribute('data-form') ?? 'none'}${scene.querySelector('.fy-ls-bottom') === null ? '' : '+bottom'}`,
    );
  const caption = (container: HTMLElement): string | undefined =>
    container.querySelector('[data-ls-caption]')?.textContent ?? undefined;

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
    mounted = await mount(<LayoutPreview setting={setting} value="bottom" />);
    expect(frame(mounted.container).getAttribute('data-sp-state')).toBe('playing');
    // The word before (top, the same as left) then the word now (the bar of places is added).
    expect(menus(mounted.container)).toEqual(['rail', 'rail+bottom']);
    await mounted.unmount();
    document.documentElement.dataset.motion = 'reduced';
    mounted = await mount(<LayoutPreview setting={setting} value="bottom" />);
    expect(frame(mounted.container).getAttribute('data-sp-state')).toBe('still');
    expect(menus(mounted.container)).toEqual(['rail+bottom']);
  });

  test('choosing another word replays from the word that was showing', async () => {
    const setting = choice('nav.side');
    mounted = await mount(<LayoutPreview setting={setting} value="left" />);
    expect(menus(mounted.container)).toEqual(['rail+bottom', 'rail']);
    await mounted.render(<LayoutPreview setting={setting} value="bottom" />);
    await interact(() => undefined);
    expect(menus(mounted.container)).toEqual(['rail', 'rail+bottom']);
  });

  test('a word that draws nothing new on a phone says so under its frame, and no other does', async () => {
    mounted = await mount(<LayoutPreview setting={choice('phone.nav.style')} value="list" />);
    expect(caption(mounted.container)).toContain('No visible change on a phone');
    expect(frame(mounted.container).getAttribute('aria-hidden')).toBe('true');
    await mounted.unmount();
    mounted = await mount(<LayoutPreview setting={choice('nav.side')} value="left" />);
    expect(caption(mounted.container)).toBeUndefined();
  });

  test('a phone frame draws a menu button where a wide one draws its drawer', async () => {
    mounted = await mount(<LayoutPreview setting={choice('phone.nav.side')} value="bottom" />);
    const after = must(mounted.container.querySelector('.fy-sp__layer--after'), 'the final layer');
    expect(after.querySelectorAll('.fy-ls-drawer').length).toBe(0);
    expect(after.querySelectorAll('.fy-ls-menu').length).toBe(1);
    expect(after.querySelectorAll('.fy-ls-bottom').length).toBe(1);
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
