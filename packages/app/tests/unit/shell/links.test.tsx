import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import { LINK_TAKERS, provideToShell } from '../../../src/connect/provides.ts';
import { ExternalLink, useLinkBehaviour } from '../../../src/ui/external-link.tsx';
import { interact, type Mounted } from '../../support/dom.ts';
import { bootApp, entryOf, manifestOf, settle } from './frame-fixtures.tsx';

/**
 * WHERE A LINK OPENS, PER MACHINE (shell contract S7): Browsers provides `shell.links`, built per daemon; a link drawn in
 * machine B's view is labelled and opened for B, a daemon-less screen says "this device's browser", and a provided sheet is
 * drawn once per machine at the frame root.
 */

const activations: { daemon: string; href: string }[] = [];
const sawLinks: { daemon: string }[] = [];
/** What Browsers provides: a proper provision, or something that is not one. */
const provided = { broken: false };

const chatManifest = manifestOf('chat', {
  ui: {
    screens: [
      { id: 'chat', path: 'chat' },
      { id: 'land', path: '/land', daemonless: true },
    ],
  },
});
function Links(): ReactNode {
  return (
    <div>
      <ExternalLink href="https://example.com/one">one</ExternalLink>
      <ExternalLink href="https://example.com/two">two</ExternalLink>
      <ExternalLink href="https://example.com/three" title="mine">
        three
      </ExternalLink>
      <ExternalLink href={undefined}>none</ExternalLink>
    </div>
  );
}
const chat = entryOf(
  chatManifest,
  provideToShell(implementApp(chatManifest, { build: () => ({ screens: { chat: Links, land: () => null } }) }), {
    daemonless: () => ({ land: Links }),
  }),
);

const browsersManifest = manifestOf('browsers', { ui: { screens: [] } });
const browsers = entryOf(
  browsersManifest,
  provideToShell(implementApp(browsersManifest, { build: () => ({}) }), {
    links: ({ daemon }) => {
      sawLinks.push({ daemon });
      if (provided.broken) return {} as never;
      return {
        activate: (click, target) => {
          activations.push({ daemon, href: target.href ?? '' });
          click.preventDefault();
          return true;
        },
        open: () => {},
        sheet: <p data-testid={`sheet-${daemon}`}>sheet of {daemon}</p>,
        destination: () => (daemon === 'd2' ? 'in-app' : 'computer'),
      };
    },
  }),
);

/** A plugin that is not Browsers and still provides `links`: it is ignored. */
const impostorManifest = manifestOf('impostor', { ui: { screens: [] } });
const impostor = entryOf(
  impostorManifest,
  provideToShell(implementApp(impostorManifest, { build: () => ({}) }), {
    links: () => ({
      activate: () => true,
      open: () => {},
      sheet: <p>impostor sheet</p>,
      destination: () => 'in-app',
    }),
  }),
);

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  activations.length = 0;
  sawLinks.length = 0;
  provided.broken = false;
});
const anchor = (text: string): HTMLAnchorElement => {
  const found = [...(view?.container.querySelectorAll('a') ?? [])].find(each => each.textContent === text);
  if (found === undefined) throw new Error(`no link "${text}"`);
  return found as HTMLAnchorElement;
};

describe('the link takers', () => {
  test('shell S7: only Browsers may provide links', () => {
    expect(LINK_TAKERS).toEqual(['browsers']);
  });

  test('shell S7: a provider that is not Browsers is ignored: the link is native and no sheet is drawn', async () => {
    const app = await bootApp({ surfaces: [chat, impostor], machines: ['d1'], path: '/d/d1/chat' });
    view = app.view;
    expect(anchor('one').title).toBe("Opens in this device's browser");
    expect(view.container.textContent).not.toContain('impostor sheet');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    await interact(() => void anchor('one').dispatchEvent(click));
    expect(click.defaultPrevented).toBe(false);
  });
});

describe('without a provider', () => {
  test('shell S7: the link is a real new-tab anchor, native, and says it opens in this device’s browser', async () => {
    const app = await bootApp({ surfaces: [chat], machines: ['d1'], path: '/d/d1/chat' });
    view = app.view;
    const one = anchor('one');
    expect(one.getAttribute('target')).toBe('_blank');
    expect(one.getAttribute('rel')).toBe('noopener noreferrer');
    expect(one.title).toBe("Opens in this device's browser");
    expect(one.getAttribute('aria-description')).toBe("Opens in this device's browser");
    // A link with no address says nothing about where it opens; a caller's own title is kept.
    expect(anchor('none').title).toBe('');
    expect(anchor('three').title).toBe('mine');
  });
});

describe('per machine', () => {
  test('shell S7: two daemons: a link in machine B’s view is labelled and opened for B', async () => {
    const app = await bootApp({ surfaces: [chat, browsers], machines: ['d1', 'd2'], path: '/d/d2/chat' });
    view = app.view;
    expect(anchor('one').title).toBe('Opens in the in-app browser on d2-host');
    await interact(() => anchor('one').click());
    expect(activations).toEqual([{ daemon: 'd2', href: 'https://example.com/one' }]);
    await view.unmount();
    const first = await bootApp({ surfaces: [chat, browsers], machines: ['d1', 'd2'], path: '/d/d1/chat' });
    view = first.view;
    expect(anchor('one').title).toBe('Opens in the browser on your computer');
    await interact(() => anchor('two').click());
    expect(activations.at(-1)).toEqual({ daemon: 'd1', href: 'https://example.com/two' });
  });

  test('shell S7: the destination is announced (aria-description) as well as in the title', async () => {
    const app = await bootApp({ surfaces: [chat, browsers], machines: ['d2'], path: '/d/d2/chat' });
    view = app.view;
    expect(anchor('one').getAttribute('aria-description')).toBe('Opens in the in-app browser on d2-host');
  });

  test('shell S7: one sheet per daemon, drawn at the frame root, not once per link', async () => {
    const app = await bootApp({ surfaces: [chat, browsers], machines: ['d1', 'd2'], path: '/d/d2/chat' });
    view = app.view;
    expect(view.container.querySelectorAll('[data-testid="sheet-d1"]')).toHaveLength(1);
    expect(view.container.querySelectorAll('[data-testid="sheet-d2"]')).toHaveLength(1);
    expect(view.container.querySelectorAll('a')).not.toHaveLength(0);
  });

  test('shell S7: the provider is built per daemon, over Browsers’ own client, once Browsers is allowed there', async () => {
    const app = await bootApp({
      surfaces: [chat, browsers],
      machines: ['d1', 'd2'],
      path: '/d/d2/chat',
      off: { d1: ['browsers'] },
    });
    view = app.view;
    expect([...new Set(sawLinks.map(each => each.daemon))]).toEqual(['d2']);
    expect(view.container.querySelector('[data-testid="sheet-d1"]')).toBeNull();
    expect(view.container.querySelector('[data-testid="sheet-d2"]')).not.toBeNull();
    // Browsers is off on d1: a link in d1's view is the native default there.
    await view.unmount();
    const onD1 = await bootApp({
      surfaces: [chat, browsers],
      machines: ['d1', 'd2'],
      path: '/d/d1/chat',
      off: { d1: ['browsers'] },
    });
    view = onD1.view;
    expect(anchor('one').title).toBe("Opens in this device's browser");
    await onD1.reread('d1');
  });

  test('shell S7: the sheet goes when Browsers is blocked on that machine, and returns when it is allowed', async () => {
    const app = await bootApp({ surfaces: [chat, browsers], machines: ['d1'], path: '/d/d1/chat' });
    view = app.view;
    expect(view.container.querySelector('[data-testid="sheet-d1"]')).not.toBeNull();
    app.machine('d1').off.add('browsers');
    await app.reread('d1');
    expect(view.container.querySelector('[data-testid="sheet-d1"]')).toBeNull();
    expect(anchor('one').title).toBe("Opens in this device's browser");
    app.machine('d1').off.delete('browsers');
    await app.reread('d1');
    expect(view.container.querySelector('[data-testid="sheet-d1"]')).not.toBeNull();
  });
});

describe('a provision that is not one', () => {
  test('shell S7: a provider that returns something without activate, open and destination is ignored: the link is native', async () => {
    provided.broken = true;
    const app = await bootApp({ surfaces: [chat, browsers], machines: ['d1'], path: '/d/d1/chat' });
    view = app.view;
    expect(anchor('one').title).toBe("Opens in this device's browser");
    expect(view.container.querySelector('[data-testid="sheet-d1"]')).toBeNull();
  });
});

describe('a daemon-less screen', () => {
  test('shell S7: says this device’s browser and is never handed a machine’s behaviour', async () => {
    const app = await bootApp({ surfaces: [chat, browsers], machines: ['d1', 'd2'], path: '/land' });
    view = app.view;
    expect(anchor('one').title).toBe("Opens in this device's browser");
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    await interact(() => void anchor('one').dispatchEvent(click));
    expect(click.defaultPrevented).toBe(false);
    expect(activations).toEqual([]);
  });
});

describe('the hook', () => {
  test('shell S7: useLinkBehaviour outside a shell is the native default and says this device’s browser', async () => {
    const { mount } = await import('../../support/dom.ts');
    let seen: ReturnType<typeof useLinkBehaviour> | undefined;
    function Probe(): ReactNode {
      seen = useLinkBehaviour();
      return null;
    }
    const outside = await mount(<Probe />);
    expect(seen?.destination('https://example.com')).toBe('this-device-browser');
    expect(seen?.sheet).toBeNull();
    expect(
      seen?.activate({ defaultPrevented: false, preventDefault: () => {} }, { href: 'x', element: document.body }),
    ).toBe(false);
    // A link with no anchor to carry its click opens a new browser tab, as before.
    const opened: unknown[][] = [];
    const real = globalThis.open;
    globalThis.open = ((...args: unknown[]) => {
      opened.push(args);
      return null;
    }) as typeof globalThis.open;
    seen?.open(
      { defaultPrevented: false, preventDefault: () => {} },
      { href: 'https://example.com/x', element: document.body },
    );
    globalThis.open = real;
    expect(opened).toEqual([['https://example.com/x', '_blank', 'noopener,noreferrer']]);
    await outside.unmount();
    await settle();
  });
});
