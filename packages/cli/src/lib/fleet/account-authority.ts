import type { FleetMachineView } from '@ferretry/protocol';
import { type AccountCommandDeps, AccountCommandError } from './account-ports.ts';

type MachineAuthority = FleetMachineView['authority'];

/** Why this caller may not change the machine at all, in words, per shared grant refusal. */
const REFUSALS: Record<MachineAuthority['applyRefusal'], string> = {
  'not-granted': "This caller is not allowed to change this machine's setup: the operator has not granted it.",
  'step-up-required':
    'This change needs a passkey confirmation from a paired device, which a command line cannot give. Make it from the app, or run this on the machine itself.',
  undetermined: "This machine's grant settings could not be read, so no change is allowed until they are fixed.",
  granted: "This caller is not allowed to change this machine's setup.",
};

/**
 * Refuse a write in words, before anything is staged, when this caller may not change the machine.
 *
 * A caller ON this machine is ungoverned and always passes. There is nothing to carry afterwards: no
 * unlock, no password and no per-change confirmation exist, so the daemon's answer here is the whole
 * of what a write needs to know up front.
 */
export async function requireMayApply(deps: Pick<AccountCommandDeps, 'gateway'>): Promise<void> {
  const { authority } = await deps.gateway.machine();
  if (!authority.mayApply) throw new AccountCommandError(REFUSALS[authority.applyRefusal]);
}
