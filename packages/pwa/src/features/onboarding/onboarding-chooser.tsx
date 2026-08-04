/**
 * THE FIRST SCREEN ASKS ONE QUESTION: what is this device going to be?
 *
 * It used to ask what the reader was HOLDING — a link, nothing, or an agent —
 * which is not a fact about the system and never asked the only question that
 * decides everything downstream. Ferretry has two roles. A DAEMON is a machine
 * that runs agents and needs a terminal. A CLIENT is a browser that watches one.
 * One machine can be both. So the three answers are: set both up for the first
 * time, add this browser as a client, or add this machine as a daemon.
 *
 * A PHONE IS NOT OFFERED A ROLE IT CANNOT HOLD. There is no terminal on a phone,
 * so "add this as a daemon" would be a promise the next screen has to withdraw.
 * The answer is still shown — an option that silently disappears reads as a
 * broken page, and a reader who came here to add a machine deserves to be told
 * what became of that — but it says plainly that it needs a computer, and
 * choosing it hands the job to one. The device is DETECTED, never asked: the page
 * already knows, and asking a question you know the answer to is how a setup
 * flow starts feeling like paperwork.
 *
 * IT IS A REAL LIST OF REAL BUTTONS. `<ul>`/`<li>` because it is a list, one
 * `<button>` per row because each is an action; no `role` anywhere, and nothing
 * that needs `aria-label` to have a name. The rows carry no `aria-pressed`
 * either: this is a choice that navigates, not a toggle that sticks.
 */

import { ChevronRight, Eye, Rocket, Server, SmartphoneNfc } from 'lucide-react';
import type { ReactNode } from 'react';

import type { DeviceKind } from './device-kind.ts';
import { onboardingRoutes, type OnboardingRouteId } from './onboarding-model.ts';

/**
 * One glyph per answer, chosen so the shapes differ at a glance rather than
 * merely decorating: a launch, an eye, a rack. The daemon row changes glyph on a
 * phone, because there the answer is about sending the job elsewhere rather than
 * about a machine standing here. Hidden from assistive technology — the title
 * beside each already says the same thing.
 */
const ICON: Record<OnboardingRouteId, ReactNode> = {
  'first-time': <Rocket size={22} aria-hidden="true" />,
  'add-client': <Eye size={22} aria-hidden="true" />,
  'add-daemon': <Server size={22} aria-hidden="true" />,
};

const MOBILE_DAEMON_ICON = <SmartphoneNfc size={22} aria-hidden="true" />;

const ROW =
  'flex w-full min-w-0 items-center gap-3 rounded-control border border-border bg-surface-2 px-3 py-3 text-left transition-colors hover:border-accent hover:bg-accent-bg focus-visible:outline-focus focus-visible:outline-offset-focus';

export interface OnboardingChooserProps {
  readonly onChoose: (route: OnboardingRouteId) => void;
  /** What this device is. Decides which answers are honest, never which are visible. */
  readonly device: DeviceKind;
}

export function OnboardingChooser({ onChoose, device }: OnboardingChooserProps) {
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-labelledby="onboarding-chooser-title">
      <div className="min-w-0">
        <h2 id="onboarding-chooser-title" className="m-0 font-display text-title font-bold tracking-display text-fg">
          What is this device?
        </h2>
        <p className="m-0 text-meta leading-base text-muted">
          A daemon runs your agents and needs a terminal. A client just watches one.
        </p>
      </div>

      <ul className="m-0 flex list-none flex-col gap-2 p-0" data-onboarding-device={device}>
        {onboardingRoutes(device).map(route => (
          <li key={route.id} className="min-w-0">
            <button type="button" className={ROW} onClick={() => onChoose(route.id)} data-onboarding-route={route.id}>
              <span className="shrink-0 text-accent">
                {route.id === 'add-daemon' && device === 'mobile' ? MOBILE_DAEMON_ICON : ICON[route.id]}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-display text-title font-bold tracking-display text-fg">{route.title}</span>
                <span className="text-meta leading-base text-muted">{route.answer}</span>
              </span>
              <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-faint" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
