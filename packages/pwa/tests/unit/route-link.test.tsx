import { describe, expect, it } from 'bun:test';
import { RouteLink } from '../../src/shell/route-link.tsx';
import { interact, mount } from '../support/dom.ts';

const click = (target: EventTarget, init: MouseEventInit = {}): boolean =>
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));

describe('RouteLink', () => {
  it('is a real anchor carrying the destination, so the browser can act on it', async () => {
    const { container } = await mount(<RouteLink to="/d/alpha/warden">Warden</RouteLink>);
    const link = container.querySelector('a');

    expect(link?.getAttribute('href')).toBe('/d/alpha/warden');
    expect(link?.textContent).toBe('Warden');
  });

  it('handles a plain primary click in-app and prevents the navigation', async () => {
    const navigated: string[] = [];
    const { container } = await mount(
      <RouteLink to="/d/alpha/warden" onNavigate={to => navigated.push(to)}>
        Warden
      </RouteLink>,
    );
    const link = container.querySelector('a') as HTMLAnchorElement;

    let defaultAllowed = true;
    await interact(() => {
      defaultAllowed = click(link);
    });

    expect(navigated).toEqual(['/d/alpha/warden']);
    expect(defaultAllowed).toBe(false);
  });

  it('lets every open-in-a-new-tab gesture fall through to the browser untouched', async () => {
    const navigated: string[] = [];
    const { container } = await mount(
      <RouteLink to="/d/alpha/warden" onNavigate={to => navigated.push(to)}>
        Warden
      </RouteLink>,
    );
    const link = container.querySelector('a') as HTMLAnchorElement;

    for (const modifier of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      let defaultAllowed = false;
      await interact(() => {
        defaultAllowed = click(link, modifier);
      });
      expect(defaultAllowed).toBe(true);
    }

    expect(navigated).toEqual([]);
  });

  it('still calls a caller-supplied onClick after navigating', async () => {
    const order: string[] = [];
    const { container } = await mount(
      <RouteLink to="/d/alpha" onNavigate={() => order.push('navigate')} onClick={() => order.push('click')}>
        Sessions
      </RouteLink>,
    );

    await interact(() => click(container.querySelector('a') as HTMLAnchorElement));

    expect(order).toEqual(['navigate', 'click']);
  });

  it('is inert but still a link when the host supplies no navigation effect', async () => {
    const { container } = await mount(<RouteLink to="/d/alpha">Sessions</RouteLink>);
    let defaultAllowed = true;

    await interact(() => {
      defaultAllowed = click(container.querySelector('a') as HTMLAnchorElement);
    });

    expect(defaultAllowed).toBe(false);
  });

  it('forwards native anchor attributes', async () => {
    const { container } = await mount(
      <RouteLink to="/d/alpha" className="text-accent" aria-label="Open the fleet">
        Sessions
      </RouteLink>,
    );
    const link = container.querySelector('a');

    expect(link?.className).toBe('text-accent');
    expect(link?.getAttribute('aria-label')).toBe('Open the fleet');
  });
});
