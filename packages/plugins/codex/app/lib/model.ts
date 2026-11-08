/**
 * THE WORDS SETTINGS › CODEX SAYS, decided from the daemon's `HarnessCliView` alone.
 *
 * Pure, so every sentence is asserted without a DOM. The daemon decides where Codex is, how it was installed, what
 * updating takes and what Ferretry verified; this file only chooses the words and the buttons for each of those
 * answers, and never re-derives one. Framework-neutral: the React view that draws it lives with the app shell.
 */
import {
  HARNESS_UPDATE_CODES,
  type HarnessCliLocation,
  type HarnessCliView,
  HarnessUpdateUnverifiedBodySchema,
  type HarnessVerification,
} from '../../contract/index.ts';

const CODEX_LABEL = 'Codex';

type Check = HarnessCliView['check'];
type Job = NonNullable<HarnessCliView['job']>;
type Method = NonNullable<HarnessCliView['method']>;

/** Semver order for the versions a view carries (stable releases); `undefined` when either is not one. */
function compare(a: string, b: string): -1 | 0 | 1 | undefined {
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(value);
  const left = parse(a);
  const right = parse(b);
  if (left === null || right === null) return undefined;
  for (const index of [1, 2, 3] as const) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  if (left[4] === right[4]) return 0;
  if (left[4] === undefined) return 1;
  if (right[4] === undefined) return -1;
  return left[4] > right[4] ? 1 : -1;
}

/** The version a view says is installed, when it could be read. */
const installedVersion = (view: HarnessCliView): string | undefined =>
  view.installed?.state === 'ok' ? view.installed.version : undefined;

/** The newest release the view knows, from this check or the last good one. */
export const knownLatest = (check: Check): string | undefined =>
  check.state === 'ok' ? check.latest.version : check.state === 'failed' ? check.lastKnown?.latest.version : undefined;

/** The badge beside the version: where it stands against what Ferretry verified. */
export function verificationBadge(verification: HarnessVerification): {
  readonly tone: 'ok' | 'warn' | 'pend';
  readonly text: string;
} {
  switch (verification) {
    case 'verified':
      return { tone: 'ok', text: 'Verified by Ferretry' };
    case 'older':
      return { tone: 'pend', text: 'Older than verified' };
    case 'unverified':
      return { tone: 'warn', text: 'Not yet verified by Ferretry' };
    case 'unknown':
      return { tone: 'pend', text: 'Version unknown' };
  }
}

/** Codex and the version it runs, as the card's heading says it. */
export function headline(view: HarnessCliView): string {
  if (view.location.state !== 'located') return CODEX_LABEL;
  return `${CODEX_LABEL} ${installedVersion(view) ?? '(version unreadable)'}`;
}

/** Which file runs, and why it is that one — or why there is none. */
export function locationWords(location: HarnessCliLocation): string {
  if (location.state === 'located') return `${location.rule} (${location.declaredBy})`;
  if (location.state === 'override-absent') return location.reason;
  return location.searched.length === 0
    ? 'Not found on this daemon’s PATH.'
    : `Not found on this daemon’s PATH or in ${location.searched.join(', ')}.`;
}

/** How it was installed, with the detail that lets a person recognise their own install. */
export function installWords(method: Method | null): string | undefined {
  if (method === null) return undefined;
  switch (method.kind) {
    case 'npm-global':
      return `${method.tool} global package ${method.package}${method.prefix === undefined ? '' : ` in ${method.prefix}`}${method.nodeManager === undefined ? '' : ` (node from ${method.nodeManager})`}`;
    case 'homebrew':
      return `Homebrew ${method.type} ${method.package}`;
    case 'nix-profile':
      return `nix profile element ${method.element}`;
    case 'nix-shell':
      return `nix shell store path ${method.storePath}`;
    case 'nix-module':
      return method.via === undefined ? `${method.manager} module` : `${method.manager} (via ${method.via}) module`;
    case 'standalone':
      return `standalone binary in ${method.directory}`;
    case 'unknown':
      return `unrecognised install (${method.reason})`;
  }
}

/** "3 minutes ago". */
function ageWords(at: string, now: number): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(at)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)} day${days === 1 ? '' : 's'} ago`;
}

/** The newest version, when it was asked for, and what came of it. */
export function latestWords(check: Check, now: number): string {
  if (check.state === 'never') return 'Not checked yet.';
  if (check.state === 'ok') return `${check.latest.version} on npm, checked ${ageWords(check.checkedAt, now)}.`;
  const kept =
    check.lastKnown === undefined
      ? ''
      : ` The last answer, ${ageWords(check.lastKnown.checkedAt, now)}, said ${check.lastKnown.latest.version}.`;
  return `The check ${ageWords(check.checkedAt, now)} failed: ${check.reason}.${kept}`;
}

export type JobTone = 'ok' | 'warn' | 'err' | 'pend';

/** The update running or the last one, as one sentence and a tone. */
export function jobWords(job: Job): { readonly tone: JobTone; readonly text: string } {
  if (job.state === 'running') return { tone: 'pend', text: `Updating — running ${job.command}` };
  const tone: JobTone = job.report.outcome === 'succeeded' ? 'ok' : job.report.outcome === 'failed' ? 'err' : 'warn';
  return { tone, text: job.report.message };
}

/** One button an Update offers. `target` absent is "the newest this method has". */
export interface UpdateChoice {
  readonly key: string;
  readonly target?: string;
  readonly label: string;
  /** Going past what Ferretry verified, which needs the person's explicit yes first. */
  readonly unverified: boolean;
  readonly primary: boolean;
}

const pastVerified = (view: HarnessCliView, version: string | undefined): boolean =>
  version !== undefined && compare(version, view.verified.version) === 1;

/**
 * The buttons. A method that installs a chosen version is offered the verified one (primary) and the newest; one that
 * takes what it has gets a single Update, flagged unverified when the newest — or an unknown — is past what Ferretry
 * verified.
 */
export function updateChoices(view: HarnessCliView): readonly UpdateChoice[] {
  if (view.plan?.kind !== 'self' || !view.available) return [];
  const installed = installedVersion(view);
  const latest = knownLatest(view.check);
  const newer = (version: string | undefined): version is string =>
    version !== undefined && (installed === undefined || compare(version, installed) === 1);
  if (!view.plan.pinsVersion) {
    const unverified = latest === undefined || pastVerified(view, latest);
    return [{ key: 'newest', label: 'Update', unverified, primary: !unverified }];
  }
  const choices: UpdateChoice[] = [];
  const verified = view.verified.version;
  if (newer(verified) && latest !== undefined && compare(latest, verified) === 1)
    choices.push({
      key: 'verified',
      target: verified,
      label: `Update to ${verified} (verified)`,
      unverified: false,
      primary: true,
    });
  if (newer(latest)) {
    const unverified = pastVerified(view, latest);
    choices.push({
      key: 'latest',
      target: latest,
      label: `Update to ${latest}`,
      unverified,
      primary: choices.length === 0 && !unverified,
    });
  }
  return choices;
}

/** The sentence the confirm box asks with. */
export function unverifiedQuestion(view: HarnessCliView, target: string | undefined): string {
  return target === undefined
    ? `Ferretry cannot tell which ${CODEX_LABEL} version this installs, so it may be one Ferretry has not verified yet. Ferretry verified ${view.verified.version}.`
    : `${CODEX_LABEL} ${target} has not been verified by Ferretry yet. Ferretry verified ${view.verified.version}; a newer version can change how Ferretry drives it.`;
}

/** Whether the panel should keep asking: an update is running, so the machine will change. */
export const shouldPoll = (view: HarnessCliView): boolean => view.job?.state === 'running';

/** What an Update press came back with, when it was not the new view. */
export type StartRefusal =
  | { readonly kind: 'unverified'; readonly target?: string; readonly verified: string }
  | { readonly kind: 'message'; readonly text: string };

/** Turns a refused Update into the confirm it needs, or the daemon's own sentence. */
export function startRefusal(cause: unknown): StartRefusal {
  const error = (typeof cause === 'object' && cause !== null ? cause : {}) as {
    readonly code?: unknown;
    readonly body?: unknown;
    readonly message?: unknown;
  };
  if (error.code === HARNESS_UPDATE_CODES.unverified) {
    const body = HarnessUpdateUnverifiedBodySchema.safeParse(error.body);
    if (body.success)
      return {
        kind: 'unverified',
        verified: body.data.verified,
        ...(body.data.target === undefined ? {} : { target: body.data.target }),
      };
  }
  return { kind: 'message', text: typeof error.message === 'string' ? error.message : String(cause) };
}
