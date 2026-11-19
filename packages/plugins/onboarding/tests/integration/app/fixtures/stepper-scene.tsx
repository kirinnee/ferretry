/**
 * The browser entry for the first-run stepper over FAKE data (no daemon): the REAL `StepperView` on a Home-shaped page.
 *
 *   ?theme=<family>-<mode>
 *   ?case=none|fresh|login|done      none = Home before the stepper existed; fresh = a just-paired machine; login = the
 *                                    login step is the one to do; done = everything done, ready to dismiss
 */
import { createRoot } from 'react-dom/client';
import { deriveSteps, type StepperFacts } from '../../../../app/features/stepper/stepper-model.ts';
import { StepperView } from '../../../../app/features/stepper/stepper-view.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const scene = params.get('case') ?? 'fresh';

const FRESH: StepperFacts = { passkey: false, name: false, login: false, runtime: false, ferret: false };
const FACTS: Record<string, StepperFacts | undefined> = {
  none: undefined,
  fresh: FRESH,
  login: { passkey: true, name: true, login: false, runtime: false, ferret: false },
  done: { passkey: true, name: true, login: true, runtime: true, ferret: true },
};
const LABEL: Record<string, string> = {
  fresh: 'Add a passkey',
  login: 'Add a login',
};

const facts = FACTS[scene];
const label = LABEL[scene];
const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="mx-auto max-w-[1320px] p-3" data-scene-ready="">
      <h1 className="m-0 text-row font-semibold text-fg">studio-box</h1>
      <p className="mt-1 text-cell text-muted">Online</p>
      {facts === undefined ? null : (
        <StepperView
          action={label === undefined ? undefined : { label, run: () => undefined }}
          onDismiss={() => undefined}
          steps={deriveSteps(facts)}
        />
      )}
    </div>,
  );
