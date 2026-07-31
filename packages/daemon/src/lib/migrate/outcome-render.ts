import { truncate } from './render-text.ts';

/**
 * What a post-attempt session read actually observed. Every field is optional because the daemon
 * may report a partial view; the WHOLE object is absent when the post-attempt read itself failed —
 * which must render as unknown, never as an assumed rollback.
 */
export interface ObservedSession {
  readonly binary?: string;
  readonly model?: string;
  readonly status?: string;
}

/**
 * The settled result of one migration attempt. `observed` is deliberately separate from
 * `targetAgent`: the target is what was ASKED FOR, `observed` is what the daemon REPORTS.
 */
export interface MigrationOutcome {
  readonly ok: boolean;
  /** The wrapper the session was on before the attempt. */
  readonly from: string;
  readonly targetAgent: string;
  readonly targetModel?: string;
  /** ISO timestamp of the settlement. */
  readonly at: string;
  /** Failure only: the error the daemon or the client produced, verbatim. */
  readonly detail?: string;
  /** Omit entirely when the post-attempt read failed. */
  readonly observed?: ObservedSession;
}

function modelSuffix(model: string | undefined): string {
  return model ? ` (model \`${model}\`)` : '';
}

function wrapperLine(observed: ObservedSession, from: string, targetAgent: string): string {
  const binary = observed.binary;
  const model = modelSuffix(observed.model);
  if (!binary) return '- Session now on: **UNKNOWN** — the daemon reported no wrapper for this session.';
  if (binary === targetAgent)
    return (
      `- Session now on: \`${binary}\`${model} — the REQUESTED target, **not** the original \`${from}\`. ` +
      'The config was left staged on the target: the rollback did not complete.'
    );
  if (binary === from)
    return `- Session now on: \`${binary}\`${model} — the ORIGINAL account; the session did not move.`;
  return `- Session now on: \`${binary}\`${model} — neither the original \`${from}\` nor the requested \`${targetAgent}\`.`;
}

function successLines(outcome: MigrationOutcome, model: string): readonly string[] {
  const lines: string[] = [
    '## Outcome — MIGRATION SUCCEEDED',
    '',
    `- Settled at: ${outcome.at}`,
    `- Migrated from \`${outcome.from}\` onto \`${outcome.targetAgent}\`${model}.`,
  ];
  if (outcome.observed?.binary)
    lines.push(
      `- Session now on: \`${outcome.observed.binary}\`${modelSuffix(outcome.observed.model)}` +
        (outcome.observed.binary === outcome.targetAgent
          ? ''
          : ` — note: this is not the requested \`${outcome.targetAgent}\`.`),
    );
  if (outcome.observed?.status) lines.push(`- Status now: \`${outcome.observed.status}\``);
  lines.push('- The relaunch under the new account completed; everything above describes what it interrupted.', '');
  return lines;
}

function failureLines(outcome: MigrationOutcome, model: string): readonly string[] {
  const lines: string[] = [
    '## Outcome — MIGRATION FAILED',
    '',
    `- Settled at: ${outcome.at}`,
    `- Requested target: \`${outcome.targetAgent}\`${model} (from \`${outcome.from}\`)`,
    '- **The migration did NOT complete.** Everything above describes what was in flight when it was tried.',
    `- Error: ${truncate(outcome.detail?.trim() || 'no detail reported', 600)}`,
  ];
  if (outcome.observed) {
    lines.push(wrapperLine(outcome.observed, outcome.from, outcome.targetAgent));
    lines.push(`- Status now: ${outcome.observed.status ? `\`${outcome.observed.status}\`` : '**UNKNOWN**'}`);
  } else {
    lines.push(
      '- Session state after the failure: **UNKNOWN** — the post-failure read did not return, so whether the ' +
        `session was restored to \`${outcome.from}\` is NOT confirmed. Read the session state before acting on it.`,
    );
  }
  lines.push('');
  return lines;
}

/**
 * The `## Outcome` section appended to the session's `migration-inflight.md` once the attempt
 * settles. This is the ONLY part of the report allowed to state that the move happened. On failure
 * it reports the error plus whatever the daemon actually observes afterwards — and says UNKNOWN
 * rather than claiming a rollback it did not verify, because a daemon-side refusal, a half-applied
 * config, and a clean restore are all reachable.
 */
export function renderMigrationOutcome(outcome: MigrationOutcome): string {
  const model = modelSuffix(outcome.targetModel);
  const lines = outcome.ok ? successLines(outcome, model) : failureLines(outcome, model);
  return `${lines.join('\n')}\n`;
}

/** The one-line handoff message sent to the migrated agent once the move succeeds. */
export function handoffMessage(reportPath: string): string {
  return `You were migrated mid-turn. Read ${reportPath} — it lists what was running and what to check before re-running anything.`;
}
