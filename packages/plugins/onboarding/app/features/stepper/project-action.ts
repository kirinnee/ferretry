/**
 * THE PROJECT STEP'S TWO BUTTONS, as plain values. Each depends on its own plugin alone: "Create a project" needs the
 * Projects screen, "Continue a conversation" needs the Conversations screen. Either one missing (its plugin is paused)
 * leaves the other as the way through; both missing leaves no button.
 */
import { PROJECTLESS_WORDS } from './projectless-words.ts';
import type { StepperAction } from './stepper-view.tsx';

const CREATE = 'Create a project';
const CONTINUE = 'Continue a conversation';

/** The Projects screen with its add form already open (the hub reads this one word): no second "Add project" press. */
export const addProjectHref = (projectsHref: string): string => `${projectsHref}?add=1`;

export const projectAction = (
  create: (() => void) | undefined,
  resume: (() => void) | undefined,
): StepperAction | undefined => {
  if (create !== undefined)
    return {
      label: CREATE,
      run: create,
      alternative: resume === undefined ? undefined : { label: CONTINUE, run: resume },
      note: PROJECTLESS_WORDS,
    };
  return resume === undefined ? undefined : { label: CONTINUE, run: resume, note: PROJECTLESS_WORDS };
};
