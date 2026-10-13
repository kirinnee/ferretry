import type { HarnessLoginFlow } from '@ferretry/protocol';
import { WriteAuthority } from './account-authority.ts';
import { type AccountAuthority, type AccountCommandDeps, AccountCommandError } from './account-ports.ts';

/** How often a sign-in in progress is read back. */
export const SIGN_IN_POLL_MS = 1_000;

/**
 * Sign one credential in through the daemon, with this terminal as the screen.
 *
 * The daemon runs the harness's own sign-in and holds no token while it does. Claude prints a page to
 * open and then reads back the code that page shows, so this asks for it; Codex shows a page and a
 * code to type THERE, and finishes on its own. Either way the login lands in the credential's own
 * store, and the daemon checks it did.
 *
 * Returns whether it ended signed in. A failure sets a non-zero exit with the reason and the way back.
 */
export async function runSignIn(
  deps: AccountCommandDeps,
  credentialId: string,
  opened?: WriteAuthority,
): Promise<boolean> {
  const authority = await (opened ?? (await WriteAuthority.open(deps))).forApply();
  let flow = await deps.gateway.startSignIn(credentialId, authority);
  let shownApproval = false;
  let shownUrl: string | undefined;
  let codeSent = false;
  while (flow.state !== 'complete' && flow.state !== 'failed') {
    if (deps.now() >= Date.parse(flow.expiresAt)) {
      await cancelQuietly(deps, flow.flowId, authority);
      deps.out.error('Sign-in took too long and was stopped. Run it again to get a fresh link.');
      deps.out.setExitCode(1);
      return false;
    }
    if (flow.harness === 'claude' && flow.state === 'awaiting-code') {
      if (shownUrl !== flow.verificationUrl) {
        deps.out.report(`Open this page and sign in:\n  ${flow.verificationUrl}`);
        shownUrl = flow.verificationUrl;
      }
      if (!codeSent || flow.lastCode === 'rejected') {
        if (flow.lastCode === 'rejected')
          deps.out.warn('That code was not accepted. Copy the whole code and try again.');
        const next = await submitCode(deps, flow, authority);
        if (next === undefined) return false;
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
    await deps.sleep(SIGN_IN_POLL_MS);
    flow = await deps.gateway.signInStatus(flow.flowId, authority);
  }
  if (flow.state === 'complete') {
    deps.out.success(`Signed in. ${credentialId} is ready to use.`);
    return true;
  }
  deps.out.error(`Sign-in did not finish: ${flow.reason}`);
  deps.out.report(flow.remedy);
  deps.out.setExitCode(1);
  return false;
}

/** Ask for the code the provider's page shows, and hand it to the waiting harness. */
async function submitCode(
  deps: AccountCommandDeps,
  flow: HarnessLoginFlow,
  authority: AccountAuthority,
): Promise<HarnessLoginFlow | undefined> {
  if (!deps.interactive) {
    await cancelQuietly(deps, flow.flowId, authority);
    throw new AccountCommandError(
      'Claude Code sign-in needs a person to paste a code, so it cannot run without a terminal. Run it in a terminal, or sign in from the browser.',
    );
  }
  const code = (await deps.prompt.ask('Paste the code the page shows:')).trim();
  if (code === '') {
    await cancelQuietly(deps, flow.flowId, authority);
    deps.out.error('No code was given, so the sign-in was stopped.');
    deps.out.setExitCode(1);
    return undefined;
  }
  const submission = await deps.gateway.submitSignInCode(flow.flowId, code, authority);
  if (submission.outcome === 'accepted') return submission.flow;
  if (submission.outcome === 'unconfirmed') {
    deps.out.warn(submission.reason);
    return await deps.gateway.signInStatus(flow.flowId, authority);
  }
  await cancelQuietly(deps, flow.flowId, authority);
  deps.out.error(`The code could not be used: ${submission.reason}`);
  deps.out.setExitCode(1);
  return undefined;
}

/** Stop a sign-in this terminal is giving up on. A failure to stop it changes nothing about the answer. */
async function cancelQuietly(deps: AccountCommandDeps, flowId: string, authority: AccountAuthority): Promise<void> {
  try {
    await deps.gateway.cancelSignIn(flowId, authority);
  } catch {
    // The daemon bounds every sign-in in minutes, so one this could not stop still ends by itself.
  }
}
