import { Menu } from 'lucide-react';
import { useLayoutEffect, useState } from 'react';
import { PageThemeSwitch } from '../ui/theme-toggle.tsx';
import { type Route } from '../router/routes.ts';
import { useRouter } from '../router/router.tsx';
import { NavCount } from './device-panels.tsx';
import { drawerState } from './drawer-state.ts';
import { useShell } from './context.tsx';

/**
 * THE PHONE'S TITLE BAR (E2 gap 31): v4 puts the page's name at the top of every phone page, the menu button (the drawer) on its left
 * and the theme's on its right, so the person can tell which screen they are on (the bottom bar names a place, but Settings and
 * the pages with no bottom entry show none). The wide frame has no such bar: its nav already says where you are.
 *
 * A ferret's own page draws its own header (the ferret's name and its tabs), so it gets no second one here.
 */

/** The words on the bar for this route, with the plugin screen a count belongs to (none for the shell's own pages). */
export function phoneTitleOf(
  route: Route,
): { readonly title: string; readonly count?: { readonly plugin: string; readonly screen: string } } | undefined {
  switch (route.kind) {
    case 'home':
      return { title: 'Daemons' };
    case 'device-settings':
    case 'daemon-settings':
      return { title: 'Settings' };
    case 'daemon-home':
      return { title: 'Home' };
    case 'screen':
      if (route.params.ferret !== undefined) return undefined;
      return { title: route.screen.label, count: { plugin: route.screen.plugin, screen: route.screen.id } };
    case 'not-found':
      return undefined;
  }
}

/**
 * Does the page under the bar already draw its own `<h1>`? Projects, Insights, Settings and the daemon list do, and a second
 * one names the page twice to a screen reader (one h1 per page). Read from the page's own region after each render, since
 * the page is a plugin's and the shell cannot know what it draws; the bar's words stay on screen either way.
 */
function usePageDrawsOwnH1(): boolean {
  const [own, setOwn] = useState(false);
  useLayoutEffect(() => {
    const main = document.querySelector('[data-slot="main"]');
    if (main === null) return undefined;
    const read = (): void => setOwn(main.querySelector('h1') !== null);
    read();
    const watch = new MutationObserver(read);
    watch.observe(main, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, []);
  return own;
}

/** The bar's name: a heading, or a plain line where the page has its own heading. */
function Title({
  as: Tag,
  className,
  children,
}: {
  readonly as: 'h1' | 'p';
  readonly className: string;
  readonly children: React.ReactNode;
}) {
  return <Tag className={className}>{children}</Tag>;
}

export function PhoneTitleBar() {
  const { viewport } = useShell();
  const { route } = useRouter();
  const pageHasH1 = usePageDrawsOwnH1();
  if (viewport !== 'phone') return null;
  const named = phoneTitleOf(route);
  if (named === undefined) return null;
  return (
    <div className="fy-phone-title" data-slot="phone-title">
      <button
        type="button"
        className="fy-phone-title__side fy-phone-title__button"
        aria-label="Menu"
        aria-haspopup="dialog"
        onClick={() => drawerState.setOpen(true)}
      >
        <Menu aria-hidden="true" size={20} />
      </button>
      {/* The bar's name is the page's h1 only where the page draws none of its own. */}
      <Title as={pageHasH1 ? 'p' : 'h1'} className="fy-phone-title__text">
        {named.title}
        {named.count === undefined ? null : (
          <NavCount plugin={named.count.plugin} screen={named.count.screen} label={named.title} />
        )}
      </Title>
      <span className="fy-phone-title__side fy-phone-title__end">
        <PageThemeSwitch onPhone />
      </span>
    </div>
  );
}
