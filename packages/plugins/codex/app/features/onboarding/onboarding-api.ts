/**
 * What the Codex onboarding pages ask the daemon, and the small pure decisions they make from the answers.
 *
 * Every read is `quiet` (a page mounting is not a person's act, so it never raises a passkey prompt); an act the person
 * pressed (Install, a card that writes) is not. Nothing here holds a credential: the update view carries a version and a
 * path, the logins list carries status words and secret NAMES.
 */
import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { type LoginList, LoginListSchema, type LoginView } from '@ferretry/plugin-logins/contract';
import { SetupScanSchema, ToolInstallResultSchema, type ToolInstallOutcome } from '@ferretry/plugin-runtimes/contract';
import type { HarnessCliView } from '../../../contract/index.ts';

export type OnboardingClient = Pick<PluginClient, 'call' | 'subscribe'>;

/** What the setup flow hands a page (`PanelProps.step`): derived, so it follows the kernel's one definition. */
export type StepHost = NonNullable<PanelProps['step']>;

const ROUTES = {
  update: 'GET /v1/codex/update',
  scan: 'GET /v1/runtimes/setup/scan',
  install: 'POST /v1/runtimes/machine/tools/install',
  logins: 'GET /v1/logins',
} as const;

/** The command a person can run by hand when this machine cannot run an install for them. */
const MANUAL_INSTALL = 'npm install -g @openai/codex';

/** The sentence for a failed call: the daemon's own words, or that it did not answer. */
export const refusalWords = (cause: unknown): string => {
  const said = cause instanceof Error ? cause.message.trim() : '';
  return said === '' ? 'This machine did not answer.' : said;
};

// ── installed ────────────────────────────────────────────────────────────────────────────────────

export type InstallFacts =
  | { readonly state: 'found'; readonly version: string | null; readonly path: string | null }
  | {
      readonly state: 'missing';
      /** The exact command that would run, or why none can and what to run by hand. */
      readonly plan:
        | { readonly kind: 'runnable'; readonly command: string }
        | { readonly kind: 'manual'; readonly command: string; readonly reason: string };
    };

/** Whether the update view says Codex is on this machine: a readable or an unreadable version both mean "found". */
function codexFound(view: HarnessCliView): boolean {
  return view.installed !== null;
}

/** What `GET /v1/codex/update` says, as the page's facts (the install plan of a missing tool is read separately). */
export function factsOf(view: HarnessCliView): InstallFacts | null {
  if (!codexFound(view)) return null;
  return {
    state: 'found',
    version: view.installed?.state === 'ok' ? view.installed.version : null,
    path: view.location.state === 'located' ? view.location.path : null,
  };
}

export async function readUpdate(client: OnboardingClient): Promise<HarnessCliView> {
  return await client.call<HarnessCliView>(ROUTES.update, { quiet: true });
}

/** How a missing Codex would be installed, from the setup scan; a scan that cannot be read falls back to the manual command. */
export async function readInstallPlan(
  client: OnboardingClient,
  /** An explicit "Check again": the daemon looks the tools up now, not from its last ten seconds. */
  fresh = false,
): Promise<Extract<InstallFacts, { state: 'missing' }>['plan']> {
  try {
    const scan = SetupScanSchema.parse(
      await client.call(ROUTES.scan, { quiet: true, ...(fresh ? { query: { fresh: '1' } } : {}) }),
    );
    const tool = scan.tools.find(entry => entry.harness === 'codex');
    if (tool === undefined || tool.installed)
      return { kind: 'manual', command: MANUAL_INSTALL, reason: 'This machine did not say how to install Codex.' };
    return tool.install.kind === 'runnable'
      ? { kind: 'runnable', command: tool.install.command }
      : { kind: 'manual', command: tool.install.manualCommand, reason: tool.install.reason };
  } catch (cause) {
    return { kind: 'manual', command: MANUAL_INSTALL, reason: refusalWords(cause) };
  }
}

/** The daemon's refusal when the command it would run is no longer the one that was shown (the page then shows the new one). */
export const planChanged = (cause: unknown): boolean =>
  cause instanceof Error && cause.message.includes('is not the one that was shown');

/** One sentence for how the install ended, plus the manager's last (scrubbed) lines. */
export function installWords(outcome: ToolInstallOutcome | undefined): {
  readonly done: boolean;
  readonly words: string;
} {
  if (outcome === undefined) return { done: false, words: 'Nothing was installed.' };
  if (outcome.outcome === 'already-installed') return { done: true, words: 'Codex is already installed.' };
  const lines = outcome.output.length === 0 ? '' : `\n${outcome.output.join('\n')}`;
  if (outcome.outcome === 'installed') return { done: true, words: `Installed with: ${outcome.command}${lines}` };
  return { done: false, words: `${outcome.reason} To do it yourself, run: ${outcome.manualCommand}${lines}` };
}

/**
 * The install press: only ever the command that was SHOWN, through the daemon's fixed-argv runner (step-up asked by the
 * shell). The request names the shown command; the daemon compares it with its fresh plan before it starts anything, and
 * refuses with the new command when the machine changed in between, so a press can never run something the person did not see.
 */
export async function installCodex(client: OnboardingClient, shown: string): Promise<ReturnType<typeof installWords>> {
  const result = ToolInstallResultSchema.parse(
    await client.call(ROUTES.install, {
      body: { harnesses: ['codex'], shown: [{ harness: 'codex', command: shown }] },
    }),
  );
  return installWords(result.outcomes.find(entry => entry.harness === 'codex'));
}

// ── sign-in ──────────────────────────────────────────────────────────────────────────────────────

/**
 * A login that IS a Codex login: its own harness is Codex. A login whose primary harness is Claude Code that merely lists Codex
 * among the tools it can drive is not one: the Codex sign-in panel refuses it ("There is no Codex login <id>").
 */
const driveCodex = (login: LoginView): boolean => login.harness === 'codex';

/** A login that is switched on: a disabled one refuses every start, so it never counts as a way to sign in. */
const enabled = (login: LoginView): boolean => login.disabled === undefined;

/** Signed in and usable: switched on, and `ready` or about to refresh itself (`refresh_due`). */
const signedIn = (login: LoginView): boolean =>
  enabled(login) && (login.status.word === 'ready' || login.status.word === 'refresh_due');

export type SignInFacts =
  | { readonly state: 'signed-in'; readonly who: string; readonly id: string }
  /** A switched-on login that needs signing in AND can be signed in from here. */
  | { readonly state: 'needs-sign-in'; readonly login: LoginView }
  /** A switched-on login whose status is still being checked: not signed in, not yet known to need it. */
  | { readonly state: 'checking' }
  /** Nothing the person can sign in: no Codex login, only switched-off ones, or ones that cannot be signed in from here. */
  | { readonly state: 'no-login' };

/** Whether Codex has a login that works here, one that can be signed in, one still being checked, or none to use. */
export function signInFacts(list: LoginList): SignInFacts {
  const codex = list.logins.filter(driveCodex);
  const ready = codex.find(signedIn);
  if (ready !== undefined)
    return { state: 'signed-in', who: ready.email ?? ready.label ?? 'a Codex login', id: ready.id };
  const live = codex.filter(enabled);
  const signable = live.find(login => login.status.word === 'needs_sign_in' && login.signIn.available);
  if (signable !== undefined) return { state: 'needs-sign-in', login: signable };
  if (live.some(login => login.status.word === 'checking')) return { state: 'checking' };
  return { state: 'no-login' };
}

export async function readSignIn(client: OnboardingClient): Promise<SignInFacts> {
  return signInFacts(LoginListSchema.parse(await client.call(ROUTES.logins, { quiet: true })));
}
