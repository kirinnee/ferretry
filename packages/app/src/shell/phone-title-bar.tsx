import { Users } from 'lucide-react';
import { PageThemeSwitch } from '../ui/theme-toggle.tsx';
import { type Route } from '../router/routes.ts';
import { useRouter } from '../router/router.tsx';
import { NavCount } from './device-panels.tsx';
import { useShell } from './context.tsx';
import { Link } from './pages.tsx';

/**
 * THE PHONE'S TITLE BAR (E2 gap 31): v4 puts the page's name at the top of every phone page, the ferret list's button on its left
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

export function PhoneTitleBar({ daemon }: { readonly daemon: string | undefined }) {
  const { views, routes, viewport } = useShell();
  const { route } = useRouter();
  if (viewport !== 'phone') return null;
  const named = phoneTitleOf(route);
  if (named === undefined) return null;
  const ferrets = views.screens.get('ferrets.ferrets');
  const list = daemon === undefined || ferrets === undefined ? undefined : routes.href(ferrets, {}, daemon);
  return (
    <div className="fy-phone-title" data-slot="phone-title">
      {list === undefined ? (
        <span className="fy-phone-title__side" />
      ) : (
        <Link to={list} className="fy-phone-title__side fy-phone-title__button" aria-label="Ferret list">
          <Users aria-hidden="true" size={20} />
        </Link>
      )}
      <h1 className="fy-phone-title__text">
        {named.title}
        {named.count === undefined ? null : (
          <NavCount plugin={named.count.plugin} screen={named.count.screen} label={named.title} />
        )}
      </h1>
      <span className="fy-phone-title__side fy-phone-title__end">
        <PageThemeSwitch onPhone />
      </span>
    </div>
  );
}
