/**
 * The Conversation tab previews: each scene names the effect of the value it shows, plays typed-then-result while
 * motion is on (once, when the value changes), settles on the result alone when motion is off (the OS query or Settings › Motion), and the settings
 * that host them still hand the radios the same values.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { ChatWidthPreview } from '../../../../../app/composer/previews/chat-width-preview.tsx';
import { DockLayoutSample } from '../../../../../app/composer/previews/dock-layout-sample.tsx';
import { EditorStyleSample } from '../../../../../app/composer/previews/editor-style-preview.tsx';
import { SendKeyPreview } from '../../../../../app/composer/previews/send-key-preview.tsx';
import { SuggestionsPreview } from '../../../../../app/composer/previews/suggestions-preview.tsx';
import { ComposerEnterKeySettings } from '../../../../../app/composer/composer-enter-key-settings.tsx';
import { ComposerSuggestionsSettings } from '../../../../../app/composer/composer-suggestions-settings.tsx';

const frameOf = (container: HTMLElement): HTMLElement =>
  must(container.querySelector('[data-setting-preview]'), 'the frame');
const layers = (container: HTMLElement): number => container.querySelectorAll('.fy-sp__layer').length;
const textOf = (container: HTMLElement): string => container.textContent ?? '';

describe('Conversation previews', () => {
  let mounted: Mounted | undefined;
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
    delete document.documentElement.dataset.motion;
  });

  it('send key: types "hi there", then shows the message sent when the key sends', async () => {
    mounted = await mount(<SendKeyPreview device="keyboard" outcome="newline" />);
    expect(frameOf(mounted.container).getAttribute('data-sp-state')).toBe('still');
    await mounted.render(<SendKeyPreview device="keyboard" outcome="send" />);
    const frame = frameOf(mounted.container);
    expect(frame.getAttribute('data-sp-label')).toBe('The key sends the message');
    expect(frame.getAttribute('data-sp-state')).toBe('playing');
    expect(layers(mounted.container)).toBe(2);
    expect(mounted.container.querySelector('.fy-cvp-key--press')?.textContent).toBe('↵');
    expect(mounted.container.querySelector('.fy-cvp-bubble')?.textContent).toBe('hi there');
  });

  it('send key: the new-line result grows a second line instead, and a phone calls the key "return"', async () => {
    mounted = await mount(<SendKeyPreview device="phone" outcome="send" />);
    await mounted.render(<SendKeyPreview device="phone" outcome="newline" />);
    expect(frameOf(mounted.container).getAttribute('data-sp-label')).toBe('The key starts a new line');
    expect(mounted.container.querySelector('.fy-cvp-bubble')).toBeNull();
    expect(mounted.container.querySelector('.fy-cvp-typed--late')?.textContent).toBe('and then');
    expect(mounted.container.querySelector('.fy-cvp-key--press')?.textContent).toBe('return');
  });

  it('send key: with motion reduced only the result is drawn, nothing typed', async () => {
    document.documentElement.dataset.motion = 'reduced';
    mounted = await mount(<SendKeyPreview device="keyboard" outcome="send" />);
    expect(frameOf(mounted.container).getAttribute('data-sp-state')).toBe('still');
    expect(layers(mounted.container)).toBe(1);
    expect(mounted.container.querySelector('.fy-cvp-key--press')).toBeNull();
    expect(mounted.container.querySelector('.fy-cvp-bubble')).not.toBeNull();
  });

  it('editor style sample: markdown keeps its markers, rich hides them and adds the toolbar, plain is as typed', async () => {
    mounted = await mount(<EditorStyleSample pref="on" />);
    expect(textOf(mounted.container)).toContain('# Plan');
    expect(mounted.container.querySelector('.fy-cvp-tools')).toBeNull();
    await mounted.render(<EditorStyleSample pref="rich" />);
    expect(mounted.container.querySelector('.fy-cvp-tools')).not.toBeNull();
    expect(mounted.container.querySelector('.fy-cvp-h')?.textContent).toBe('Plan');
    await mounted.render(<EditorStyleSample pref="off" />);
    expect(mounted.container.querySelector('.fy-cvp-h')).toBeNull();
    // The one shared box: fixed shape, decorative, and not a second setting preview frame.
    const box = must(mounted.container.querySelector('[data-choice-sample]'), 'the sample box');
    expect(box.getAttribute('aria-hidden')).toBe('true');
    expect((box as HTMLElement).style.aspectRatio).toBe('160 / 100');
    expect(mounted.container.querySelector('[data-setting-preview]')).toBeNull();
  });

  it('button layout sample: the real phone composer, laid out by the attributes the composer stamps', async () => {
    const attributes = (container: HTMLElement) =>
      [...container.querySelectorAll('.fy-composer')].map(composer => [
        composer.getAttribute('data-composer-layout'),
        composer.getAttribute('data-composer-dock-layout'),
        composer.hasAttribute('data-composer-empty'),
      ]);
    mounted = await mount(<DockLayoutSample layout="stacked" />);
    expect(attributes(mounted.container)).toEqual([['phone', 'stacked', true]]);
    expect(mounted.container.querySelectorAll('.fy-composer-dock').length).toBe(2);
    expect(mounted.container.querySelector('.fy-composer-send')).not.toBeNull();
    await mounted.render(<DockLayoutSample layout="row" />);
    expect(attributes(mounted.container)).toEqual([['phone', 'row', true]]);
    // Auto draws both looks, one above the other: empty (side by side), then typed (stacked).
    await mounted.render(<DockLayoutSample layout="auto" />);
    expect(attributes(mounted.container)).toEqual([
      ['phone', 'auto', true],
      ['phone', 'auto', false],
    ]);
    expect(mounted.container.querySelector('.fy-dls__half--typed')).not.toBeNull();
    expect(
      (must(mounted.container.querySelector('[data-choice-sample]'), 'box') as HTMLElement).style.aspectRatio,
    ).toBe('300 / 120');
  });

  it('suggestions: the ladder types @@, the symbols type :, and skills open their OWN menu rather than a row in the agents one', async () => {
    mounted = await mount(<SuggestionsPreview keys="ladder" skills={false} />);
    expect(mounted.container.querySelector('.fy-cvp-typed')?.textContent).toBe('@@');
    expect(mounted.container.querySelectorAll('.fy-cvp-pop').length).toBe(1);
    expect(mounted.container.querySelectorAll('.fy-cvp-pop .fy-cvp-row').length).toBe(2);
    expect(textOf(mounted.container)).not.toContain('$');
    await mounted.render(<SuggestionsPreview keys="symbols" skills />);
    expect(mounted.container.querySelector('.fy-cvp-typed')?.textContent).toBe(':');
    const menus = [...mounted.container.querySelectorAll('.fy-cvp-pop')];
    expect(menus.map(menu => menu.querySelector('.fy-cvp-pop-title')?.textContent)).toEqual(['Agents', 'Skills']);
    expect(menus.map(menu => menu.querySelectorAll('.fy-cvp-row').length)).toEqual([2, 2]);
    expect(menus[0]?.textContent).not.toContain('$');
    expect(menus[1]?.textContent).toContain('$');
    expect(mounted.container.querySelector('.fy-cvp-typed--skill')?.textContent).toBe('$');
  });

  it('chat width: the column keeps its marker and width class, writes while motion is on, and rests when it is off', async () => {
    mounted = await mount(<ChatWidthPreview value="balanced" />);
    const column = must(mounted.container.querySelector('[data-chat-width-preview]'), 'the column');
    expect(column.getAttribute('data-chat-width-preview')).toBe('balanced');
    expect(column.className).toContain('w-3/4');
    expect(column.className).toContain('transition-[width]');
    expect(mounted.container.querySelector('[data-cvp-motion]')?.getAttribute('data-cvp-motion')).toBe('on');
    await interact(() => {
      document.documentElement.dataset.motion = 'reduced';
    });
    await interact(() => undefined);
    expect(mounted.container.querySelector('[data-cvp-motion]')?.getAttribute('data-cvp-motion')).toBe('still');
    expect(column.className).not.toContain('transition-[width]');
    expect(mounted.container.querySelectorAll('.fy-cvp-write').length).toBe(3);
  });

  it('chat width: rests written on mount and writes its lines once for each width chosen', async () => {
    mounted = await mount(<ChatWidthPreview value="balanced" />);
    const strip = () => must(mounted?.container.querySelector('[data-cvp-motion]'), 'the strip');
    expect(strip().getAttribute('data-cvp-write')).toBe('rest');
    const first = mounted.container.querySelector('.fy-cvp-write');
    await mounted.render(<ChatWidthPreview value="readable" />);
    expect(strip().getAttribute('data-cvp-write')).toBe('play');
    // A new choice restarts the write: the lines are new elements, so the one animation begins again.
    expect(mounted.container.querySelector('.fy-cvp-write')).not.toBe(first);
    // Choosing the same value again changes nothing.
    const second = mounted.container.querySelector('.fy-cvp-write');
    await mounted.render(<ChatWidthPreview value="readable" />);
    expect(mounted.container.querySelector('.fy-cvp-write')).toBe(second);
  });

  it('chat width: holds still while the tab is hidden, and plays again when it returns', async () => {
    const setVisibility = async (state: 'visible' | 'hidden'): Promise<void> => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      await interact(() => document.dispatchEvent(new Event('visibilitychange')));
    };
    try {
      mounted = await mount(<ChatWidthPreview value="balanced" />);
      const strip = () => must(mounted?.container.querySelector('[data-cvp-motion]'), 'the strip');
      expect(strip().getAttribute('data-cvp-motion')).toBe('on');
      await setVisibility('hidden');
      expect(strip().getAttribute('data-cvp-motion')).toBe('paused');
      await setVisibility('visible');
      expect(strip().getAttribute('data-cvp-motion')).toBe('on');
      document.documentElement.dataset.motion = 'reduced';
      await setVisibility('hidden');
      expect(strip().getAttribute('data-cvp-motion')).toBe('still');
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
    }
  });

  it('the hosts draw one preview per group and keep their radios', async () => {
    mounted = await mount(<ComposerEnterKeySettings preference={null} phonePreference="send" onChange={() => {}} />);
    const frames = [...mounted.container.querySelectorAll('[data-setting-preview]')];
    expect(frames.map(frame => frame.getAttribute('data-sp-value'))).toEqual(['keyboard-send', 'phone-send']);
    expect(mounted.container.querySelectorAll('input[type="radio"]').length).toBe(4);
    await mounted.render(
      <ComposerSuggestionsSettings
        preferences={{ suggestionKeys: 'both', skillSuggestions: true }}
        onChange={() => {}}
      />,
    );
    expect(frameOf(mounted.container).getAttribute('data-sp-value')).toBe('both-skills');
  });
});
