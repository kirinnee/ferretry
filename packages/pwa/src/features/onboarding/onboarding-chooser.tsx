/**
 * THE FIRST SCREEN ASKS ONE QUESTION: which of these are you?
 *
 * It used to be step 1 of a fixed four-step arc, which quietly asserted that
 * everybody who opens this page is about to install something. Three different
 * people open it. Somebody whose phone just scanned a QR is one tap from
 * finished and needs no installer; somebody at a fresh machine needs the whole
 * journey; somebody who would rather an agent did it needs a prompt, not a
 * stepper. Sending all three down one path with steps hidden inside it means two
 * of them read instructions that are not theirs.
 *
 * SO THE THREE ANSWERS ARE THE WHOLE SCREEN. No stepper, no track, no diagram
 * competing with them: three rows, an icon each, a title in the biggest type on
 * the page and one line saying what happens. The test this has to pass is whether
 * a reader can tell which one is theirs in about a second, so the titles are the
 * reader's own words — "I have a link or QR" — rather than ours.
 *
 * IT IS A REAL LIST OF REAL BUTTONS. `<ul>`/`<li>` because it is a list, one
 * `<button>` per row because each is an action; no `role` anywhere, and nothing
 * that needs `aria-label` to have a name. The rows carry no `aria-pressed`
 * either: this is a choice that navigates, not a toggle that sticks.
 */

import { Bot, ChevronRight, QrCode, Terminal } from 'lucide-react';
import type { ReactNode } from 'react';

import { ONBOARDING_ROUTES, type OnboardingRouteId } from './onboarding-model.ts';

/**
 * One glyph per answer, chosen so the shapes differ at a glance rather than
 * merely decorating: a QR block, a terminal prompt, a robot. Hidden from
 * assistive technology — the title beside each already says the same thing.
 */
const ICON: Record<OnboardingRouteId, ReactNode> = {
  'have-link': <QrCode size={22} aria-hidden="true" />,
  'first-time': <Terminal size={22} aria-hidden="true" />,
  agent: <Bot size={22} aria-hidden="true" />,
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
          Which of these are you?
        </h2>
        <p className="m-0 text-meta leading-base text-muted">Each answer is a different, shorter route.</p>
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
