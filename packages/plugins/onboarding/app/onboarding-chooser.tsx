/**
 * THE FIRST SCREEN ASKS WHAT THE READER HAS, which is the only thing this page cannot detect.
 *
 * Three cards, one answer, then a button. The cards are `ChoiceCards` (a native radio group that never stretches to the
 * page's width and plays a short select animation), so SELECTING DOES NOTHING BUT SELECT: the arrow keys move the
 * selection exactly as a radio group does, and a card that started a journey on selection would start one for a person who
 * only pressed an arrow. The journey starts on **Continue**, which stays off until a card is chosen.
 *
 * NONE OF THE THREE CLAIMS ANYTHING ABOUT THIS DEVICE, so none of them has to be refused on one. They are three states of
 * the reader's world:
 *
 * - First time: nothing exists yet. Get a daemon running, then pair, then set it up.
 * - Pair: a daemon exists and they hold a QR or a link for it. Straight to pairing, then this device's own setup.
 * - Set up a new daemon: a fleet exists and they want one more machine in it. The SAME daemon subflow.
 *
 * A BROWSER THAT HAS PAIRED BEFORE NEVER SEES THIS. `first-run-entry.ts` sends it to its fleet, and the composition root
 * honours that before this component is ever rendered. (The two repeat answers are also reachable from inside the app,
 * from the daemon list.) There is no Back, because there is nothing behind it.
 */

import { ChoiceCards, type ChoiceOption } from '@ferretry/app';
import { Button } from '@ferretry/app/ui';
import { QrCode, Rocket, Server } from 'lucide-react';
import { useState } from 'react';

import { isOnboardingRouteId, ONBOARDING_ROUTES, type OnboardingRouteId } from './onboarding-model.ts';

/**
 * One glyph per answer, chosen so the shapes differ at a glance rather than merely decorating: a launch, the thing the
 * reader is holding, a rack. Hidden from assistive technology by the card itself; the title already says the same thing.
 */
const OPTIONS: readonly ChoiceOption[] = ONBOARDING_ROUTES.map(route => ({
  id: route.id,
  title: route.title,
  line: route.answer,
  icon:
    route.id === 'first-time' ? (
      <Rocket size={20} />
    ) : route.id === 'add-client' ? (
      <QrCode size={20} />
    ) : (
      <Server size={20} />
    ),
}));

export interface OnboardingChooserProps {
  readonly onChoose: (route: OnboardingRouteId) => void;
}

export function OnboardingChooser({ onChoose }: OnboardingChooserProps) {
  const [picked, setPicked] = useState<OnboardingRouteId | null>(null);
  return (
    <section className="flex min-w-0 flex-1 flex-col gap-3" aria-labelledby="onboarding-chooser-title">
      <div className="min-w-0">
        <h2 id="onboarding-chooser-title" className="m-0 font-display text-title font-bold tracking-display text-fg">
          What do you want to do?
        </h2>
        <p className="m-0 text-meta leading-base text-muted">
          Ferretry runs your agents on a computer. Any browser, including this one, is a window onto it.
        </p>
      </div>

      <ChoiceCards
        label="What do you want to do?"
        options={OPTIONS}
        value={picked}
        onChange={id => {
          if (isOnboardingRouteId(id)) setPicked(id);
        }}
      />

      <div className="fy-ob-actions fy-ob-sticky" data-onboarding-actions="">
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
