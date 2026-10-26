/**
 * Addresses in the Console's read-only capture are real anchors, opened by the same "Open links in"
 * decision as a chat link. The capture's text is untouched, so what is copied is what was captured.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { TerminalSnapshotView } from '../../src/components/terminal-snapshot.tsx';
import { LinkBehaviourProvider, type LinkOpener } from '../../src/features/browser/external-link.tsx';
import type { OpenLinksIn } from '../../src/lib/controls.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { interact, mount, must } from '../support/dom.ts';

const daemon = daemonConnection({ daemonId: 'pane-daemon', baseUrl: 'https://pane.example.test', deviceId: 'token' });
const scope = daemonSessionScope(daemon, 'pane-session');
const CAPTURE = 'Listening on https://app.example.test:8443/dev, docs at (http://docs.example.test/x).\nbye';

const fakeOpener = () => {
  const tabs: string[] = [];
  const opener: LinkOpener = {
    iosStandalone: () => false,
    handOff: () => {},
    openTab: href => void tabs.push(href),
    unlessLeft: () => () => {},
  };
  return { opener, tabs };
};

let originalFetch: typeof fetch;
const stopNavigation = (event: MouseEvent): void => {
  if (event.target instanceof HTMLAnchorElement) event.preventDefault();
};
beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('browser fixture', { status: 200 })) as unknown as typeof fetch;
  document.addEventListener('click', stopNavigation);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  document.removeEventListener('click', stopNavigation);
});

const snapshot = async (openLinksIn: OpenLinksIn, text = CAPTURE) => {
  const { opener, tabs } = fakeOpener();
  const view = await mount(
    <LinkBehaviourProvider openLinksIn={openLinksIn} opener={opener}>
      <TerminalSnapshotView daemon={daemon} scope={scope} now={() => 0} readSnapshot={async () => text} />
    </LinkBehaviourProvider>,
  );
  return { view, tabs };
};

describe('terminal snapshot — links', () => {
  it('draws each address as a new-tab anchor and leaves the rest of the text alone', async () => {
    const { view } = await snapshot('browser');
    try {
      const anchors = [...view.container.querySelectorAll<HTMLAnchorElement>('a[data-terminal-link]')];
      expect(anchors.map(anchor => anchor.getAttribute('href'))).toEqual([
        'https://app.example.test:8443/dev',
        'http://docs.example.test/x',
      ]);
      expect(anchors.map(anchor => anchor.textContent)).toEqual([
        'https://app.example.test:8443/dev',
        'http://docs.example.test/x',
      ]);
      expect(anchors.every(anchor => anchor.target === '_blank' && anchor.rel === 'noopener noreferrer')).toBe(true);
      expect(must(view.container.querySelector('pre'), 'the pane').textContent).toBe(CAPTURE);
    } finally {
      await view.unmount();
    }
  });

  it('leaves an ordinary click to the browser when the setting is Your browser', async () => {
    const { view, tabs } = await snapshot('browser');
    try {
      let prevented = false;
      view.container.addEventListener('click', event => {
        prevented = event.defaultPrevented;
      });
      await interact(() =>
        must(view.container.querySelector<HTMLAnchorElement>('a[data-terminal-link]'), 'a link').click(),
      );
      expect(tabs).toEqual([]);
      expect(prevented).toBe(false);
    } finally {
      await view.unmount();
    }
  });

  it('opens the preview when the setting is the side panel', async () => {
    const { view, tabs } = await snapshot('panel');
    try {
      await interact(() =>
        must(view.container.querySelector<HTMLAnchorElement>('a[data-terminal-link]'), 'a link').click(),
      );
      expect(tabs).toEqual([]);
      expect(must(document.body.querySelector('[role="dialog"]'), 'the preview').textContent).toContain(
        'https://app.example.test:8443/dev',
      );
    } finally {
      await view.unmount();
    }
  });

  it('keeps a Cmd-click a new tab even when the setting is the side panel', async () => {
    const { view } = await snapshot('panel');
    try {
      let prevented: boolean | undefined;
      view.container.addEventListener('click', event => {
        prevented = event.defaultPrevented;
      });
      const link = must(view.container.querySelector<HTMLAnchorElement>('a[data-terminal-link]'), 'a link');
      await interact(() =>
        link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })),
      );
      expect(prevented).toBe(false);
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('draws no anchor for a capture with no address, nor for another scheme', async () => {
    const { view } = await snapshot('browser', 'javascript:alert(1) file:///etc/passwd data:text/html,x\nplain');
    try {
      expect(view.container.querySelector('a')).toBeNull();
    } finally {
      await view.unmount();
    }
  });
});
