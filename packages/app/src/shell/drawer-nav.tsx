import { DevicePanels, NavCount, type NavForm } from './device-panels.tsx';
import { Icon } from './icons.tsx';
import { type NavTarget, useNavTargets } from './nav-targets.ts';
import { useShell } from './context.tsx';
import { Link } from './pages.tsx';

/**
 * THE APP'S DESTINATIONS, once, in the places they are drawn: DOCKED at the foot of the left drawer (the default, r11 S1: a row
 * of icons, or icon + word cells; a slim rail stacks the icons), as icon + label rows in a list at the drawer's top, and as a
 * bottom bar. A destination with no address is one the person cannot open from here, and reads as plain text.
 */

/** Where the drawer draws its places: docked at its foot, as a list at its top, or not at all (a bottom bar has them). */
export type NavPlacement = 'dock' | 'list' | 'none';

export function navPlacement(nav: { readonly side: string; readonly style: string }): NavPlacement {
  if (nav.side === 'bottom') return 'none';
  return nav.style === 'dock' ? 'dock' : 'list';
}

function Row({ target, rail, tip }: { readonly target: NavTarget; readonly rail: boolean; readonly tip?: boolean }) {
  const { entry, to, label, current, icon } = target;
  // A plugin's count for its own entry, summed over every machine (S4), on every nav form.
  const badge =
    entry.kind === 'screen' ? (
      <NavCount key="count" plugin={entry.screen.plugin} screen={entry.screen.id} label={label} />
    ) : null;
  const body = (
    <>
      <Icon name={icon} className="fy-nav__icon" />
      {/* In the rail the words are for assistive tech and the tooltip; a destination with no icon shows its first letter. */}
      {rail && icon === undefined ? (
        <span aria-hidden="true" className="fy-nav__initial">
          {label.slice(0, 1)}
        </span>
      ) : null}
      <span className={rail ? 'sr-only' : 'fy-nav__label'}>{label}</span>
      {badge}
    </>
  );
  return to === undefined ? (
    <span className="fy-nav__item fy-nav__item--off" {...(tip === true ? { title: label } : {})}>
      {body}
    </span>
  ) : (
    <Link to={to} className="fy-nav__item" current={current} title={tip === true ? label : undefined}>
      {body}
    </Link>
  );
}

/**
 * The destinations in the drawer, then the device-level nav panels (Needs you…) when the layout asks for a column or a rail
 * (the default layout does not: the Agenda row's count is the one badge), told the form they are drawn in.
 */
export function DrawerNav({ daemon, rail }: { readonly daemon: string | undefined; readonly rail: boolean }) {
  const { plan } = useShell();
  const targets = useNavTargets(daemon);
  const form: NavForm = rail ? 'rail' : 'column';
  const panels = plan.nav.side === 'left' || plan.nav.side === 'right';
  return (
    <nav className={`fy-nav fy-nav--drawer fy-nav--${rail ? 'rail' : 'column'}`} data-slot="nav" aria-label="Places">
      {targets.map(target => (
        <Row key={target.key} target={target} rail={rail} />
      ))}
      {panels ? <DevicePanels slot="nav" form={form} /> : null}
    </nav>
  );
}

/**
 * THE DOCK (r11 S1): the places at the foot of the drawer. `labels: 'icons'` is a row of icon cells whose name is their tooltip
 * and accessible name; `'words'` is a grid of icon + word cells; a collapsed rail stacks the icons whatever the choice. It draws no
 * device-level nav panels (Needs you…): a list under a row of icons has no room, and the Agenda place's count is the one badge.
 */
export function DrawerDock({ daemon, rail }: { readonly daemon: string | undefined; readonly rail: boolean }) {
  const { plan } = useShell();
  const targets = useNavTargets(daemon);
  const words = plan.nav.labels === 'words' && !rail;
  return (
    <nav
      className={`fy-nav fy-nav--dock fy-nav--dock-${rail ? 'rail' : words ? 'words' : 'icons'}`}
      data-slot="nav"
      data-nav="dock"
      aria-label="Places"
    >
      {targets.map(target => (
        <Row key={target.key} target={target} rail={!words} tip />
      ))}
    </nav>
  );
}

/** The phone's bottom bar of places; the drawer holds the same places in the same order. */
export function BottomNav({ daemon }: { readonly daemon: string | undefined }) {
  const { plan } = useShell();
  const targets = useNavTargets(daemon);
  return (
    <nav
      className={`fy-nav fy-nav--bottom fy-nav--${plan.nav.style}`}
      data-slot="bottom"
      // THE PHONE'S BOTTOM BAR STEPS ASIDE FOR THE KEYBOARD (design-system.css `[data-kb-hide]`): it is stateless links, so it
      // can go and come back intact, and it no longer covers the composer while someone types.
      data-kb-hide=""
    >
      {targets.map(({ entry, to, label, key, current }) => {
        const badge =
          entry.kind === 'screen' ? (
            <NavCount key="count" plugin={entry.screen.plugin} screen={entry.screen.id} label={label} />
          ) : null;
        return to === undefined ? (
          <span key={key} className="fy-nav__item fy-nav__item--off">
            {label}
            {badge}
          </span>
        ) : (
          <Link key={key} to={to} className="fy-nav__item" current={current}>
            {label}
            {badge}
          </Link>
        );
      })}
    </nav>
  );
}
