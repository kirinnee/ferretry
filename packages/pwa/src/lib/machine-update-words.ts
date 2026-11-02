/** Where an owner updates their machine, in the words the Settings tab uses — said once, so every "update this machine" line agrees. */
export const UPDATE_MACHINE_WHERE = 'run “fy daemon update” (Settings › Machine › About & updates)';

/** The one line a Settings group says in place of a feature this machine's Ferretry is too old to offer. */
export const needsNewerFerretry = (what: string): string =>
  `${what} need a newer Ferretry on this machine: ${UPDATE_MACHINE_WHERE}.`;
