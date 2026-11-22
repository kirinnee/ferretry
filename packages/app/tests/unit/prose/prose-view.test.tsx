import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp } from '@ferretry/kernel/manifest';
import { type ReactElement, type ReactNode, use } from 'react';
import { PROSE_TAKERS, provideToShell, registeredProse } from '../../../src/connect/provides.ts';
import { ProseView } from '../../../src/prose/prose-view.tsx';
import { ShellContext, type ShellModel } from '../../../src/shell/context.tsx';
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

/** The shell, as `ProseView` reads it: the registered surfaces and nothing else. */
const inShell = (surfaces: readonly SurfaceEntry[], child: ReactNode): ReactElement => (
  <ShellContext.Provider value={{ runtime: { surfaces } } as unknown as ShellModel}>{child}</ShellContext.Provider>
);

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
