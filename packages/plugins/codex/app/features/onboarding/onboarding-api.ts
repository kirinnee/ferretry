/**
 * What the Codex onboarding pages ask the daemon, and the small pure decisions they make from the answers.
 *
 * Every read is `quiet` (a page mounting is not a person's act, so it never raises a passkey prompt); an act the person
 * pressed (Install, a card that writes) is not. Nothing here holds a credential: the update view carries a version and a
 * path, the logins list carries status words and secret NAMES, and the config file carries a permission mode.
 */
import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { type LoginList, LoginListSchema, type LoginView } from '@ferretry/plugin-logins/contract';
import { SetupScanSchema, ToolInstallResultSchema, type ToolInstallOutcome } from '@ferretry/plugin-runtimes/contract';
import { HIDDEN_VALUE_TEXT } from '@ferretry/std/secret-reference';
import { editConfigText, readConfigText } from '@ferretry/std/yaml';
import { type HarnessCliView, PermissionModeSchema } from '../../../contract/index.ts';
import type { z } from 'zod';

export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export type OnboardingClient = Pick<PluginClient, 'call' | 'subscribe'>;

/** What the setup flow hands a page (`PanelProps.step`): derived, so it follows the kernel's one definition. */
export type StepHost = NonNullable<PanelProps['step']>;

const ROUTES = {
  update: 'GET /v1/codex/update',
  scan: 'GET /v1/runtimes/setup/scan',
  install: 'POST /v1/runtimes/machine/tools/install',
  logins: 'GET /v1/logins',
  readFile: 'GET /v1/config/file',
  writeFile: 'PUT /v1/config/file',
} as const;

/** The file `permissionMode` lives in (`config/harness-codex.yaml`), as the config routes name it. */
const CODEX_CONFIG_FILE = 'harness-codex.yaml';

/** The command a person can run by hand when this machine cannot run an install for them. */
const MANUAL_INSTALL = 'npm install -g @openai/codex';

/** The permission cards' one-line words, and what Skip allows in plain words (the flag is drawn as code beside it). */
export const SKIP_WORDS = 'No approvals, no sandbox.';
export const SKIP_PLAIN = 'Runs every command without asking, even deleting files.';
export const SKIP_FLAG = '--dangerously-bypass-approvals-and-sandbox';
export const AUTO_WORDS = 'Asks before risky things.';

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
): Promise<Extract<InstallFacts, { state: 'missing' }>['plan']> {
  try {
    const scan = SetupScanSchema.parse(await client.call(ROUTES.scan, { quiet: true }));
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

/** A login that drives Codex. */
const driveCodex = (login: LoginView): boolean => login.harnesses.includes('codex');

/** A login that is switched on: a disabled one refuses every start, so it never counts as a way to sign in. */
const enabled = (login: LoginView): boolean => login.disabled === undefined;

/** Signed in and usable: switched on, and `ready` or about to refresh itself (`refresh_due`). */
const signedIn = (login: LoginView): boolean =>
  enabled(login) && (login.status.word === 'ready' || login.status.word === 'refresh_due');

export type SignInFacts =
  | { readonly state: 'signed-in'; readonly who: string }
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
  if (ready !== undefined) return { state: 'signed-in', who: ready.email ?? ready.label ?? 'a Codex login' };
  const live = codex.filter(enabled);
  const signable = live.find(login => login.status.word === 'needs_sign_in' && login.signIn.available);
  if (signable !== undefined) return { state: 'needs-sign-in', login: signable };
  if (live.some(login => login.status.word === 'checking')) return { state: 'checking' };
  return { state: 'no-login' };
}

export async function readSignIn(client: OnboardingClient): Promise<SignInFacts> {
  return signInFacts(LoginListSchema.parse(await client.call(ROUTES.logins, { quiet: true })));
}

// ── permission ───────────────────────────────────────────────────────────────────────────────────

/**
 * The permission mode a `harness-codex.yaml` text says, read by the shared config parser (so a flow map, a folded scalar,
 * a quoted key and an inline comment all read right): an absent key is `skip` (the default, owner !A525); a text that does not
 * parse, is not a mapping of keys, or holds a mode this page does not know is `null` — unknown, never guessed.
 */
export function modeOf(text: string): PermissionMode | null {
  const read = readConfigText(text);
  if (!read.ok) return null;
  const { value } = read.read;
  if (value === null || value === undefined) return 'skip';
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const said = (value as Record<string, unknown>).permissionMode;
  if (said === undefined || said === null) return 'skip';
  const parsed = PermissionModeSchema.safeParse(said);
  return parsed.success ? parsed.data : null;
}

/**
 * The text with ONLY `permissionMode` changed, by the shared config editor: a scalar is changed in place (so a comment on its
 * line stays), a missing key is added, and every other key and comment is kept byte for byte. It throws on a text it cannot read
 * as a mapping, rather than replacing the file: a file nobody can read is fixed by a person.
 */
export function withMode(text: string, mode: PermissionMode): string {
  const read = readConfigText(text);
  const value = read.ok ? read.read.value : undefined;
  if (!read.ok || modeOf(text) === null) throw new Error('the file cannot be edited here');
  const now = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return editConfigText(text, { ...now, permissionMode: mode }, now, undefined);
}

export interface ConfigFile {
  readonly text: string;
  readonly etag: string;
  /** Where the file is on the machine, for "Change this at the machine: <file>". */
  readonly where: string;
  /** The daemon did not show the text (a value in it looks like a credential, or it does not parse): it must not be written. */
  readonly withheld: boolean;
}

/** The mode this file says, or `null` when it cannot be known here (withheld, unparsable, or an unknown mode): then nothing is written. */
export const currentMode = (file: ConfigFile): PermissionMode | null => (file.withheld ? null : modeOf(file.text));

/** The sentence for a file this page cannot read or edit safely. */
export const changeAtMachineWords = (file: ConfigFile): string => `Change this at the machine: ${file.where}`;

/** The daemon's shown comment for a file whose text it withholds starts with the hidden mark; its issue says the same. */
const withheldView = (text: string, issues: readonly { readonly message?: string }[]): boolean =>
  text.startsWith(`# ${HIDDEN_VALUE_TEXT}`) ||
  issues.some(issue => issue.message?.startsWith('the text of this file is not shown') === true);

export async function readConfig(client: OnboardingClient): Promise<ConfigFile> {
  const file = (await client.call(ROUTES.readFile, { quiet: true, query: { path: CODEX_CONFIG_FILE } })) as {
    readonly text?: string;
    readonly etag?: string;
    readonly absolutePath?: string;
    readonly issues?: readonly { readonly message?: string }[];
  };
  const text = file.text ?? '';
  return {
    text,
    etag: file.etag ?? '',
    where: file.absolutePath ?? `config/${CODEX_CONFIG_FILE}`,
    withheld: withheldView(text, file.issues ?? []),
  };
}

/** What a mode write did: in effect now, or written and held until the owner confirms it. Never called for a file whose mode is unknown. */
export async function writeMode(
  client: OnboardingClient,
  file: ConfigFile,
  mode: PermissionMode,
): Promise<'applied' | 'held'> {
  // The last line of defence: a withheld, unparsable or unknown file is never written, whatever the page decided.
  if (currentMode(file) === null) throw new Error(changeAtMachineWords(file));
  const answer = (await client.call(ROUTES.writeFile, {
    body: { path: CODEX_CONFIG_FILE, text: withMode(file.text, mode), etag: file.etag },
  })) as { readonly outcome?: string };
  return answer.outcome === 'pending' ? 'held' : 'applied';
}
