import { afterEach, describe, expect, test } from 'bun:test';
import { ReadAloudControl } from '../../../app/components/read-aloud.tsx';
import { ReadAloudProvider } from '../../../app/hooks/use-read-aloud.ts';
import { createReadAloud, type ReadAloudController } from '../../../app/lib/voice-chat/read-aloud.ts';
import { createSpeechSynthesisSpeaker } from '../../../app/lib/voice-chat/speech-synthesis.ts';
import { interact, type Mounted, mount, must } from '../../support/app/dom.ts';
import { FakeSynth, FakeUtterance, voice } from '../../support/app/fake-speech.ts';

/**
 * Read aloud on a message row: a labelled button, captions that follow the voice, a polite status that
 * never repeats the reply, and nothing at all where there is nothing to say or no way to say it.
 */

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const setup = (): { synth: FakeSynth; controller: ReadAloudController } => {
  const synth = new FakeSynth([voice('Samantha', 'en-US', { isDefault: true })]);
  const speaker = createSpeechSynthesisSpeaker({ synth, createUtterance: text => new FakeUtterance(text) });
  return { synth, controller: createReadAloud({ speaker, language: () => 'en-US' }) };
};

const REPLY = 'The fix is in. Run the tests next.\n\n```ts\nsecret();\n```';
const button = (root: HTMLElement): HTMLButtonElement =>
  must(root.querySelector<HTMLButtonElement>('.fy-read-aloud-button'), 'the Read aloud button');
const status = (root: HTMLElement): string =>
  must(root.querySelector('[role="status"]'), 'the status').textContent ?? '';
const captions = (root: HTMLElement): HTMLElement | null => root.querySelector('[data-read-captions]');

describe('<ReadAloudControl>', () => {
  test('idle: a button with an icon and the words "Read aloud", and an empty status', async () => {
    const { controller } = setup();
    mounted = await mount(
      <ReadAloudProvider controller={controller}>
        <ReadAloudControl entryId="m1" text={REPLY} />
      </ReadAloudProvider>,
    );
    const root = mounted.container;
    expect(button(root).textContent).toBe('Read aloud');
    expect(button(root).querySelector('svg')).not.toBeNull();
    expect(button(root).getAttribute('type')).toBe('button');
    expect(status(root)).toBe('');
    expect(captions(root)).toBeNull();
  });

  test('reading: Stop in words, a "Reading" status without the reply, captions with the current sentence marked', async () => {
    const { controller, synth } = setup();
    mounted = await mount(
      <ReadAloudProvider controller={controller}>
        <ReadAloudControl entryId="m1" text={REPLY} />
      </ReadAloudProvider>,
    );
    const root = mounted.container;
    const focus = button(root);
    focus.focus();
    await interact(() => focus.click());
    // The same element, relabelled: keyboard focus is not lost.
    expect(button(root)).toBe(focus);
    expect(document.activeElement).toBe(focus);
    expect(focus.textContent).toBe('Stop');
    expect(status(root)).toBe('Reading');
    expect(status(root)).not.toContain('fix');

    expect(captions(root)?.getAttribute('aria-hidden')).toBe('true');
    const lines = [...root.querySelectorAll('.fy-read-caption')].map(node => node.textContent?.trim());
    expect(lines).toEqual([
      'The fix is in.',
      'Run the tests next.',
      "Code block, 1 line of TypeScript. It's on screen.",
    ]);
    expect(captions(root)?.textContent).not.toContain('secret');
    // A sentence carries no trailing space of its own, so a marked one never highlights past its last word.
    for (const node of root.querySelectorAll('.fy-read-caption'))
      expect(node.textContent).toBe(node.textContent?.trim());
    expect(root.querySelector('.fy-read-aloud-note')).toBeNull();

    await interact(() => synth.start());
    expect(root.querySelector('[data-current]')?.textContent?.trim()).toBe('The fix is in.');
    await interact(() => synth.finish());
    await interact(() => synth.start());
    expect(root.querySelector('[data-current]')?.textContent?.trim()).toBe('Run the tests next.');
  });

  test('Stop says "Stopped", keeps the words short, and the captions go away', async () => {
    const { controller, synth } = setup();
    mounted = await mount(
      <ReadAloudProvider controller={controller}>
        <ReadAloudControl entryId="m1" text={REPLY} />
      </ReadAloudProvider>,
    );
    const root = mounted.container;
    await interact(() => button(root).click());
    await interact(() => button(root).click());
    expect(button(root).textContent).toBe('Read aloud');
    expect(status(root)).toBe('Stopped');
    expect(root.querySelector('.fy-read-aloud-state')?.textContent).toBe('Stopped');
    expect(captions(root)).toBeNull();
    expect(synth.queue).toEqual([]);
  });

  test('finishing says "Finished"', async () => {
    const { controller, synth } = setup();
    mounted = await mount(
      <ReadAloudProvider controller={controller}>
        <ReadAloudControl entryId="m1" text="Just one thing." />
      </ReadAloudProvider>,
    );
    const root = mounted.container;
    await interact(() => button(root).click());
    await interact(() => synth.play());
    expect(status(root)).toBe('Finished');
    expect(button(root).textContent).toBe('Read aloud');
  });

  test('only the message being read shows reading; reading another moves it', async () => {
    const { controller } = setup();
    mounted = await mount(
      <ReadAloudProvider controller={controller}>
        <div id="one">
          <ReadAloudControl entryId="m1" text="First message." />
        </div>
        <div id="two">
          <ReadAloudControl entryId="m2" text="Second message." />
        </div>
      </ReadAloudProvider>,
    );
    const root = mounted.container;
    const one = must(root.querySelector<HTMLElement>('#one'), 'row one');
    const two = must(root.querySelector<HTMLElement>('#two'), 'row two');
    await interact(() => button(one).click());
    expect(button(one).textContent).toBe('Stop');
    expect(button(two).textContent).toBe('Read aloud');
    await interact(() => button(two).click());
    expect(button(one).textContent).toBe('Read aloud');
    expect(status(one)).toBe('');
    expect(button(two).textContent).toBe('Stop');
  });

  test('with only a remote voice the row says in words that reading is unavailable, and speaks nothing', async () => {
    const synth = new FakeSynth([voice('Google US English', 'en-US', { local: false })]);
    const speaker = createSpeechSynthesisSpeaker({ synth, createUtterance: text => new FakeUtterance(text) });
    const controller = createReadAloud({ speaker, language: () => 'en-US' });
    mounted = await mount(
      <ReadAloudProvider controller={controller}>
        <ReadAloudControl entryId="m1" text="Hello there." />
      </ReadAloudProvider>,
    );
    await interact(() => button(mounted?.container as HTMLElement).click());
    expect(mounted.container.textContent).toContain('No on-device voice, reading unavailable');
    expect(mounted.container.querySelector('[role="status"]')?.textContent).toBe(
      'No on-device voice, reading unavailable',
    );
    expect(button(mounted.container).textContent).toBe('Read aloud');
    expect(synth.spoken).toEqual([]);
  });

  test('a remote voice the person picked is warned about BEFORE Read aloud is pressed, and while reading', async () => {
    const remote = voice('Google US English', 'en-US', { local: false });
    const synth = new FakeSynth([remote]);
    const speaker = createSpeechSynthesisSpeaker({ synth, createUtterance: text => new FakeUtterance(text) });
    const controller = createReadAloud({ speaker, language: () => 'en-US', pickedVoice: () => remote.voiceURI });
    mounted = await mount(
      <ReadAloudProvider controller={controller}>
        <ReadAloudControl entryId="m1" text="Hello there." />
      </ReadAloudProvider>,
    );
    const root = mounted.container;
    const warning = (): Element => must(root.querySelector('.fy-read-aloud-note'), 'the voice warning');
    // Before anything is pressed: words and an icon, in the page, not only in a live region.
    expect(button(root).textContent).toBe('Read aloud');
    expect(warning().textContent).toBe('Google US English sends text to Google to be spoken.');
    expect(warning().querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(warning().hasAttribute('data-voice-warning')).toBe(true);
    expect(status(root)).toBe('');
    await interact(() => button(root).click());
    expect(button(root).textContent).toBe('Stop');
    expect(warning().textContent).toBe('Google US English sends text to Google to be spoken.');
    await interact(() => button(root).click());
    // Stopped: the next press would send it again, so it still says so.
    expect(button(root).textContent).toBe('Read aloud');
    expect(warning().textContent).toContain('sends text to Google');
  });

  test('a device voice shows no warning, before or while reading', async () => {
    const { controller } = setup();
    mounted = await mount(
      <ReadAloudProvider controller={controller}>
        <ReadAloudControl entryId="m1" text="Hello there." />
      </ReadAloudProvider>,
    );
    const root = mounted.container;
    expect(root.querySelector('[data-voice-warning]')).toBeNull();
    await interact(() => button(root).click());
    expect(root.querySelector('[data-voice-warning]')).toBeNull();
  });

  test('renders nothing where the device cannot speak, or the message has nothing to say', async () => {
    const none = createReadAloud({
      speaker: createSpeechSynthesisSpeaker({ synth: null, createUtterance: text => new FakeUtterance(text) }),
    });
    mounted = await mount(
      <ReadAloudProvider controller={none}>
        <ReadAloudControl entryId="m1" text="Hello." />
      </ReadAloudProvider>,
    );
    expect(mounted.container.querySelector('.fy-read-aloud')).toBeNull();
    await mounted.unmount();

    const { controller } = setup();
    mounted = await mount(
      <ReadAloudProvider controller={controller}>
        <ReadAloudControl entryId="m1" text="  <div></div> " />
      </ReadAloudProvider>,
    );
    expect(mounted.container.querySelector('.fy-read-aloud')).toBeNull();
  });

  /** Read REPLY with the layout faked (lines of 30px, the box six lines high) and answer where the box was told to scroll. */
  const scrolledTo = async (reducedMotion: boolean): Promise<unknown[]> => {
    const proto = HTMLElement.prototype as { getClientRects: () => unknown };
    const original = proto.getClientRects;
    const originalMatch = window.matchMedia;
    const originalStyle = window.getComputedStyle;
    const scrolls: unknown[] = [];
    try {
      window.matchMedia = ((query: string) => ({
        matches: reducedMotion && query.includes('reduce'),
      })) as typeof window.matchMedia;
      const { controller, synth } = setup();
      mounted = await mount(
        <ReadAloudProvider controller={controller}>
          <ReadAloudControl entryId="m1" text={REPLY} />
        </ReadAloudProvider>,
      );
      const root = mounted.container;
      await interact(() => button(root).click());
      // No layout here yet: nothing to measure, so nothing scrolls and nothing throws.
      await interact(() => synth.start());
      expect(scrolls).toEqual([]);
      const box = must(root.querySelector<HTMLElement>('.fy-read-captions-scroll'), 'the scrolling part');
      Object.defineProperty(box, 'clientHeight', { value: 180 });
      Object.defineProperty(box, 'scrollHeight', { value: 360 });
      box.scrollTo = ((options: unknown) => scrolls.push(options)) as typeof box.scrollTo;
      // Lines are 30px; the first sentences are on line 1, the third on line 8.
      proto.getClientRects = function (this: HTMLElement) {
        const top = this.textContent?.includes('Code block') ? 210 : 0;
        return [{ top, bottom: top + 30 }];
      };
      window.getComputedStyle = (() => ({ lineHeight: '30px' })) as unknown as typeof window.getComputedStyle;
      await interact(() => synth.finish());
      await interact(() => synth.start());
      await interact(() => synth.finish());
      await interact(() => synth.start());
      expect(root.querySelector('[data-current]')?.textContent).toContain('Code block');
      return scrolls;
    } finally {
      proto.getClientRects = original;
      window.matchMedia = originalMatch;
      window.getComputedStyle = originalStyle;
    }
  };

  test('rests the captions on a whole line: the sentence being read is scrolled to by lines, smoothly', async () => {
    // A line of context before line 8 is line 7, which is 6 lines of 30px down.
    expect((await scrolledTo(false)).at(-1)).toEqual({ top: 180, behavior: 'smooth' });
  });

  test('with reduced motion the captions jump rather than glide', async () => {
    expect((await scrolledTo(true)).at(-1)).toEqual({ top: 180, behavior: 'auto' });
  });
});
