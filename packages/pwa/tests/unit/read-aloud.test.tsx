import { afterEach, describe, expect, test } from 'bun:test';
import { ReadAloudControl } from '../../src/components/read-aloud.tsx';
import { TranscriptTextRow } from '../../src/components/transcript-row.tsx';
import { ReadAloudProvider } from '../../src/hooks/use-read-aloud.ts';
import { createReadAloud, type ReadAloudController } from '../../src/lib/voice-chat/read-aloud.ts';
import { createSpeechSynthesisSpeaker } from '../../src/lib/voice-chat/speech-synthesis.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { FakeSynth, FakeUtterance, voice } from '../support/fake-speech.ts';

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

  test('a voice that sends text away is named on the row', async () => {
    const synth = new FakeSynth([voice('Google US English', 'en-US', { local: false })]);
    const speaker = createSpeechSynthesisSpeaker({ synth, createUtterance: text => new FakeUtterance(text) });
    const controller = createReadAloud({ speaker, language: () => 'en-US' });
    mounted = await mount(
      <ReadAloudProvider controller={controller}>
        <ReadAloudControl entryId="m1" text="Hello there." />
      </ReadAloudProvider>,
    );
    await interact(() => button(mounted?.container as HTMLElement).click());
    expect(mounted.container.querySelector('.fy-read-aloud-note')?.textContent).toContain('sends this text');
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

  test('scrolls the sentence being read into view, smoothly unless motion is reduced', async () => {
    const calls: unknown[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, options?: unknown) {
      calls.push([this.textContent?.trim(), options]);
    };
    const originalMatch = window.matchMedia;
    try {
      const { controller, synth } = setup();
      mounted = await mount(
        <ReadAloudProvider controller={controller}>
          <ReadAloudControl entryId="m1" text={REPLY} />
        </ReadAloudProvider>,
      );
      await interact(() => button(mounted?.container as HTMLElement).click());
      expect(calls[0]).toEqual(['The fix is in.', { block: 'nearest', behavior: 'smooth' }]);
      window.matchMedia = ((query: string) => ({ matches: query.includes('reduce') })) as typeof window.matchMedia;
      await interact(() => synth.start());
      await interact(() => synth.finish());
      await interact(() => synth.start());
      expect(calls.at(-1)).toEqual(['Run the tests next.', { block: 'nearest', behavior: 'auto' }]);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
      window.matchMedia = originalMatch;
    }
  });
});

describe('an assistant row', () => {
  const entry = {
    id: 'a1',
    kind: 'assistant',
    text: 'Hello. All done.',
    at: Date.parse('2026-01-02T03:04:00.000Z'),
  } as const;

  test('carries the control, and a user or tool row does not', async () => {
    const { controller } = setup();
    mounted = await mount(
      <ReadAloudProvider controller={controller}>
        <TranscriptTextRow entry={entry} rhythm={{}} />
        <TranscriptTextRow entry={{ ...entry, id: 'u1', kind: 'notice' }} rhythm={{}} />
      </ReadAloudProvider>,
    );
    expect(mounted.container.querySelectorAll('.fy-read-aloud')).toHaveLength(1);
    const article = must(mounted.container.querySelector('article.fy-message-assistant'), 'the assistant row');
    expect(article.querySelector('.fy-read-aloud-button')?.textContent).toBe('Read aloud');
  });

  test('a row drawn with its own body has none', async () => {
    const { controller } = setup();
    mounted = await mount(
      <ReadAloudProvider controller={controller}>
        <TranscriptTextRow body={<p>custom</p>} entry={entry} rhythm={{}} />
      </ReadAloudProvider>,
    );
    expect(mounted.container.querySelector('.fy-read-aloud')).toBeNull();
  });
});
