import type { AccountChange, AccountChangeOutcome, MachineView } from '@ferretry/plugin-runtimes/contract';
import { type MachineDeps, MachineCommandError, type MachineWriteOptions } from './ports.ts';
import { renderChangeOutcome, renderChangeView } from './render.ts';

/** Why this caller may not change the machine at all, in words, per shared grant refusal. */
const REFUSALS: Record<MachineView['authority']['applyRefusal'], string> = {
  'not-granted': "This caller is not allowed to change this machine's setup: the operator has not granted it.",
  'device-not-granted':
    "This device has not been given permission to change this machine's setup. Grant it at the machine with `device grant`, or from a device that holds it.",
  'step-up-required':
    'This change needs a passkey confirmation from a paired device, which a command line cannot give. Make it from the app, or run this on the machine itself.',
  undetermined: "This machine's grant settings could not be read, so no change is allowed until they are fixed.",
  granted: "This caller is not allowed to change this machine's setup.",
};

/**
 * Refuse a write in words, before anything is staged, when this caller may not change the machine. A caller ON this
 * machine is ungoverned and always passes: the daemon's answer here is the whole of what a write needs to know up front.
 */
export async function requireMayApply(deps: Pick<MachineDeps, 'gateway'>): Promise<void> {
  const { authority } = await deps.gateway.machine();
  if (!authority.mayApply) throw new MachineCommandError(REFUSALS[authority.applyRefusal]);
}

/** One change as a command asks for it. */
export interface ChangeRequest {
  readonly change: AccountChange;
  /**
   * Removes, replaces or signs out something. A destructive change asks before it applies (or needs --yes); anything
   * else applies straight after its preview, so nobody has to type "apply".
   */
  readonly destructive: boolean;
  readonly options: MachineWriteOptions;
}

/**
 * Ask a person to go ahead, or refuse in a script that did not say --yes. Off a terminal nobody can answer, so a
 * destructive step without --yes is refused with a non-zero exit rather than hanging or assuming yes.
 */
export async function confirmStep(
  deps: Pick<MachineDeps, 'prompt' | 'interactive' | 'out'>,
  question: string,
  yes: boolean | undefined,
): Promise<boolean> {
  if (yes) return true;
  if (!deps.interactive) {
    deps.out.error('Nothing was changed: this needs a yes. Re-run with --yes to go ahead without being asked.');
    deps.out.setExitCode(1);
    return false;
  }
  const answer = (await deps.prompt.ask(`${question} [y/N]`)).trim().toLowerCase();
  if (answer === 'y' || answer === 'yes') return true;
  deps.out.warn('Nothing was changed.');
  deps.out.setExitCode(1);
  return false;
}

/**
 * Stage one change, show its preview, and apply exactly what was previewed. The daemon derives the next setup from the
 * change and holds it until the explicit apply, so what a person approves here is what lands.
 *
 * Returns the outcome when it applied, `undefined` when it stopped (a dry run, a "no"). A failed apply sets a non-zero
 * exit, so a script can trust the status.
 */
export async function runChange(deps: MachineDeps, request: ChangeRequest): Promise<AccountChangeOutcome | undefined> {
  await requireMayApply(deps);
  const view = await deps.gateway.stage(request.change);
  const json = request.options.json === true;
  if (!json) deps.out.report(renderChangeView(view));
  if (request.options.dryRun) {
    if (json) deps.out.report(JSON.stringify({ change: view }, null, 2));
    else deps.out.report('Dry run: nothing was changed.');
    return undefined;
  }
  if (request.destructive && !(await confirmStep(deps, 'Go ahead?', request.options.yes))) return undefined;
  const outcome = await deps.gateway.apply(view.id);
  const rendered = renderChangeOutcome(outcome);
  if (json) deps.out.report(JSON.stringify({ change: view, outcome }, null, 2));
  else if (rendered.ok) deps.out.success(rendered.text);
  else deps.out.error(rendered.text);
  if (!rendered.ok) deps.out.setExitCode(1);
  return outcome;
}
