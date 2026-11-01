import { disabledPhrase } from '@ferretry/fleet';
import type {
  FleetAccountChangeOutcome,
  FleetAccountChangeView,
  FleetApplyOutcome,
  FleetCatalogAct,
  FleetDisabled,
} from '@ferretry/protocol';
import type { AccountHarness } from './account-ports.ts';

/**
 * Words shared by every account-model rendering. Plain language only: "home", "lane", "layer" as a
 * file concept and "manifest" never reach a person.
 */

export const HARNESS_LABEL: Record<AccountHarness, string> = { claude: 'Claude Code', codex: 'Codex' };

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
export const unavailable = (act: FleetCatalogAct): string | undefined => (act.available ? undefined : act.reason);

/** "disabled (spend limit reached) until 2026-11-01" for a switch that is off, or nothing when it is on. */
export const disabledWords = (disabled: FleetDisabled | undefined): string | undefined =>
  disabled === undefined ? undefined : disabledPhrase(disabled);

/** What one staged change would do, for the person deciding whether to apply it. */
export function renderChangeView(view: FleetAccountChangeView): string {
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

export function renderChangeOutcome(outcome: FleetAccountChangeOutcome): RenderedOutcome {
  if (outcome.outcome === 'applied') return renderApply(outcome.apply);
  if (outcome.outcome === 'signed-out') return { ok: true, text: `Signed out ${outcome.credential.id}.` };
  if (outcome.outcome === 'sign-out-failed') {
    return { ok: false, text: `Could not sign out ${outcome.credential.id}: ${outcome.reason}` };
  }
  return { ok: true, text: outcome.summary };
}

/** What a committed apply left as the disk has it, one line each: an owner who removed a skill must hear it stayed. */
const leftAsItWas = (skipped: readonly { readonly path: string; readonly reason: string }[] | undefined): string[] =>
  (skipped ?? []).map(({ path, reason }) => `Left ${path} as it was: ${reason}`);

function renderApply(apply: FleetApplyOutcome): RenderedOutcome {
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
      return { ok: false, text: `Nothing changed. ${apply.failedOperation} failed: ${apply.reason}` };
    case 'rollback-incomplete':
      return {
        ok: false,
        text: [
          `${apply.failedOperation} failed (${apply.reason}) and these could not be put back:`,
          ...indent(
            apply.unrestored.map(
              path => `${path.path}: ${path.reason}${path.backup ? ` (the original is at ${path.backup})` : ''}`,
            ),
          ),
        ].join('\n'),
      };
  }
}
