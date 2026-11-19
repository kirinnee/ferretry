/**
 * The Conversation tab previews: each scene names the effect of the value it shows, plays typed-then-result while
 * motion is on, settles on the result alone when motion is off (the OS query or Settings › Motion), and the settings
 * that host them still hand the radios the same values.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { ChatWidthPreview } from '../../../../../app/composer/previews/chat-width-preview.tsx';
import { EditorStylePreview } from '../../../../../app/composer/previews/editor-style-preview.tsx';
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
    mounted = await mount(<SendKeyPreview device="keyboard" outcome="send" />);
    const frame = frameOf(mounted.container);
    expect(frame.getAttribute('data-sp-label')).toBe('The key sends the message');
    expect(frame.getAttribute('data-sp-state')).toBe('playing');
    expect(layers(mounted.container)).toBe(2);
    expect(mounted.container.querySelector('.fy-cvp-key--press')?.textContent).toBe('↵');
    expect(mounted.container.querySelector('.fy-cvp-bubble')?.textContent).toBe('hi there');
  });

  it('send key: the new-line result grows a second line instead, and a phone calls the key "return"', async () => {
    mounted = await mount(<SendKeyPreview device="phone" outcome="newline" />);
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

  it('editor style: markdown keeps its markers, rich hides them and adds the toolbar, plain is as typed', async () => {
    mounted = await mount(<EditorStylePreview pref="on" />);
    expect(textOf(mounted.container)).toContain('# Plan');
    expect(mounted.container.querySelector('.fy-cvp-tools')).toBeNull();
    await mounted.render(<EditorStylePreview pref="rich" />);
    expect(mounted.container.querySelector('.fy-cvp-tools')).not.toBeNull();
    expect(mounted.container.querySelector('.fy-cvp-h')?.textContent).toBe('Plan');
    await mounted.render(<EditorStylePreview pref="off" />);
    expect(frameOf(mounted.container).getAttribute('data-sp-value')).toBe('off');
    expect(mounted.container.querySelector('.fy-cvp-h')).toBeNull();
  });

  it('suggestions: the ladder types @@, the symbols type :, and skills add a $ row', async () => {
    mounted = await mount(<SuggestionsPreview keys="ladder" skills={false} />);
    expect(mounted.container.querySelector('.fy-cvp-typed')?.textContent).toBe('@@');
    expect(mounted.container.querySelectorAll('.fy-cvp-pop .fy-cvp-row').length).toBe(2);
    await mounted.render(<SuggestionsPreview keys="symbols" skills />);
    expect(mounted.container.querySelector('.fy-cvp-typed')?.textContent).toBe(':');
    expect(mounted.container.querySelectorAll('.fy-cvp-pop .fy-cvp-row').length).toBe(3);
    expect(textOf(mounted.container)).toContain('$');
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
