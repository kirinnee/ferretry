/**
 * Addresses in the Console's read-only capture are real anchors, opened by the app's one link behaviour
 * (`useLinkBehaviour`) like a chat link. The capture's text is untouched, so what is copied is what was captured.
 * Where Settings › "Open links in" sends a click instead is the Browsers half's to provide and to test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { TerminalSnapshotView } from '../../../app/components/terminal-snapshot.tsx';
import { daemonConnection, daemonSessionScope } from '../../../app/shell.ts';
import { interact, mount, must, ensureDom } from '@ferretry/app/testing';

// These suites read the document directly; register one before any hook or test runs.
ensureDom();

const daemon = daemonConnection('pane-daemon');
const scope = daemonSessionScope(daemon, 'pane-session');
const CAPTURE = 'Listening on https://app.example.test:8443/dev, docs at (http://docs.example.test/x).\nbye';

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

const snapshot = async (text = CAPTURE) => {
  const view = await mount(
    <TerminalSnapshotView daemon={daemon} scope={scope} now={() => 0} readSnapshot={async () => text} />,
  );
  return { view };
};

describe('terminal snapshot — links', () => {
  it('draws each address as a new-tab anchor and leaves the rest of the text alone', async () => {
    const { view } = await snapshot();
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

  it('leaves an ordinary click to the browser', async () => {
    const { view } = await snapshot();
    try {
      let prevented = false;
      view.container.addEventListener('click', event => {
        prevented = event.defaultPrevented;
      });
      await interact(() =>
        must(view.container.querySelector<HTMLAnchorElement>('a[data-terminal-link]'), 'a link').click(),
      );
      expect(prevented).toBe(false);
    } finally {
      await view.unmount();
    }
  });

  it('keeps a Cmd-click a new tab', async () => {
    const { view } = await snapshot();
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
    const { view } = await snapshot('javascript:alert(1) file:///etc/passwd data:text/html,x\nplain');
    try {
      expect(view.container.querySelector('a')).toBeNull();
    } finally {
      await view.unmount();
    }
  });
});
