import type { VerbInvocation } from '@ferretry/kernel/manifest';
import { type LoginsCommandDeps, LoginsCommandError } from './ports.ts';
import {
  renderLoginList,
  renderLoginRow,
  renderModelCatalogs,
  renderModelRefresh,
  renderPresetList,
} from './render.ts';
import { runSignIn } from './sign-in.ts';

/** The exit code of a verb whose daemon route this build does not serve (the same word every half uses). */
export const UNAVAILABLE = 69;

/** One verb: it prints through `deps.out`, sets the exit code there and refuses by throwing a `LoginsCommandError`. */
export type VerbBody = (deps: LoginsCommandDeps, invocation: VerbInvocation) => Promise<void>;

/** A switch that is on: `--name`, `--name=true`. */
const flagOn = (invocation: VerbInvocation, ...names: readonly string[]): boolean =>
  names.some(name => invocation.options[name] === true || invocation.options[name] === 'true');

/** A required positional, or a refusal naming what is missing. */
function loginArg(invocation: VerbInvocation): string {
  const value = invocation.args[0];
  if (value === undefined || value === '') throw new LoginsCommandError('Say which login.');
  return value;
}

/** `login ls`: the Sign-ins tab in a terminal. */
export const loginLs: VerbBody = async (deps, invocation) => {
  const list = await deps.gateway.logins();
  deps.out.report(flagOn(invocation, 'json') ? JSON.stringify(list, null, 2) : renderLoginList(list, deps.binaryName));
};

/** `login check <id>`: check now whether a login still works (a refresh for Codex). */
export const loginCheck: VerbBody = async (deps, invocation) => {
  const id = loginArg(invocation);
  const view = await deps.gateway.check(id);
  deps.out.report(
    flagOn(invocation, 'json') ? JSON.stringify(view, null, 2) : renderLoginRow(view, deps.binaryName).join('\n'),
  );
  if (view.status.word === 'needs_sign_in') {
    if (!flagOn(invocation, 'json')) deps.out.error(`${id} needs sign-in: ${deps.binaryName} login signin ${id}`);
    deps.out.setExitCode(1);
  }
};

/** `login test <id> [--allow-inference]`: one call, the cheapest its provider allows. */
export const loginTest: VerbBody = async (deps, invocation) => {
  const id = loginArg(invocation);
  const result = await deps.gateway.test(id, flagOn(invocation, 'allow-inference'));
  const json = flagOn(invocation, 'json');
  deps.out.report(json ? JSON.stringify(result, null, 2) : `${id}: ${result.message}`);
  if (result.code === 'consent_required' && !json) {
    deps.out.error(`To send it: ${deps.binaryName} login test ${id} --allow-inference`);
  }
  if (!result.ok) deps.out.setExitCode(1);
};

/** `login presets`: the provider presets an environment login can be made from. */
export const loginPresets: VerbBody = async (deps, invocation) => {
  const catalog = await deps.gateway.presets();
  deps.out.report(
    flagOn(invocation, 'json') ? JSON.stringify(catalog, null, 2) : renderPresetList(catalog, deps.binaryName),
  );
};

/** `login signin <id> [--force]`: the harness's own sign-in, this terminal as the screen. */
export const loginSignin: VerbBody = async (deps, invocation) => {
  await runSignIn(deps, loginArg(invocation), { force: flagOn(invocation, 'force') });
};

/** `login models list`: every model catalog in effect, where it came from, and its models by tier. */
export const loginModelsList: VerbBody = async (deps, invocation) => {
  const view = await deps.gateway.models();
  deps.out.report(flagOn(invocation, 'json') ? JSON.stringify(view, null, 2) : renderModelCatalogs(view));
};

/** `login models refresh`: check now for a newer published model catalog. */
export const loginModelsRefresh: VerbBody = async (deps, invocation) => {
  const result = await deps.gateway.refreshModels();
  deps.out.report(flagOn(invocation, 'json') ? JSON.stringify(result, null, 2) : renderModelRefresh(result));
};

/**
 * The verbs that CHANGE a login (`add`, `signout`, `disable`, `enable`, `label`, `rm`) go through a reviewed
 * change — stage, preview, apply — whose routes are Runtimes' (`/v1/runtimes/proposals`), and Logins' own client
 * cannot call another plugin's route. Said plainly, exit 69, nothing changed, rather than pretended.
 * GAP(runtimes): the login-change verbs wait on a route Logins may call.
 */
export const loginChangeUnavailable =
  (verb: string): VerbBody =>
  async deps => {
    deps.out.error(
      `${deps.binaryName} ${verb}: changing a login goes through the reviewed change route, which this command cannot reach yet; nothing was changed. Use the app (Settings › Logins) meanwhile.`,
    );
    deps.out.setExitCode(UNAVAILABLE);
  };
