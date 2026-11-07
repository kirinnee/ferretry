import type { HarnessLoginCodexMethod, HarnessLoginFlow } from '@ferretry/protocol';
import { requireMayApply } from './account-authority.ts';
import { type AccountCommandDeps, AccountCommandError } from './account-ports.ts';

/** How often a sign-in in progress is read back. */
export const SIGN_IN_POLL_MS = 1_000;

/** How one sign-in attempt ended. `failed` is not reported yet, so the caller can offer a link first. */
type Attempt =
  | { readonly kind: 'signed-in' }
  | { readonly kind: 'stopped' }
  | {
      readonly kind: 'failed';
      readonly flow: Extract<HarnessLoginFlow, { state: 'failed' }>;
      readonly device: boolean;
    };

/**
 * Sign one credential in through the daemon, with this terminal as the screen.
 *
 * The daemon runs the harness's own sign-in and holds no token while it does. Claude prints a page to
 * open and then reads back the code that page shows, so this asks for it; Codex shows a page and a
 * code to type THERE, and finishes on its own. When an account has Codex device codes turned off, the
 * daemon moves to Codex's link sign-in by itself, and this asks for the address the browser ends on.
 * When a device code fails for any other reason, this offers that link sign-in. Either way the login
 * lands in the credential's own store, and the daemon checks it did.
 *
 * A credential has at most one sign-in running. Without `force` this PICKS UP the one already running —
 * started in the browser, or by a terminal that went away — and says so; with it, that one is ended,
 * any leftover Codex sign-in on the callback port is cleared, and a fresh one starts.
 *
 * Returns whether it ended signed in. A failure sets a non-zero exit with the reason and the way back.
 */
export async function runSignIn(
  deps: AccountCommandDeps,
  credentialId: string,
  options: { readonly force?: boolean } = {},
): Promise<boolean> {
  await requireMayApply(deps);
  let attempt = await attemptSignIn(deps, credentialId, undefined, options.force === true);
  // A harness that FINISHED but left nothing to find did not fail at its device code: look again instead.
  if (attempt.kind === 'failed' && attempt.flow.recheck === true && deps.interactive)
    attempt = await lookAgain(deps, attempt);
  else if (attempt.kind === 'failed' && attempt.device && deps.interactive) {
    deps.out.warn(`The device code did not work: ${attempt.flow.reason}`);
    const answer = (await deps.prompt.ask('Sign in with a link instead? [y/N]')).trim().toLowerCase();
    if (answer === 'y' || answer === 'yes') attempt = await attemptSignIn(deps, credentialId, 'link');
  }
  if (attempt.kind === 'signed-in') {
    deps.out.success(`Signed in. ${credentialId} is ready to use.`);
    return true;
  }
  if (attempt.kind === 'failed') {
    deps.out.error(`Sign-in did not finish: ${attempt.flow.reason}`);
    deps.out.report(attempt.flow.remedy);
    deps.out.setExitCode(1);
  }
  return false;
}

/**
 * The harness finished but its login was not found: say where the daemon looked, and offer to look
 * again — launching nothing — for as long as the person wants. A login that landed late, or that the
 * keychain would not hand over a moment ago, then counts. Declining keeps the failure as it was.
 */
async function lookAgain(deps: AccountCommandDeps, failed: Extract<Attempt, { kind: 'failed' }>): Promise<Attempt> {
  deps.out.warn(failed.flow.reason);
  const wanted = async (): Promise<boolean> =>
    ['', 'y', 'yes'].includes(
      (await deps.prompt.ask('Look for the login again, without signing in again? [Y/n]')).trim().toLowerCase(),
    );
  while (await wanted()) {
    const looked = await deps.gateway.recheckSignIn(failed.flow.flowId);
    // Refused is "still not there", with what this look found; anything else is not worth asking again.
    if (looked.outcome !== 'refused')
      return looked.outcome === 'accepted' && looked.flow.state === 'complete' ? { kind: 'signed-in' } : failed;
    deps.out.warn(looked.reason);
  }
  return failed;
}

/** Run one sign-in to its end, showing what it needs as it goes. */
async function attemptSignIn(
  deps: AccountCommandDeps,
  credentialId: string,
  method?: HarnessLoginCodexMethod,
  restart = false,
): Promise<Attempt> {
  let flow = await deps.gateway.startSignIn(credentialId, method, restart);
  if (flow.resumed === true) {
    deps.out.report(
      `A sign-in for ${credentialId} was already running, so this picks it up. To start over instead: ${deps.binaryName} credential signin ${credentialId} --force`,
    );
  }
  let shownApproval = false;
  let shownUrl: string | undefined;
  let shownFinishing = false;
  let codeSent = false;
  let linked = method === 'link';
  while (flow.state !== 'complete' && flow.state !== 'failed') {
    if (deps.now() >= Date.parse(flow.expiresAt)) {
      await cancelQuietly(deps, flow.flowId);
      deps.out.error('Sign-in took too long and was stopped. Run it again to get a fresh link.');
      deps.out.setExitCode(1);
      return { kind: 'stopped' };
    }
    if (flow.harness === 'claude' && flow.state === 'awaiting-code') {
      if (shownUrl !== flow.verificationUrl) {
        deps.out.report(`Open this page and sign in:\n  ${flow.verificationUrl}`);
        shownUrl = flow.verificationUrl;
      }
      if (!codeSent || flow.lastCode === 'rejected') {
        if (flow.lastCode === 'rejected')
          deps.out.warn('That code was not accepted. Copy the whole code and try again.');
        const next = await submitCode(deps, flow);
        if (next === undefined) return { kind: 'stopped' };
        codeSent = true;
        flow = next;
        continue;
      }
    }
    if (flow.harness === 'codex' && flow.state === 'awaiting-approval' && !shownApproval) {
      deps.out.report(`Open this page and enter the code ${flow.userCode}:\n  ${flow.verificationUrl}`);
      deps.out.report('Waiting for you to approve it there…');
      shownApproval = true;
    }
    if (flow.harness === 'codex' && flow.state === 'awaiting-callback') {
      linked = true;
      if (shownUrl !== flow.verificationUrl) {
        if (flow.deviceCode === 'unavailable')
          deps.out.warn('This account does not allow device codes, so Codex will sign in with a link instead.');
        deps.out.report(`Open this page on any device and sign in:\n  ${flow.verificationUrl}`);
        deps.out.report(
          'Afterwards the browser goes to a page that does not load (its address starts with http://localhost). That is expected: copy that page’s whole address.',
        );
        shownUrl = flow.verificationUrl;
      }
      const next = await submitAddress(deps, flow);
      if (next === undefined) return { kind: 'stopped' };
      flow = next;
      continue;
    }
    if (flow.harness === 'codex' && flow.state === 'finishing' && !shownFinishing) {
      deps.out.report('Codex is finishing the sign-in…');
      shownFinishing = true;
    }
    await deps.sleep(SIGN_IN_POLL_MS);
    flow = await deps.gateway.signInStatus(flow.flowId);
  }
  if (flow.state === 'complete') return { kind: 'signed-in' };
  return { kind: 'failed', flow, device: flow.harness === 'codex' && !linked };
}

/** Ask for the code the provider's page shows, and hand it to the waiting harness. */
async function submitCode(deps: AccountCommandDeps, flow: HarnessLoginFlow): Promise<HarnessLoginFlow | undefined> {
  if (!deps.interactive) {
    await cancelQuietly(deps, flow.flowId);
    throw new AccountCommandError(
      'Claude Code sign-in needs a person to paste a code, so it cannot run without a terminal. Run it in a terminal, or sign in from the browser.',
    );
  }
  const code = (await deps.prompt.ask('Paste the code the page shows:')).trim();
  if (code === '') {
    await cancelQuietly(deps, flow.flowId);
    deps.out.error('No code was given, so the sign-in was stopped.');
    deps.out.setExitCode(1);
    return undefined;
  }
  const submission = await deps.gateway.submitSignInCode(flow.flowId, code);
  if (submission.outcome === 'accepted') return submission.flow;
  if (submission.outcome === 'unconfirmed') {
    deps.out.warn(submission.reason);
    return await deps.gateway.signInStatus(flow.flowId);
  }
  await cancelQuietly(deps, flow.flowId);
  deps.out.error(`The code could not be used: ${submission.reason}`);
  deps.out.setExitCode(1);
  return undefined;
}

/**
 * Ask for the address a Codex link sign-in ended on, and hand it to Codex on the machine.
 *
 * An address the daemon refuses is asked for again with the reason, because the usual mistake is a
 * partial copy. One the daemon says it cannot take any more may still have finished — Codex can also
 * complete in a browser on the machine itself — so that is read back before it is called a failure.
 */
async function submitAddress(deps: AccountCommandDeps, flow: HarnessLoginFlow): Promise<HarnessLoginFlow | undefined> {
  if (!deps.interactive) {
    await cancelQuietly(deps, flow.flowId);
    throw new AccountCommandError(
      'This Codex sign-in needs a person to paste an address, so it cannot run without a terminal. Run it in a terminal, or sign in from the browser.',
    );
  }
  const address = (await deps.prompt.ask('Paste the address of the page that did not load:')).trim();
  if (address === '') {
    await cancelQuietly(deps, flow.flowId);
    deps.out.error('No address was given, so the sign-in was stopped.');
    deps.out.setExitCode(1);
    return undefined;
  }
  const submission = await deps.gateway.submitSignInCode(flow.flowId, address);
  if (submission.outcome === 'accepted') return submission.flow;
  if (submission.outcome === 'refused') {
    deps.out.warn(submission.reason);
    return flow;
  }
  if (submission.outcome === 'unconfirmed') deps.out.warn(submission.reason);
  return await deps.gateway.signInStatus(flow.flowId);
}

/** Stop a sign-in this terminal is giving up on. A failure to stop it changes nothing about the answer. */
async function cancelQuietly(deps: AccountCommandDeps, flowId: string): Promise<void> {
  try {
    await deps.gateway.cancelSignIn(flowId);
  } catch {
    // The daemon bounds every sign-in in minutes, so one this could not stop still ends by itself.
  }
}
