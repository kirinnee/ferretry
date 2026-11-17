import { codexLaunchFailure } from '@ferretry/plugin-runtimes/contract';
import type { HarnessPart } from './context.ts';

/** A pane that died starting, told in words. */
export const startFailurePart: HarnessPart<'startFailure'> = () => {
  return {
    // Today's RuntimeSupervisedLauncher: a pane that died starting because Codex could not reach the network is told
    // so in words. The sentence is fixed text; the screen is only matched, never quoted.
    startFailure: screen => codexLaunchFailure(screen),
  };
};
