/**
 * WHICH COMPUTER RUNS THE DAEMON — the question that replaced "what is this device?".
 *
 * The difference is not phrasing. "What is this device?" asks the reader for a
 * fact the page can see, and its answers describe a ROLE this browser is about to
 * take; this asks about the arrangement, and its answers name a MACHINE. A daemon
 * lives on a computer either way, and a browser is only ever a client of one.
 *
 * IT IS ASKED ONLY WHEN NOBODY HAS ALREADY ANSWERED IT.
 *
 * - On a phone it is never asked. The hardware answers it — agents need a
 *   terminal — and `presumedTarget` returns "another computer" outright. Asking
 *   would be paperwork, and offering "this one" would be a lie.
 * - Starting from scratch on a computer it is not asked either: that reader is
 *   overwhelmingly sitting at the machine they mean, so it is assumed and the
 *   assumption is stated on the next screen with a way out.
 * - Adding a daemon to an existing fleet, on a computer, IS this screen. That
 *   reader owns several machines and has a real choice between two of them, and
 *   guessing for somebody who already knows the vocabulary is the rude case.
 *
 * IT IS A REAL LIST OF REAL BUTTONS, for the same reasons as every other chooser
 * here, and it has a Back because there is a question behind it.
 */

import { ArrowLeft, ChevronRight, Laptop, Network } from 'lucide-react';
import type { ReactNode } from 'react';

import { SETUP_TARGETS, type SetupTargetId } from './onboarding-model.ts';

/**
 * One glyph per answer: the machine on the desk, and a machine across a network.
 * Hidden from assistive technology — the title beside each says the same thing.
 */
const ICON: Readonly<Record<SetupTargetId, ReactNode>> = {
  this: <Laptop size={22} aria-hidden="true" />,
  other: <Network size={22} aria-hidden="true" />,
};

const ROW =
  'flex w-full min-w-0 items-center gap-3 rounded-control border border-border bg-surface-2 px-3 py-3 text-left transition-colors hover:border-accent hover:bg-accent-bg focus-visible:outline-focus focus-visible:outline-offset-focus';

export interface OnboardingTargetChooserProps {
  readonly onChoose: (target: SetupTargetId) => void;
  /** Back to the entry question, which is what opened this one. */
  readonly onBack: () => void;
}

export function OnboardingTargetChooser({ onChoose, onBack }: OnboardingTargetChooserProps) {
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-labelledby="onboarding-target-title">
      <div className="min-w-0">
        <h2 id="onboarding-target-title" className="m-0 font-display text-title font-bold tracking-display text-fg">
          Which computer runs the daemon?
        </h2>
        <p className="m-0 text-meta leading-base text-muted">
          The daemon runs your agents and needs a terminal. Every browser watching it is a client.
        </p>
      </div>

      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {SETUP_TARGETS.map(target => (
          <li key={target.id} className="min-w-0">
            <button
              type="button"
              className={ROW}
              onClick={() => onChoose(target.id)}
              data-onboarding-target={target.id}
            >
              <span className="shrink-0 text-accent">{ICON[target.id]}</span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-display text-title font-bold tracking-display text-fg">{target.title}</span>
                <span className="text-meta leading-base text-muted">{target.answer}</span>
              </span>
              <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-faint" />
            </button>
          </li>
        ))}
      </ul>

      {/*
        Quiet, and after the answers: it is a way out rather than a way on, and
        the one loud control per screen rule belongs to the answers themselves.
      */}
      <div className="flex min-w-0">
        <button
          type="button"
          className="kt-btn min-h-[44px]"
          data-variant="ghost"
          onClick={onBack}
          data-onboarding-back="entry"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          Back
        </button>
      </div>
    </section>
  );
}
