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
 * IT IS A CHOICE, THEN A BUTTON, for the same reasons as every other chooser here: the cards are `ChoiceCards` (the arrow
 * keys move the selection, so selecting never acts) and **Continue** starts the journey. It has a Back because there is a
 * question behind it.
 */

import { ChoiceCards, type ChoiceOption } from '@ferretry/app';
import { Button } from '@ferretry/app/ui';
import { Laptop, Network } from 'lucide-react';
import { useState } from 'react';

import { isSetupTargetId, SETUP_TARGETS, type SetupTargetId } from './onboarding-model.ts';

/** One glyph per answer: the machine on the desk, and a machine across a network. */
const OPTIONS: readonly ChoiceOption[] = SETUP_TARGETS.map(target => ({
  id: target.id,
  title: target.title,
  line: target.answer,
  icon: target.id === 'this' ? <Laptop size={20} /> : <Network size={20} />,
}));

export interface OnboardingTargetChooserProps {
  readonly onChoose: (target: SetupTargetId) => void;
  /** Back to the entry question, which is what opened this one. */
  readonly onBack: () => void;
}

export function OnboardingTargetChooser({ onChoose, onBack }: OnboardingTargetChooserProps) {
  const [picked, setPicked] = useState<SetupTargetId | null>(null);
  return (
    <section className="flex min-w-0 flex-1 flex-col gap-3" aria-labelledby="onboarding-target-title">
      <div className="min-w-0">
        <h2 id="onboarding-target-title" className="m-0 font-display text-title font-bold tracking-display text-fg">
          Which computer runs the daemon?
        </h2>
        <p className="m-0 text-meta leading-base text-muted">
          The daemon runs your agents and needs a terminal. Every browser watching it is a client.
        </p>
      </div>

      <ChoiceCards
        label="Which computer runs the daemon?"
        options={OPTIONS}
        value={picked}
        onChange={id => {
          if (isSetupTargetId(id)) setPicked(id);
        }}
      />

      <div className="fy-ob-actions fy-ob-sticky" data-onboarding-actions="">
        <Button type="button" variant="ghost" onClick={onBack} data-onboarding-back="entry">
          Back
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={picked === null}
          onClick={() => {
            if (picked !== null) onChoose(picked);
          }}
          data-onboarding-continue=""
        >
          Continue
        </Button>
      </div>
    </section>
  );
}
