/**
 * The browser entry for the first-run stepper over FAKE data (no daemon): the REAL `StepperView` on a Home-shaped page.
 *
 *   ?theme=<family>-<mode>
 *   ?case=none|fresh|setup|project|paused|resumed|done
 *            none = Home before the stepper existed; fresh = a just-paired machine; setup = the setup flow (Claude
 *            Code, Codex, …) is the one to do; project = the last step (Create a project / Continue a conversation, with the projectless
 *            words); paused = the same step with the Projects plugin paused (Continue a conversation is the one
 *            button, still with the projectless words); resumed = a reload mid-way (name is the one to do); done = everything done, ready to dismiss
 */
import { createRoot } from 'react-dom/client';
import { PROJECTLESS_WORDS } from '../../../../app/features/stepper/projectless-words.ts';
import { deriveSteps, type StepperFacts } from '../../../../app/features/stepper/stepper-model.ts';
import { StepperView } from '../../../../app/features/stepper/stepper-view.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const scene = params.get('case') ?? 'fresh';

const FRESH: StepperFacts = { passkey: false, name: false, setup: false, project: false };
const FACTS: Record<string, StepperFacts | undefined> = {
  none: undefined,
  fresh: FRESH,
  setup: { passkey: true, name: true, setup: false, project: false },
  project: { passkey: true, name: true, setup: true, project: false },
  paused: { passkey: true, name: true, setup: true, project: false },
  resumed: { passkey: true, name: false, setup: false, project: false },
  done: { passkey: true, name: true, setup: true, project: true },
};
const LABEL: Record<string, string> = {
  fresh: 'Add a passkey',
  setup: 'Continue setup',
  project: 'Create a project',
  paused: 'Continue a conversation',
  resumed: 'Name this machine',
};

const facts = FACTS[scene];
const label = LABEL[scene];
const lastStep = scene === 'project' || scene === 'paused';
const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="mx-auto max-w-[1320px] p-3" data-scene-ready="">
      <h1 className="m-0 text-row font-semibold text-fg">studio-box</h1>
      <p className="mt-1 text-cell text-muted">Online</p>
      {facts === undefined ? null : (
        <StepperView
          action={
            label === undefined
              ? undefined
              : {
                  label,
                  run: () => undefined,
                  ...(lastStep ? { note: PROJECTLESS_WORDS } : {}),
                  ...(scene === 'project'
                    ? { alternative: { label: 'Continue a conversation', run: () => undefined } }
                    : {}),
                }
          }
          onDismiss={() => undefined}
          steps={deriveSteps(facts)}
        />
      )}
    </div>,
  );
