import type { HarnessPart } from './context.ts';

/** Changing a running ferret's model, effort or fast mode: present only when the composition supplies it. */
export const runtimeSwitchPart: HarnessPart<'runtimeSwitch'> = ({ options }) => {
  return {
    ...(options.runtimeSwitch === undefined ? {} : { runtimeSwitch: options.runtimeSwitch }),
  };
};
