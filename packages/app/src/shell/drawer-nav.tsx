import { DevicePanels, NavCount, type NavForm } from './device-panels.tsx';
import { Icon } from './icons.tsx';
import { type NavTarget, useNavTargets } from './nav-targets.ts';
import { useShell } from './context.tsx';
import { Link } from './pages.tsx';

/**
 * THE APP'S DESTINATIONS, once, in the two places they are drawn: as icon + label rows in the left drawer (a slim rail shows the
 * icon alone, or the label's first letter where a destination declares no icon), and as the phone's bottom bar. A destination
 * with no address is one the person cannot open from here, and reads as plain text.
 */

function Row({ target, rail }: { readonly target: NavTarget; readonly rail: boolean }) {
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
    <span className="fy-nav__item fy-nav__item--off">{body}</span>
  ) : (
    <Link to={to} className="fy-nav__item" current={current}>
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
