/**
 * What `onboard` says, in one place. Sentences that still apply from today's `fy setup` keep their words
 * (`Ferretry is set up.`, `Next:`, `[Y/n]`); the linked sign-in line is design §6.1.
 */

// GAP(cli-shell): `CliContext` does not carry the binary's name, so the one place that names it is here (two-name
// model: the binary is the `bin` key of packages/cli/package.json).
export const BIN = 'fy';

/** The costs of linking an existing sign-in (§6.1), ONE line, with the way out. */
export const linkCosts = (bin: string): string =>
  `This uses the sign-in your terminal already has, so ferrets share your quota and your provider account, signing out in your terminal signs them out too, and Usage cannot tell your spend from theirs; add a separate Ferretry login any time with \`${bin} login add\`.`;

export const NO_STEPS = 'No plugin adds a first-run step.';
export const ALL_SET = 'Ferretry is set up.';
export const WAITING_NO_TERMINAL = (bin: string): string =>
  `Some steps are waiting for you. Run \`${bin} onboard\` in a terminal to answer them, or add --yes to leave them for later.`;
