/**
 * Addresses in the Console's read-only capture are real anchors, handed to the link host (Settings › "Open links in")
 * on a click. The capture's text is untouched, so what is copied is what was captured.
 */
import { describe, expect, it } from 'bun:test';
import { interact, mount, must } from '@ferretry/app/testing';
import { TerminalSnapshotView } from '../../../app/components/terminal-snapshot.tsx';
import type { LinkHost } from '../../../app/lib/link-host.ts';
import { scriptedClient } from '../../support/app/client.ts';

const { client } = scriptedClient('');
const scope = { sessionId: 'pane-session' };
const CAPTURE = 'Listening on https://app.example.test:8443/dev, docs at (http://docs.example.test/x).\nbye';

/** A link host that records what it was asked, and handles the click only when told to. */
const fakeHost = (handles: boolean) => {
  const activated: string[] = [];
  const host: LinkHost = {
    activate: (click, target) => {
      activated.push(target.href);
      if (handles) click.preventDefault();
      return handles;
    },
    open: () => undefined,
  };
  return { host, activated };
};

const snapshot = async (handles: boolean, text = CAPTURE) => {
  const { host, activated } = fakeHost(handles);
  const view = await mount(
    <TerminalSnapshotView client={client} links={host} now={() => 0} readSnapshot={async () => text} scope={scope} />,
  );
  return { view, activated };
};

const stopNavigation = (event: MouseEvent): void => {
  if (event.target instanceof HTMLAnchorElement) event.preventDefault();
};

describe('terminal snapshot — links', () => {
  it('draws each address as a new-tab anchor and leaves the rest of the text alone', async () => {
    const { view } = await snapshot(false);
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

  it('hands a click to the link host, and leaves it to the browser when the host does not handle it', async () => {
    document.addEventListener('click', stopNavigation);
    const { view, activated } = await snapshot(false);
    try {
      let prevented = true;
      view.container.addEventListener('click', event => {
        prevented = event.defaultPrevented;
      });
      await interact(() =>
        must(view.container.querySelector<HTMLAnchorElement>('a[data-terminal-link]'), 'a link').click(),
      );
      expect(activated).toEqual(['https://app.example.test:8443/dev']);
      expect(prevented).toBe(false);
    } finally {
      document.removeEventListener('click', stopNavigation);
      await view.unmount();
    }
  });

  it('lets the host take the click over', async () => {
    const { view, activated } = await snapshot(true);
    try {
      let prevented = false;
      view.container.addEventListener('click', event => {
        prevented = event.defaultPrevented;
      });
      await interact(() =>
        must(view.container.querySelector<HTMLAnchorElement>('a[data-terminal-link]'), 'a link').click(),
      );
      expect(activated).toHaveLength(1);
      expect(prevented).toBe(true);
    } finally {
      await view.unmount();
    }
  });

  it('draws no anchor for a capture with no address, nor for another scheme', async () => {
    const { view } = await snapshot(false, 'javascript:alert(1) file:///etc/passwd data:text/html,x\nplain');
    try {
      expect(view.container.querySelector('a')).toBeNull();
    } finally {
      await view.unmount();
    }
  });
});
