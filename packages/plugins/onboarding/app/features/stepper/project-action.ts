/**
 * THE PROJECT STEP'S TWO BUTTONS, as plain values. Each depends on its own plugin alone: "Create a project" needs the
 * Projects screen, "Continue a conversation" needs the Conversations screen. Either one missing (its plugin is paused)
 * leaves the other as the way through; both missing leaves no button.
 */
import type { ScreenHrefOf } from '@ferretry/app';
import { PROJECTLESS_WORDS } from './projectless-words.ts';
import type { StepperAction } from './stepper-view.tsx';

const CREATE = 'Create a project';
const CONTINUE = 'Continue a conversation';

/** The Projects screen with its add form already open (the hub reads this one word): no second "Add project" press. */
export const addProjectHref = (projectsHref: string): string => `${projectsHref}?add=1`;

/**
 * Where "Continue a conversation" goes: New ferret (the Conversations page is gone) with its continue section open.
 * `?continue=1` is the one word Ferrets' New ferret reads (`NEW_FERRET_CONTINUE_QUERY`, core-ferrets contract; Onboarding
 * does not depend on that package, so it is spelled here).
 */
export const continueConversationHref = (screenHref: ScreenHrefOf, daemon: string): string | undefined => {
  const newFerret = screenHref(daemon, 'ferrets', 'new-ferret');
  return newFerret === undefined ? undefined : `${newFerret}?continue=1`;
};

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
