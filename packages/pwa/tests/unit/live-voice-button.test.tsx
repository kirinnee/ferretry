import { describe, expect, it } from 'bun:test';
import { LiveVoiceButton } from '../../src/components/live-voice-button.tsx';
import { interact, mount, must } from '../support/dom.ts';

describe('<LiveVoiceButton>', () => {
  it('is the 44 px icon-only square in the mobile column, named Live voice, and starts Live on press', async () => {
    let pressed = 0;
    const view = await mount(<LiveVoiceButton layout="compact" active={false} onPress={() => pressed++} />);
    const button = must(view.container.querySelector('button'), 'the Live button');
    expect(button.getAttribute('aria-label')).toBe('Live voice');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('title')).toBe('Start Live voice');
    expect(button.textContent).toBe('');
    expect(button.className).toContain('min-h-[44px]');
    expect(button.className).not.toContain('text-accent');
    await interact(() => button.click());
    expect(pressed).toBe(1);
    await view.unmount();
  });

  it('shows the word in the desktop row, says it is on, and puts the chord in the tooltip', async () => {
    const view = await mount(<LiveVoiceButton layout="full" active onPress={() => undefined} shortcutHint="⌥L" />);
    const button = must(view.container.querySelector('button'), 'the Live button');
    expect(button.textContent).toBe('Live');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('title')).toBe('End Live voice (⌥L)');
    expect(button.className).toContain('text-accent');
    await view.unmount();
  });

  it('cannot be pressed while disabled', async () => {
    let pressed = 0;
    const view = await mount(<LiveVoiceButton layout="compact" active={false} disabled onPress={() => pressed++} />);
    const button = must(view.container.querySelector('button'), 'the Live button');
    expect(button.disabled).toBe(true);
    await interact(() => button.click());
    expect(pressed).toBe(0);
    await view.unmount();
  });
});
