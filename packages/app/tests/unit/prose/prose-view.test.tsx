import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp } from '@ferretry/kernel/manifest';
import { type ReactElement, type ReactNode, use } from 'react';
import { PROSE_TAKERS, provideToShell, registeredProse } from '../../../src/connect/provides.ts';
import { ProseView } from '../../../src/prose/prose-view.tsx';
import { ShellContext, type ShellModel } from '../../../src/shell/context.tsx';
import type { Standing } from '../../../src/client/inventory.ts';
import { type ViewPlace, WithViewPlace } from '../../../src/shell/view-place.tsx';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { interact, type Mounted, mount } from '../../support/dom.ts';
import { entryOf, manifestOf } from '../shell/frame-fixtures.tsx';

/**
 * THE ONE PROSE VIEW (`shell.prose`): a surface that draws agent-written text asks the shell, and the shell draws it
 * with what Conversation provides — falling back to the shell's own Markdown while that loads, or when nobody provides
 * it. Only Conversation may provide it (`PROSE_TAKERS`).
 */

const providerOf = (id: string, mark: string): SurfaceEntry => {
  const manifest = manifestOf(id, { ui: { screens: [] } });
  return entryOf(
    manifest,
    provideToShell(implementApp(manifest, { build: () => ({}) }), {
      prose: ({ text, className }) => (
        <section data-mark={mark} className={className}>
          {text}
        </section>
      ),
    }),
  );
};

/** What the daemon's inventory says of a package, per plugin id: anything not listed is allowed (the shipped standing). */
type Standings = Readonly<Record<string, Standing>>;
const OFF: Standing = { state: 'blocked', reason: 'off' };

/**
 * The shell, as `ProseView` reads it: the registered surfaces, and this machine's standing for each (a fake of
 * `runtime.standing`, which the real shell answers from the daemon's inventory). The view is drawn for machine `d1`.
 */
const inShell = (surfaces: readonly SurfaceEntry[], child: ReactNode, standings: Standings = {}): ReactElement => {
  const runtime = {
    surfaces,
    standing: (_daemon: string, id: string): Standing => standings[id] ?? { state: 'allowed' },
    subscribe: () => () => undefined,
  };
  return (
    <ShellContext.Provider value={{ runtime } as unknown as ShellModel}>
      <WithViewPlace place={{ daemon: 'd1', machine: 'Durian' } as unknown as ViewPlace}>{child}</WithViewPlace>
    </ShellContext.Provider>
  );
};

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe('shell.prose', () => {
  test('only Conversation may provide it', () => {
    expect(PROSE_TAKERS).toEqual(['conversation']);
    expect(registeredProse([providerOf('impostor', 'impostor')])).toBeUndefined();
    expect(registeredProse([providerOf('conversation', 'conversation')])).toBeDefined();
  });

  test('draws with what Conversation provides, handing it the text and class', async () => {
    view = await mount(
      inShell(
        [providerOf('impostor', 'impostor'), providerOf('conversation', 'conversation')],
        <ProseView className="fy-seg" text="hello" />,
      ),
    );
    const drawn = view.container.querySelector('section');
    expect(drawn?.getAttribute('data-mark')).toBe('conversation');
    expect(drawn?.className).toBe('fy-seg');
    expect(drawn?.textContent).toBe('hello');
  });

  test('draws the shell Markdown when nobody provides it, and outside a shell', async () => {
    view = await mount(inShell([], <ProseView text="**bold** words" />));
    expect(view.container.querySelector('.md strong')?.textContent).toBe('bold');
    await view.unmount();
    view = await mount(<ProseView text="**bold** words" />);
    expect(view.container.querySelector('.md strong')?.textContent).toBe('bold');
  });

  test("draws the shell Markdown when this machine's daemon has Conversation off or blocked, though it is registered", async () => {
    // Conversation's app half stays COMPILED IN when the daemon's inventory turns it off (shell/runtime.ts): the
    // registry still holds it, so only the machine's standing says whether its view may draw here.
    const registered = [providerOf('conversation', 'conversation')];
    const blocked: readonly (readonly [string, Standing])[] = [
      ['off', OFF],
      ['missing', { state: 'blocked', reason: 'missing' }],
      ['core', { state: 'blocked', reason: 'core' }],
      ['unread', { state: 'blocked', reason: 'unread' }],
    ];
    for (const [name, standing] of blocked) {
      view = await mount(inShell(registered, <ProseView text="**bold** words" />, { conversation: standing }));
      expect(view.container.querySelector('section'), `provided view drawn though ${name}`).toBeNull();
      expect(view.container.querySelector('.md strong')?.textContent, `Markdown fallback when ${name}`).toBe('bold');
      await view.unmount();
    }
    view = await mount(
      inShell(registered, <ProseView text="**bold** words" />, { conversation: { state: 'allowed' } }),
    );
    expect(view.container.querySelector('section')?.getAttribute('data-mark')).toBe('conversation');
  });

  test('draws the shell Markdown on a screen with no machine, where nothing can say Conversation is on', async () => {
    const runtime = { surfaces: [providerOf('conversation', 'conversation')], subscribe: () => () => undefined };
    view = await mount(
      <ShellContext.Provider value={{ runtime } as unknown as ShellModel}>
        <ProseView text="**bold** words" />
      </ShellContext.Provider>,
    );
    expect(view.container.querySelector('section')).toBeNull();
    expect(view.container.querySelector('.md strong')?.textContent).toBe('bold');
  });

  test('draws the Markdown while the provided view loads, then swaps to it', async () => {
    const gate = Promise.withResolvers<void>();
    const manifest = manifestOf('conversation', { ui: { screens: [] } });
    const late = provideToShell(implementApp(manifest, { build: () => ({}) }), {
      prose: function Late({ text }) {
        use(gate.promise);
        return <i data-done="">{text}</i>;
      },
    });
    view = await mount(inShell([entryOf(manifest, late)], <ProseView text="**soon**" />));
    expect(view.container.querySelector('.md strong')?.textContent).toBe('soon');
    expect(view.container.querySelector('[data-done]')).toBeNull();
    await interact(() => gate.resolve());
    await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
    expect(view.container.querySelector('[data-done]')?.textContent).toBe('**soon**');
    expect(view.container.querySelector('.md')).toBeNull();
  });
});
