import type { FleetAccountChange, FleetAccountChangeOutcome } from '@ferretry/protocol';
import { WriteAuthority } from './account-authority.ts';
import type { AccountCommandDeps, AccountWriteOptions } from './account-ports.ts';
import { renderChangeOutcome, renderChangeView } from './account-render.ts';

/** One change as a command asks for it. */
export interface ChangeRequest {
  readonly change: FleetAccountChange;
  /**
   * Removes, replaces or signs out something. A destructive change asks before it applies (or needs
   * --yes); anything else applies straight after its preview, so nobody has to type "apply".
   */
  readonly destructive: boolean;
  readonly options: AccountWriteOptions;
}

/**
 * Ask a person to go ahead, or refuse in a script that did not say --yes.
 *
 * Off a terminal nobody can answer, so a destructive step without --yes is refused with a non-zero
 * exit rather than hanging or assuming yes.
 */
export async function confirmStep(
  deps: Pick<AccountCommandDeps, 'prompt' | 'interactive' | 'out'>,
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
 * Stage one change, show its preview, and apply exactly what was previewed.
 *
 * The daemon derives the next setup from the change and holds it until the explicit apply, so what a
 * person approves here is what lands — the same reviewed path the browser takes. A caller off this
 * machine is asked for the operator password at most once per command.
 *
 * Returns the outcome when it applied, `undefined` when it stopped (a dry run, a "no"). A failed
 * apply sets a non-zero exit, so a script can trust the status.
 */
export async function runChange(
  deps: AccountCommandDeps,
  request: ChangeRequest,
): Promise<FleetAccountChangeOutcome | undefined> {
  const authority = await WriteAuthority.open(deps);
  const view = await deps.gateway.stage(request.change, authority.current);
  const json = request.options.json === true;
  if (!json) deps.out.report(renderChangeView(view));
  if (request.options.dryRun) {
    if (json) deps.out.report(JSON.stringify({ change: view }, null, 2));
    else deps.out.report('Dry run: nothing was changed.');
    return undefined;
  }
  if (request.destructive && !(await confirmStep(deps, 'Go ahead?', request.options.yes))) return undefined;
  const outcome = await deps.gateway.apply(view.id, await authority.forApply());
  const rendered = renderChangeOutcome(outcome);
  if (json) deps.out.report(JSON.stringify({ change: view, outcome }, null, 2));
  else if (rendered.ok) deps.out.success(rendered.text);
  else deps.out.error(rendered.text);
  if (!rendered.ok) deps.out.setExitCode(1);
  return outcome;
}
