/**
 * THE FIRST SCREEN ASKS WHAT THE READER HAS, which is the only thing this page
 * cannot detect.
 *
 * It used to ask what this DEVICE was about to become, and that question was wrong
 * twice over: it asked a phone something `device-kind.ts` can already see, and it
 * offered a phone "add this as a daemon", an answer no phone can hold.
 *
 * TWO CARDS, BECAUSE THERE ARE TWO STARTING POINTS. Both claim nothing about this
 * device:
 *
 * - Nothing exists yet. Get a daemon running, then pair.
 * - A daemon exists and they are holding a link or a QR for it. Straight to pairing.
 *
 * "ONE MORE COMPUTER" IS A SMALL LINK, NOT A THIRD CARD. Somebody who already has a
 * fleet is rare on this screen — a browser that has paired before never sees it —
 * and a third equal card made the first two look like one of three.
 * It is still the SAME daemon subflow, which is why it replays the full
 * instructions for free.
 *
 * A BROWSER THAT HAS PAIRED BEFORE NEVER SEES THIS. `first-run-entry.ts` sends it
 * to its fleet, and the composition root honours that before this component is
 * ever rendered.
 *
 * IT IS A REAL LIST OF REAL BUTTONS. `<ul>`/`<li>` because it is a list, one
 * `<button>` per row because each is an action; no `role` anywhere, and nothing
 * that needs `aria-label` to have a name. There is no Back, because there is
 * nothing behind it.
 */

import { ChevronRight, Laptop, QrCode } from 'lucide-react';
import type { ReactNode } from 'react';

import { ONBOARDING_ROUTES, type OnboardingRouteId, onboardingRoute } from './onboarding-model.ts';

/** One glyph per card, hidden from assistive technology: the title beside each already says it. */
const ICON: Readonly<Partial<Record<OnboardingRouteId, ReactNode>>> = {
  'first-time': <Laptop size={22} aria-hidden="true" />,
  'add-client': <QrCode size={22} aria-hidden="true" />,
};

const CARDS = ONBOARDING_ROUTES.filter(route => route.id !== 'add-daemon');

const ROW =
  'flex w-full min-w-0 items-center gap-3 rounded-control border border-border bg-surface-2 px-3 py-3 text-left transition-colors hover:border-accent hover:bg-accent-soft focus-visible:outline-focus focus-visible:outline-offset-focus';

export interface OnboardingChooserProps {
  readonly onChoose: (route: OnboardingRouteId) => void;
}

export function OnboardingChooser({ onChoose }: OnboardingChooserProps) {
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-labelledby="onboarding-chooser-title">
      <div className="min-w-0">
        <h2 id="onboarding-chooser-title" className="m-0 font-display text-title font-bold tracking-display text-fg">
          Welcome
        </h2>
        <p className="m-0 text-meta leading-base text-muted">
          Ferretry runs your agents on a computer. This browser watches them.
        </p>
      </div>

      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {CARDS.map(route => (
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

      <button
        type="button"
        className="self-start text-meta text-muted underline underline-offset-2 hover:text-accent focus-visible:outline-focus focus-visible:outline-offset-focus"
        onClick={() => onChoose('add-daemon')}
        data-onboarding-route="add-daemon"
      >
        {onboardingRoute('add-daemon').title}
      </button>
    </section>
  );
}
