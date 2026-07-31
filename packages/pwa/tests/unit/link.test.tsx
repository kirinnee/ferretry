import { afterEach, describe, expect, it } from 'bun:test';
import { createRef } from 'react';
import { Link, navigate } from '../../src/shell/link.tsx';
import { interact, mount } from '../support/dom.ts';

const startingPath = window.location.pathname;

const click = (target: HTMLElement, fields: Record<string, unknown> = {}): Event => {
  const event = new Event('click', { bubbles: true, cancelable: true });
  Object.assign(event, { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...fields });
  target.dispatchEvent(event);
  return event;
};

afterEach(() => {
  history.replaceState({}, '', startingPath);
});

describe('navigate', () => {
  it('pushes history and wakes the router the way a link click does', async () => {
    const seen: string[] = [];
    const onPopState = () => seen.push(window.location.pathname);
    window.addEventListener('popstate', onPopState);

    await interact(() => navigate('/d/workshop/warden'));

    expect(window.location.pathname).toBe('/d/workshop/warden');
    expect(seen).toEqual(['/d/workshop/warden']);

    window.removeEventListener('popstate', onPopState);
  });
});

describe('Link', () => {
  it('is a real anchor, so copy-link and open-in-new-tab keep working', async () => {
    const ref = createRef<HTMLAnchorElement>();
    const mounted = await mount(
      <Link ref={ref} to="/d/workshop/warden" className="kt-btn" aria-label="Warden">
        Warden
      </Link>,
    );
    const anchor = mounted.container.querySelector('a') as HTMLAnchorElement;

    expect(anchor.getAttribute('href')).toBe('/d/workshop/warden');
    expect(anchor.className).toBe('kt-btn');
    expect(ref.current).toBe(anchor);

    await mounted.unmount();
  });

  it('takes over a plain left click and reports it to the caller', async () => {
    const navigated: string[] = [];
    const clicked: string[] = [];
    const mounted = await mount(
      <Link to="/d/workshop/warden" onNavigate={to => navigated.push(to)} onClick={() => clicked.push('click')}>
        Warden
      </Link>,
    );
    const anchor = mounted.container.querySelector('a') as HTMLAnchorElement;
    let event: Event | undefined;

    await interact(() => {
      event = click(anchor);
    });

    expect(event?.defaultPrevented).toBe(true);
    expect(navigated).toEqual(['/d/workshop/warden']);
    // The caller's own handler still runs, after the navigation is committed.
    expect(clicked).toEqual(['click']);

    await mounted.unmount();
  });

  it('leaves modifier and non-primary clicks entirely to the browser', async () => {
    const navigated: string[] = [];
    const mounted = await mount(
      <Link to="/d/workshop/warden" onNavigate={to => navigated.push(to)}>
        Warden
      </Link>,
    );
    const anchor = mounted.container.querySelector('a') as HTMLAnchorElement;

    for (const fields of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      let event: Event | undefined;
      await interact(() => {
        event = click(anchor, fields);
      });

      expect(event?.defaultPrevented).toBe(false);
    }

    expect(navigated).toEqual([]);

    await mounted.unmount();
  });

  it('defaults to real history navigation when no seam is supplied', async () => {
    const mounted = await mount(<Link to="/d/laptop/analytics">Analytics</Link>);

    await interact(() => click(mounted.container.querySelector('a') as HTMLAnchorElement));

    expect(window.location.pathname).toBe('/d/laptop/analytics');

    await mounted.unmount();
  });
});
