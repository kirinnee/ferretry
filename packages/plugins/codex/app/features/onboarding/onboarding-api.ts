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

/** What `permissionMode: skip` allows, in the words the page says before the person chooses it (the flag is drawn as code). */
export const SKIP_LEAD = "Codex runs every command without asking you, including deleting files. This is Codex's";
export const SKIP_FLAG = '--dangerously-bypass-approvals-and-sandbox';
export const SKIP_TAIL = ': no approvals, no sandbox. Fastest, and only safe on a machine you would let it wipe.';
export const AUTO_WORDS = 'Codex asks before anything risky.';

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

/** The install press: only ever the shown command, through the daemon's fixed-argv runner (step-up asked by the shell). */
export async function installCodex(client: OnboardingClient): Promise<ReturnType<typeof installWords>> {
  const result = ToolInstallResultSchema.parse(await client.call(ROUTES.install, { body: { harnesses: ['codex'] } }));
  return installWords(result.outcomes.find(entry => entry.harness === 'codex'));
}

// ── sign-in ──────────────────────────────────────────────────────────────────────────────────────

/** A login that drives Codex. */
const driveCodex = (login: LoginView): boolean => login.harnesses.includes('codex');

/** Signed in and usable: `ready`, or about to refresh itself (`refresh_due`). */
const signedIn = (login: LoginView): boolean => login.status.word === 'ready' || login.status.word === 'refresh_due';

export type SignInFacts =
  | { readonly state: 'signed-in'; readonly who: string }
  | { readonly state: 'needs-sign-in'; readonly login: LoginView }
  | { readonly state: 'no-login' };

/** Whether Codex has a login that works here, one that needs signing in, or none at all. */
function signInFacts(list: LoginList): SignInFacts {
  const codex = list.logins.filter(driveCodex);
  const ready = codex.find(signedIn);
  if (ready !== undefined) return { state: 'signed-in', who: ready.email ?? ready.label ?? 'a Codex login' };
  const waiting = codex.find(login => login.status.word !== 'checking') ?? codex[0];
  return waiting === undefined ? { state: 'no-login' } : { state: 'needs-sign-in', login: waiting };
}

export async function readSignIn(client: OnboardingClient): Promise<SignInFacts> {
  return signInFacts(LoginListSchema.parse(await client.call(ROUTES.logins, { quiet: true })));
}

// ── permission ───────────────────────────────────────────────────────────────────────────────────

const MODE_LINE = /^permissionMode:[ \t]*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s#\n]*))[ \t]*(?:#.*)?$/mu;

/** The permission mode a `harness-codex.yaml` text says; an absent or unreadable one is `skip` (the default, owner !A525). */
export function modeOf(text: string): PermissionMode {
  const match = MODE_LINE.exec(text);
  const parsed = PermissionModeSchema.safeParse(match?.[1] ?? match?.[2] ?? match?.[3]);
  return parsed.success ? parsed.data : 'skip';
}

/** The text with ONLY the permission mode changed: the line is replaced in place, or added at the end. Every other line is kept. */
export function withMode(text: string, mode: PermissionMode): string {
  if (MODE_LINE.test(text)) return text.replace(MODE_LINE, `permissionMode: ${mode}`);
  const body = text === '' || text.endsWith('\n') ? text : `${text}\n`;
  return `${body}permissionMode: ${mode}\n`;
}

export interface ConfigFile {
  readonly text: string;
  readonly etag: string;
}

export async function readConfig(client: OnboardingClient): Promise<ConfigFile> {
  const file = (await client.call(ROUTES.readFile, { quiet: true, query: { path: CODEX_CONFIG_FILE } })) as {
    readonly text?: string;
    readonly etag?: string;
  };
  return { text: file.text ?? '', etag: file.etag ?? '' };
}

/** What a mode write did: in effect now, or written and held until the owner confirms it. */
export async function writeMode(
  client: OnboardingClient,
  file: ConfigFile,
  mode: PermissionMode,
): Promise<'applied' | 'held'> {
  const answer = (await client.call(ROUTES.writeFile, {
    body: { path: CODEX_CONFIG_FILE, text: withMode(file.text, mode), etag: file.etag },
  })) as { readonly outcome?: string };
  return answer.outcome === 'pending' ? 'held' : 'applied';
}
