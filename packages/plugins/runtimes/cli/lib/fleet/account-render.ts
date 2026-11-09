import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import type {
  AccountChangeOutcome,
  AccountChangeView,
  ApplyOutcome,
  CatalogAct,
  Disabled,
  HarnessScope,
} from '../../../contract/index.ts';

/**
 * Words shared by every account-model rendering. Plain language only: "home", "lane", "layer" as a
 * file concept and "manifest" never reach a person.
 */

export const HARNESS_LABEL: Record<HarnessKey, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

/** Two spaces per level, so nested facts read as belonging to the line above. */
export const indent = (lines: readonly string[], depth = 1): string[] =>
  lines.map(line => `${'  '.repeat(depth)}${line}`);

/** "1 runtime", "2 runtimes". */
export const count = (n: number, singular: string, plural = `${singular}s`): string =>
  `${n} ${n === 1 ? singular : plural}`;

/** A list in a sentence, or the word for nothing. */
export const listOrNone = (items: readonly string[], none = 'none'): string =>
  items.length === 0 ? none : items.join(', ');

/** An act's reason when it is not offered, or nothing. */
export const unavailable = (act: CatalogAct): string | undefined => (act.available ? undefined : act.reason);

/** "disabled (spend limit reached) until 2026-11-01" for a switch that is off, or nothing when it is on. */
export const disabledWords = (disabled: Disabled | undefined): string | undefined =>
  disabled === undefined ? undefined : disabledPhrase(disabled);

/** The product's words for each scope: what a badge says. */
export const HARNESS_SCOPE_WORDS: Readonly<Record<HarnessScope, string>> = {
  generic: 'Generic',
  'claude-code': 'Claude only',
  codex: 'Codex only',
};

/** What one staged change would do, for the person deciding whether to apply it. */
export function renderChangeView(view: AccountChangeView): string {
  const lines = [view.summary, ...indent(view.consequences.map(sentence => `• ${sentence}`))];
  const preview = view.preview;
  if (preview.kind === 'apply') {
    if (preview.documents.length > 0) {
      lines.push('Saves:', ...indent(preview.documents.map(document => document.path)));
    }
    const prepared = preview.operations.length;
    if (prepared > 0)
      lines.push(`Prepares ${count(prepared, 'file or folder', 'files and folders')} for the runtimes.`);
    if (preview.runtimes.length > 0) {
      lines.push(
        'Runtimes after this change:',
        ...indent(
          preview.runtimes.map(runtime => {
            const kind = runtime.agent ? `${HARNESS_LABEL[runtime.harness]}, agent` : HARNESS_LABEL[runtime.harness];
            return `${runtime.name} (${kind}) — ${unavailable(runtime.launch) ?? 'ready to launch'}`;
          }),
        ),
      );
    }
    const running = preview.runningSessions ?? [];
    if (running.length > 0) {
      lines.push(
        'Running on it now:',
        ...indent(running.map(session => `${session.name} (${HARNESS_LABEL[session.harness]}) · ${session.id}`)),
      );
    }
  } else if (preview.kind === 'sign-out') {
    lines.push(
      `Signs out ${preview.credential}: ${count(preview.runtimesAffected, 'runtime')} will need sign-in afterwards.`,
    );
    if (preview.signsOutTerminal) lines.push('This also signs out the same tool in your own terminal on this machine.');
  } else {
    lines.push(preview.description);
  }
  return lines.join('\n');
}

/** How an applied change ended, and whether a script should trust it as done. */
export interface RenderedOutcome {
  readonly text: string;
  readonly ok: boolean;
}

export function renderChangeOutcome(outcome: AccountChangeOutcome): RenderedOutcome {
  if (outcome.outcome === 'applied') return renderApply(outcome.apply);
  if (outcome.outcome === 'signed-out') return { ok: true, text: `Signed out ${outcome.credential.id}.` };
  if (outcome.outcome === 'sign-out-failed') {
    return { ok: false, text: `Could not sign out ${outcome.credential.id}: ${outcome.reason}` };
  }
  if (outcome.outcome === 'login-changed') return renderLoginChanged(outcome);
  return { ok: true, text: outcome.summary };
}

/**
 * A change to one login: what it was (its summary) and, for a removal that moved runtimes first, what that move did,
 * including the paths it left as they were. Nothing is reduced to a bare "Done.".
 */
function renderLoginChanged(outcome: Extract<AccountChangeOutcome, { outcome: 'login-changed' }>): RenderedOutcome {
  const moved = outcome.moved === undefined ? undefined : renderApply(outcome.moved);
  const movedLines =
    moved === undefined
      ? []
      : ['Moved the runtimes first.', ...moved.text.split('\n').filter(line => line !== 'Done.')];
  const ok = moved?.ok ?? true;
  if (outcome.result === 'applied') {
    return {
      ok,
      text: [outcome.summary === undefined ? 'Done.' : `${outcome.summary}: done.`, ...movedLines].join('\n'),
    };
  }
  return {
    ok,
    text: [
      ...(outcome.summary === undefined ? [] : [outcome.summary]),
      'Saved, but this loosens something, so the owner has to confirm it before it takes effect. The tighter version stays in effect until then:',
      ...(outcome.sentences ?? []).map(sentence => `  • ${sentence}`),
      ...movedLines,
    ].join('\n'),
  };
}

/** What a committed apply left as the disk has it, one line each: an owner who removed a skill must hear it stayed. */
const leftAsItWas = (skipped: readonly { readonly path: string; readonly reason: string }[] | undefined): string[] =>
  (skipped ?? []).map(({ path, reason }) => `Left ${path} as it was: ${reason}`);

/**
 * The configuration files a failed change wrote first. A rollback puts the fleet back but not these, and the next
 * apply publishes them, so the sentence names them; with none landed there is nothing to say.
 */
const landed = (files: readonly string[] | undefined): string | undefined => {
  if (files === undefined || files.length === 0) return undefined;
  const named =
    files.length === 1
      ? `The change to the configuration ${files[0]} was made first and is`
      : `The changes to the configuration files ${files.join(', ')} were made first and are`;
  const them = files.length === 1 ? 'it' : 'them';
  const back =
    files.length === 1
      ? 'put that file back as it was, or delete it if it did not exist before'
      : 'put those files back as they were, or delete any that did not exist before';
  return `${named} NOT rolled back; the next apply publishes ${them}. Fix the cause and apply again; to undo the change instead, ${back}.`;
};
const landedLines = (files: readonly string[] | undefined): string[] => {
  const line = landed(files);
  return line === undefined ? [] : [line];
};

function renderApply(apply: ApplyOutcome): RenderedOutcome {
  switch (apply.outcome) {
    case 'committed': {
      const lines = ['Done.'];
      if (apply.result.backupResidue?.length) {
        lines.push(
          `Kept ${count(apply.result.backupResidue.length, 'earlier file')} aside: ${apply.result.backupResidue.join(', ')}`,
        );
      }
      if (apply.result.lockResidue) lines.push(`Remove ${apply.result.lockResidue} before the next change.`);
      lines.push(...leftAsItWas(apply.result.skipped));
      return { ok: true, text: lines.join('\n') };
    }
    case 'committed-with-history-failure':
      return {
        ok: false,
        text: [
          `Saved, but the shared ${apply.failedHarness} history could not be set up: ${apply.reason}`,
          ...leftAsItWas(apply.committed.skipped),
        ].join('\n'),
      };
    case 'rolled-back':
      return {
        ok: false,
        text: [
          landed(apply.configurationLanded) === undefined
            ? `Nothing changed. ${apply.failedOperation} failed: ${apply.reason}`
            : `${apply.failedOperation} failed: ${apply.reason}. The fleet was put back.`,
          ...landedLines(apply.configurationLanded),
        ].join('\n'),
      };
    case 'rollback-incomplete': {
      const displaced = (apply.displaced ?? []).map(state => `${state.path} (moved to ${state.movedTo})`);
      const header =
        apply.unrestored.length > 0
          ? `${apply.failedOperation} failed (${apply.reason}) and these could not be put back:`
          : displaced.length > 0
            ? `${apply.failedOperation} failed (${apply.reason}), and the fleet could not be fully put back:`
            : `${apply.failedOperation} failed (${apply.reason}).`;
      return {
        ok: false,
        text: [
          header,
          ...indent(
            apply.unrestored.map(
              path => `${path.path}: ${path.reason}${path.backup ? ` (the original is at ${path.backup})` : ''}`,
            ),
          ),
          ...(apply.unrestored.length > 0 && displaced.length > 0 ? ['Moved aside:'] : []),
          ...indent(displaced),
          ...landedLines(apply.configurationLanded),
        ].join('\n'),
      };
    }
  }
}

/** `until` as a short calendar date for a sentence (UTC, `2026-11-01`). */
const untilWords = (until: string): string => {
  const ms = Date.parse(until);
  if (Number.isNaN(ms)) return until;
  const iso = new Date(ms).toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : `${iso.slice(0, 16).replace('T', ' ')} UTC`;
};

/** "disabled (spend limit reached) until 2026-11-01" — the clause every refusal and row builds on. */
function disabledPhrase(disabled: Disabled): string {
  const why = disabled.reason === undefined ? '' : ` (${disabled.reason})`;
  const until = disabled.until === undefined ? '' : ` until ${untilWords(disabled.until)}`;
  return `disabled${why}${until}`;
}
