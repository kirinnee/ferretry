import type { LoginChange, LoginChangeOutcome, LoginChangeView } from '../../contract/index.ts';
import { requireMayApply } from './authority.ts';
import { type LoginsCommandDeps, LoginsCommandError } from './ports.ts';

/** The flags every login change carries. */
export interface ChangeFlags {
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly json: boolean;
}

const RELATIVE = /^(\d+)\s*([mhdw])$/iu;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/iu;
const WRITE_IT =
  'Write --until as a date (2026-11-01, the start of that day in UTC), a time (2026-11-01T09:00:00Z) or a wait (3d, 12h, 90m).';

/**
 * `--until` as the instant the switch turns itself back on, or a refusal in plain words. A bare date is the START of
 * that day in UTC; a wait counts from `now` (ms). A time already past is refused: it would never have switched
 * anything off.
 */
export function parseUntil(text: string, now: number): string {
  const word = text.trim();
  const relative = RELATIVE.exec(word);
  let ms: number;
  if (relative !== null) {
    ms = now + Number(relative[1]) * UNIT_MS[(relative[2] as string).toLowerCase() as keyof typeof UNIT_MS];
  } else if (DATE.test(word)) {
    ms = Date.parse(`${word}T00:00:00Z`);
  } else if (INSTANT.test(word)) {
    ms = Date.parse(word);
  } else {
    throw new LoginsCommandError(`"${text}" is not a time I can read. ${WRITE_IT}`);
  }
  if (Number.isNaN(ms)) throw new LoginsCommandError(`"${text}" is not a real time. ${WRITE_IT}`);
  if (ms <= now) throw new LoginsCommandError(`"${text}" has already passed, so it would turn nothing off.`);
  return new Date(ms).toISOString();
}

/** The `--reason` text, trimmed; a blank one is refused. */
export function parseReason(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const reason = text.trim();
  if (reason === '') throw new LoginsCommandError('Say why in --reason, or leave it out.');
  return reason;
}

/** What one staged change would do, for the person deciding whether to apply it. */
export function renderChangeView(view: LoginChangeView): string {
  return [view.summary, ...view.consequences.map(sentence => `  • ${sentence}`)].join('\n');
}

/** How an applied change ended, and whether a script should trust it as done. */
export interface RenderedOutcome {
  readonly text: string;
  readonly ok: boolean;
}

export function renderChangeOutcome(outcome: LoginChangeOutcome): RenderedOutcome {
  switch (outcome.outcome) {
    case 'applied':
      return { ok: true, text: 'Done.' };
    case 'held':
      return {
        ok: true,
        text: [
          'Saved, but this loosens something, so the owner has to confirm it before it takes effect. The tighter version stays in effect until then:',
          ...outcome.sentences.map(sentence => `  • ${sentence}`),
        ].join('\n'),
      };
    case 'signed-out':
      return { ok: true, text: `Signed out ${outcome.login.id}.` };
    case 'sign-out-failed':
      return { ok: false, text: `Could not sign out ${outcome.login.id}: ${outcome.reason}` };
  }
}

/**
 * Ask a person to go ahead, or refuse in a script that did not say --yes.
 *
 * Off a terminal nobody can answer, so a destructive step without --yes is refused with a non-zero exit rather than
 * hanging or assuming yes.
 */
export async function confirmStep(deps: LoginsCommandDeps, question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (deps.prompt === undefined) {
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
 * The daemon holds the change until the explicit apply, so what a person approves here is what lands — the same
 * reviewed path the browser takes. Returns the outcome when it applied, `undefined` when it stopped (a dry run, a
 * "no"). A failed apply sets a non-zero exit, so a script can trust the status.
 */
export async function runChange(
  deps: LoginsCommandDeps,
  request: { readonly change: LoginChange; readonly destructive: boolean; readonly flags: ChangeFlags },
): Promise<LoginChangeOutcome | undefined> {
  await requireMayApply(deps);
  const view = await deps.gateway.stage(request.change);
  const { json } = request.flags;
  if (!json) deps.out.report(renderChangeView(view));
  if (request.flags.dryRun) {
    if (json) deps.out.report(JSON.stringify({ change: view }, null, 2));
    else deps.out.report('Dry run: nothing was changed.');
    return undefined;
  }
  if (request.destructive && !(await confirmStep(deps, 'Go ahead?', request.flags.yes))) return undefined;
  const outcome = await deps.gateway.apply(view.id);
  const rendered = renderChangeOutcome(outcome);
  if (json) deps.out.report(JSON.stringify({ change: view, outcome }, null, 2));
  else if (rendered.ok) deps.out.success(rendered.text);
  else deps.out.error(rendered.text);
  if (!rendered.ok) deps.out.setExitCode(1);
  return outcome;
}
