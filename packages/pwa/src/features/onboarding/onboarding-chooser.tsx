/**
 * THE FIRST SCREEN ASKS WHAT THE READER HAS, which is the only thing this page
 * cannot detect.
 *
 * It used to ask what this DEVICE was about to become — first-time, a client, or a
 * daemon — and that question was wrong twice over. It asked a phone something
 * `device-kind.ts` can already see, and it offered a phone "add this as a daemon",
 * an answer no phone can hold: agents need a terminal. So the answer was shown,
 * relabelled, and then withdrawn a screen later, which is a page arguing with
 * itself.
 *
 * NONE OF THESE THREE CLAIMS ANYTHING ABOUT THIS DEVICE, so none of them has to be
 * refused on one. They are three states of the reader's world:
 *
 * - Nothing exists yet. Get a daemon running, then pair.
 * - A daemon exists and they are holding a link or a QR for it. Straight to pairing.
 * - A fleet exists and they want one more machine in it. The SAME daemon subflow,
 *   which is why adding a daemon replays the full instructions for free.
 *
 * A BROWSER THAT HAS PAIRED BEFORE NEVER SEES THIS. `first-run-entry.ts` sends it
 * to its fleet, and the composition root honours that before this component is
 * ever rendered — asking somebody who set this up months ago why they are here,
 * on the screen they open every day, is the same failure as a cookie banner
 * asking permission it already has.
 *
 * IT IS A REAL LIST OF REAL BUTTONS. `<ul>`/`<li>` because it is a list, one
 * `<button>` per row because each is an action; no `role` anywhere, and nothing
 * that needs `aria-label` to have a name. The rows carry no `aria-pressed`
 * either: this is a choice that navigates, not a toggle that sticks. There is no
 * Back, because there is nothing behind it.
 */

import { ChevronRight, QrCode, Rocket, Server } from 'lucide-react';
import type { ReactNode } from 'react';

import { ONBOARDING_ROUTES, type OnboardingRouteId } from './onboarding-model.ts';

/**
 * One glyph per answer, chosen so the shapes differ at a glance rather than
 * merely decorating: a launch, the thing the reader is holding, a rack. Hidden
 * from assistive technology — the title beside each already says the same thing.
 */
const ICON: Readonly<Record<OnboardingRouteId, ReactNode>> = {
  'first-time': <Rocket size={22} aria-hidden="true" />,
  'add-client': <QrCode size={22} aria-hidden="true" />,
  'add-daemon': <Server size={22} aria-hidden="true" />,
};

const ROW =
  'flex w-full min-w-0 items-center gap-3 rounded-control border border-border bg-surface-2 px-3 py-3 text-left transition-colors hover:border-accent hover:bg-accent-bg focus-visible:outline-focus focus-visible:outline-offset-focus';

export interface OnboardingChooserProps {
  readonly onChoose: (route: OnboardingRouteId) => void;
}

export function OnboardingChooser({ onChoose }: OnboardingChooserProps) {
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-labelledby="onboarding-chooser-title">
      <div className="min-w-0">
        <h2 id="onboarding-chooser-title" className="m-0 font-display text-title font-bold tracking-display text-fg">
          What do you have?
        </h2>
        <p className="m-0 text-meta leading-base text-muted">
          Ferretry runs your agents on a computer. Any browser, including this one, is a window onto it.
        </p>
      </div>

      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {ONBOARDING_ROUTES.map(route => (
          <li key={route.id} className="min-w-0">
            <button type="button" className={ROW} onClick={() => onChoose(route.id)} data-onboarding-route={route.id}>
              <span className="shrink-0 text-accent">{ICON[route.id]}</span>
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
