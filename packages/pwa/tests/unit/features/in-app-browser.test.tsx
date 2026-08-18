import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  InAppBrowserFrame,
  InAppBrowserLink,
  InAppBrowserPane,
  InAppBrowserSheet,
  InAppBrowserSurface,
  InAppBrowserWorkspace,
} from '../../../src/features/browser/in-app-browser.tsx';
import type { BrowserDestination } from '../../../src/features/browser/in-app-browser-model.ts';
import { interact, mount, must, pressKey } from '../../support/dom.ts';

const remote: BrowserDestination = {
  href: 'https://docs.example.test/getting-started',
  hostname: 'docs.example.test',
  scope: 'cross-origin',
};

const loopback: BrowserDestination = {
  href: 'http://localhost:5173/',
  hostname: 'localhost',
  scope: 'device-loopback',
};

const byLabel = (container: HTMLElement, label: string): HTMLElement =>
  must(container.querySelector<HTMLElement>(`[aria-label="${label}"]`), `an element labelled ${label}`);

let originalFetch: typeof fetch;
const preventBrowserNavigation = (event: MouseEvent): void => {
  if (event.target instanceof HTMLAnchorElement) event.preventDefault();
};

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // Iframes belong to the browser integration, but this unit suite asserts the
  // embedding contract rather than fetching a public host.
  globalThis.fetch = (async () => new Response('browser fixture', { status: 200 })) as unknown as typeof fetch;
  // Modified/download links deliberately retain browser semantics. Stop
  // happy-dom from turning that default action into a real navigation request.
  document.addEventListener('click', preventBrowserNavigation);
});

afterEach(() => {
  document.removeEventListener('click', preventBrowserNavigation);
  globalThis.fetch = originalFetch;
});

describe('the in-app frame', () => {
  it('sandboxes a remote page and sends no referrer', async () => {
    const view = await mount(<InAppBrowserFrame destination={remote} />);
    const frame = must(view.container.querySelector('iframe'), 'the iframe');
    expect(frame.getAttribute('src')).toBe(remote.href);
    expect(frame.getAttribute('title')).toBe('Embedded view of docs.example.test');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts');
    await view.unmount();
  });

  it('refuses to frame an address that names the reader’s own phone', async () => {
    const view = await mount(<InAppBrowserFrame destination={loopback} />);
    expect(view.container.querySelector('iframe')).toBeNull();
    expect(view.container.textContent).toContain('This address is on your phone');
    await view.unmount();
  });
});

describe('the in-app surface', () => {
  it('keeps the URL and the external escape hatch visible, and warns rather than claiming a load', async () => {
    let closed = 0;
    const view = await mount(
      <InAppBrowserSurface
        destination={remote}
        presentation="pane"
        titleId="surface-title"
        onClose={() => (closed += 1)}
      />,
    );
    const rail = byLabel(view.container, 'URL being viewed');
    expect(rail.getAttribute('role')).toBe('status');
    expect(rail.textContent).toContain(remote.href);
    expect(view.container.textContent).toContain('Most public sites block embedded viewing');
    const external = must(view.container.querySelector('a[target="_blank"]'), 'the external link');
    expect(external.getAttribute('href')).toBe(remote.href);
    expect(external.getAttribute('rel')).toBe('noreferrer');
    // A pane has its own close control; the title is an h2 beneath the app's h1.
    expect(must(view.container.querySelector('h2'), 'the pane heading').id).toBe('surface-title');
    await interact(() => byLabel(view.container, 'Close browser pane').click());
    expect(closed).toBe(1);
    await view.unmount();
  });

  it('drops the pane close control in a sheet, and the frame warning for a loopback address', async () => {
    const view = await mount(
      <InAppBrowserSurface destination={loopback} presentation="sheet" titleId="sheet-title" onClose={() => {}} />,
    );
    expect(view.container.querySelector('[aria-label="Close browser pane"]')).toBeNull();
    expect(view.container.textContent).not.toContain('Most public sites block embedded viewing');
    expect(must(view.container.querySelector('h1'), 'the sheet heading').id).toBe('sheet-title');
    await view.unmount();
  });
});

describe('the desktop pane', () => {
  it('closes on Escape without letting the key reach the page behind it', async () => {
    let closed = 0;
    const view = await mount(<InAppBrowserPane id="preview-pane" destination={remote} onClose={() => (closed += 1)} />);
    const pane = must(view.container.querySelector('aside'), 'the pane');
    expect(pane.id).toBe('preview-pane');
    expect(pane.getAttribute('aria-labelledby')).toBeTruthy();
    await interact(() => pressKey(pane, 'Escape'));
    expect(closed).toBe(1);
    // Any other key is left alone.
    await interact(() => pressKey(pane, 'a'));
    expect(closed).toBe(1);
    await view.unmount();
  });
});

describe('the phone sheet', () => {
  it('renders the surface inside a labelled sheet', async () => {
    const view = await mount(<InAppBrowserSheet destination={remote} open onClose={() => {}} />);
    expect(document.body.textContent).toContain('Link preview');
    expect(document.body.textContent).toContain(remote.href);
    await view.unmount();
  });
});

describe('the workspace host', () => {
  it('opens a tapped link beside the conversation on desktop and announces it', async () => {
    const view = await mount(
      <InAppBrowserWorkspace compact={false}>
        <InAppBrowserLink href="https://docs.example.test/getting-started">Docs</InAppBrowserLink>
      </InAppBrowserWorkspace>,
    );
    try {
      const link = must(view.container.querySelector('a'), 'the transcript link');
      expect(link.getAttribute('aria-controls')).toContain('in-app-browser-pane-');
      expect(link.getAttribute('aria-haspopup')).toBeNull();

      await interact(() => link.click());
      expect(view.container.querySelector('aside')).not.toBeNull();
      const live = must(view.container.querySelector('[aria-live="polite"]'), 'the live region');
      expect(live.textContent).toBe(`Opened link preview beside the conversation: ${remote.href}`);

      await interact(() => byLabel(view.container, 'Close browser pane').click());
      expect(view.container.querySelector('aside')).toBeNull();
      expect(must(view.container.querySelector('[aria-live="polite"]'), 'the live region').textContent).toBe('');
    } finally {
      await view.unmount();
    }
  });

  it('presents the same link as a sheet on a phone', async () => {
    const view = await mount(
      <InAppBrowserWorkspace compact>
        <InAppBrowserLink href="https://docs.example.test/getting-started">Docs</InAppBrowserLink>
      </InAppBrowserWorkspace>,
    );
    try {
      const link = must(view.container.querySelector('a'), 'the transcript link');
      expect(link.getAttribute('aria-haspopup')).toBe('dialog');
      expect(link.getAttribute('aria-controls')).toBeNull();
      await interact(() => link.click());
      expect(view.container.querySelector('aside')).toBeNull();
      expect(must(view.container.querySelector('[aria-live="polite"]'), 'the live region').textContent).toBe(
        `Opened link preview: ${remote.href}`,
      );
    } finally {
      await view.unmount();
    }
  });

  it('leaves a modified click, an unopenable scheme and a download to the browser', async () => {
    const clicks: string[] = [];
    const view = await mount(
      <InAppBrowserWorkspace compact={false}>
        <InAppBrowserLink href="https://docs.example.test/a" onClick={() => clicks.push('remote')}>
          Docs
        </InAppBrowserLink>
        <InAppBrowserLink href="mailto:someone@example.test">Mail</InAppBrowserLink>
        <InAppBrowserLink href="https://docs.example.test/report.pdf" download="report.pdf">
          Report
        </InAppBrowserLink>
      </InAppBrowserWorkspace>,
    );
    try {
      const [remoteLink, mailLink, downloadLink] = [...view.container.querySelectorAll('a')];
      await interact(() =>
        must(remoteLink, 'the remote link').dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }),
        ),
      );
      expect(clicks).toEqual(['remote']);
      expect(view.container.querySelector('aside')).toBeNull();

      // An unclassifiable scheme carries neither overlay hint.
      expect(must(mailLink, 'the mail link').getAttribute('aria-haspopup')).toBeNull();
      expect(must(mailLink, 'the mail link').getAttribute('aria-controls')).toBeNull();
      await interact(() => must(mailLink, 'the mail link').click());
      expect(view.container.querySelector('aside')).toBeNull();

      await interact(() => must(downloadLink, 'the download link').click());
      expect(view.container.querySelector('aside')).toBeNull();
    } finally {
      await view.unmount();
    }
  });
});

describe('a link with no workspace above it', () => {
  it('portals its own sheet rather than doing nothing', async () => {
    const view = await mount(<InAppBrowserLink href="https://docs.example.test/solo">Solo</InAppBrowserLink>);
    try {
      const link = must(view.container.querySelector('a'), 'the link');
      expect(link.getAttribute('aria-haspopup')).toBe('dialog');
      await interact(() => link.click());
      expect(document.body.textContent).toContain('https://docs.example.test/solo');
    } finally {
      await view.unmount();
    }
  });
});
