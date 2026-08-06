/**
 * The turn a warden is handed.
 *
 * Two prompts, because there are two kinds of warden. The FLEET SWEEP warden
 * triages the whole anomaly set at once and may act on any session it is shown.
 * An ASSIGNED warden investigates exactly one suspect session and may act on
 * that one only — its authority is a per-assignment capability, so a prompt that
 * invited it to touch anything else would be inviting a refusal.
 *
 * WHY THE TEMPLATE IS RIGID. The report a warden writes is PARSED: `verdicts.ts`
 * reads the verdict line, the anomaly kind and the recommended action out of the
 * markdown, and `attention.ts` joins the result onto the human's action list. A
 * warden that free-forms its report produces a row nothing can classify, so the
 * exact lines the parser looks for are dictated here rather than hoped for.
 *
 * WHY PROVENANCE IS FORBIDDEN IN THE PROSE. The daemon records which account and
 * model actually ran the check in a sidecar and prepends it at READ time
 * (`reports.ts`). If the model wrote those facts itself, its own vocabulary would
 * feed the prose heuristics that classify the verdict — the report would be
 * judging itself.
 *
 * Pure: every input arrives through the arguments, including the CLI name the
 * warden is told to type. The daemon is not a command an agent can run, so the
 * prompt must name the client binary rather than the daemon itself.
 */

import type { WardenAnomaly } from './detect.ts';
import { provenancePath } from './provenance.ts';
import type { WardenSessionConfig, WardenSessionState } from './types.ts';

/** One session as a prompt describes it: what the detector knows, plus the
 *  durable directory a warden reads its evidence out of. */
export interface WardenPromptSession {
  readonly config: WardenSessionConfig;
  readonly state: WardenSessionState;
  /** The session's own private directory in the state home. */
  readonly directory: string;
  /** Where the agent is working, for the read-only workspace look. */
  readonly cwd?: string;
  readonly turn?: number;
}

export interface WardenPromptSettings {
  /** The CLI a human — and therefore a warden — actually types. */
  readonly clientName: string;
  /**
   * Whether the warden's own credential lets it ACT on the fleet, or only report.
   *
   * NOT decoration. kteam handed each assigned warden an unguessable
   * `stopCapability` through its start, and the fleet wrappers held an admin token,
   * so a warden could resume, nudge and stop. This daemon's start declares no such
   * field and the only per-session credential it mints authorizes the task-board
   * domain, so a warden here has no authority over any session.
   *
   * A prompt that told it otherwise would be a lie that produces failed commands
   * and a confused report. When this is false the prompt says plainly that the
   * REPORT is the deliverable — which is true either way, because the recommended
   * action is what every downstream surface reads.
   */
  readonly mayAct: boolean;
}

/** A same-harness account a quota-blocked session could be migrated onto,
 *  precomputed so a warden never has to guess which account is free. */
export interface WardenMigrateCandidates {
  readonly sessionId: string;
  readonly currentAgent: string;
  readonly candidates: readonly string[];
}

/**
 * A teammate callsign as the reference grammar writes it.
 *
 * ONE OWNER for the `:name` token: the prompt names a session's teammate with
 * it and the warden escalation puts the same token in an Attention item, where a
 * reader's client turns a proved callsign into a link. Two spellings would mean
 * one of them never resolves.
 */
export function wardenTeammateToken(teammate: string): string {
  return `:${teammate}`;
}

const teammateOf = (config: WardenPromptSession['config']): string =>
  config.teammate === undefined ? 'unknown' : wardenTeammateToken(config.teammate);

/** The report-writing rules both prompts share. */
function reportWritingRules(reportPath: string): readonly string[] {
  return [
    '',
    '## Report writing',
    '- Lead with the verdict, then the recommended action and its one-line reason.',
    '- Use point form only: one idea per bullet, short plain lines.',
    '- Keep evidence to at most three bullets. Do not narrate the investigation or dump logs, commands, ids, or repeated readings.',
    '- Write exactly one **Recommended action** line: NUDGE, STOP, RESUME, RESTART, MIGRATE (agent), or LEAVE. MIGRATE MUST name an account from the supplied candidate list.',
    '- LEAVE means "no action needed"; say why in one line. If two actions are genuinely safe, name both in the reason and put the safer one first.',
    '- Bold at most one key value per bullet.',
    '- Do not write CLI, model, harness, or failover facts: the daemon injects those from session metadata when rendering.',
    `- The daemon-owned provenance sidecar is: ${provenancePath(reportPath)}`,
    '',
  ];
}

/**
 * What this warden is and is not allowed to do, stated before any action list.
 *
 * A warden with no authority is told so in one place, at the top, rather than
 * being handed a list of commands it will discover it cannot run. Its report is
 * the deliverable either way: the recommended action is what every downstream
 * surface reads, so a report-only warden is a fully useful warden.
 */
function authorityNotice(settings: WardenPromptSettings): readonly string[] {
  if (settings.mayAct) return [];
  return [
    '## Your authority',
    'You hold NO credential over any session: you cannot send, resume, migrate, answer or stop.',
    'Your REPORT is the action. State the verdict and one recommended action; the daemon and the operator carry it out.',
    'Do not attempt a command against a session — a failed attempt tells nobody anything and wastes the check.',
    '',
  ];
}

/** What each sus kind asks the warden to weigh. Anything else reaching the
 *  assigned path is an unanswered question, which is the third case. */
function kindGuidance(
  anomaly: WardenAnomaly,
  session: WardenPromptSession,
  settings: WardenPromptSettings,
): readonly string[] {
  if (anomaly.kind === 'sus_thinking') {
    return [
      'The session APPEARS to be thinking (work counters advancing) but its transcript has not grown for a long time.',
      'Judge whether that is legitimate: is the task complex enough to warrant a very long think? Are tokens actually',
      'flowing (counter values increasing between two snapshots)? Could it be a usage limit, a network wedge, or a',
      'crashed inference stream repainting a frozen spinner?',
    ];
  }
  if (anomaly.kind === 'sus_subprocess') {
    return [
      'The session has had a background subprocess running continuously for a long time.',
      'Judge whether that is expected for the task (build, test suite, long migration…) and whether the process is',
      'actually PROGRESSING: is its output growing (turn logs, files in the cwd), is it consuming CPU, are artifacts',
      'appearing? A legitimate long task should show movement between two looks a minute apart.',
    ];
  }
  return [
    'The session has been waiting on an unanswered question for a long time.',
    'Read its pending question and its own transcript and turns.',
    ...(settings.mayAct
      ? [
          `Answer with \`${settings.clientName} answer\` ONLY when the answer is unambiguous from ${session.config.id}'s own`,
          'context; otherwise state precisely what a human must decide.',
        ]
      : ['State precisely what a human must decide, and the answer you would give if it is unambiguous.']),
  ];
}

/**
 * The turn an ASSIGNED warden is given: one anomaly, one session, one verdict.
 *
 * The anomaly is embedded as JSON rather than prose so the warden judges the
 * evidence the detector actually produced, including the liveness ledger — a
 * paraphrase would lose exactly the timestamps the judgement turns on.
 */
export function buildAssignedWardenPrompt(
  anomaly: WardenAnomaly,
  session: WardenPromptSession,
  reportPath: string,
  settings: WardenPromptSettings,
): string {
  const cli = settings.clientName;
  const id = session.config.id;
  const teammate = teammateOf(session.config);
  return [
    `You are an ASSIGNED warden for exactly one session: ${id} (teammate ${teammate}).`,
    'It was flagged sus (alive but weird) by the fleet sweep. Investigate THIS session only and deliver one verdict.',
    '',
    '## The anomaly',
    '```json',
    JSON.stringify(anomaly, null, 2),
    '```',
    '',
    '## What to understand first',
    `- The task and conversation so far: read ${session.directory}, its turns/ and its transcript.`,
    `- Live terminal: \`${cli} snapshot ${id}\` — take it twice, a minute apart, and compare.`,
    `- Recent events: \`${cli} events ${id} --after -50\`.`,
    ...(session.cwd === undefined
      ? []
      : [`- The workspace, READ ONLY: \`git -C ${session.cwd} diff --stat\` and file timestamps.`]),
    ...kindGuidance(anomaly, session, settings).map(line => `- ${line}`),
    '',
    ...authorityNotice(settings),
    '## Verdict (exactly one; state it and the evidence in the report)',
    '- LEAVE — the long operation is expected and progressing; no action.',
    ...(settings.mayAct
      ? [
          `- NUDGE — \`${cli} send ${id} <message>\` if it looks wedged but recoverable.`,
          `- RESUME — \`${cli} resume ${id}\` if the turn is dead but the session should continue.`,
          `- KILL — \`${cli} stop ${id}\` ONLY with clear evidence it is burning time with no progress.`,
          '  (Your credential can stop only this one assigned session.)',
        ]
      : [
          '- NUDGE — it looks wedged but recoverable; recommend a nudge and say what to send.',
          '- RESUME — the turn is dead but the session should continue.',
          '- KILL — clear evidence it is burning time with no progress. Recommend STOP; do not attempt it.',
        ]),
    '- NEEDS_HUMAN — the rare exception: use it only when you are genuinely uncertain whether KILL would destroy needed work or cause irreversible harm. State that exact uncertainty; never use it merely because acting feels risky.',
    '',
    '## Rules',
    '- Do NOT touch any other session. No git writes, no repository edits, no new non-warden sessions.',
    `- Write your report to EXACTLY: ${reportPath}`,
    ...reportWritingRules(reportPath),
    '- The report MUST follow this machine-stable template (the daemon parses the verdict and the recommendation):',
    '```',
    'Verdict: LEAVE|NUDGE|RESUME|KILL|NEEDS_HUMAN',
    '',
    `# Warden report — ${id} (teammate ${teammate}, ${session.config.label ?? '-'})`,
    '',
    `- **Anomaly kind:** ${anomaly.kind}`,
    '',
    '## Summary',
    '- **Recommended action:** NUDGE|STOP|RESUME|RESTART|MIGRATE (agent)|LEAVE — <one-line why>',
    '- **Outcome:** <short reason for the verdict>',
    '',
    '## Evidence',
    '- <up to three short bullets that support the verdict>',
    '```',
    `- Then run: \`${cli} signal done\`.`,
  ].join('\n');
}

/** The per-session facts the sweep prompt shows for each anomalous session. */
function sweepSessionFacts(session: WardenPromptSession): Record<string, unknown> {
  return {
    id: session.config.id,
    teammate: session.config.teammate,
    label: session.config.label,
    agent: session.config.agent,
    mode: session.config.mode,
    status: session.state.status,
    reason: session.state.reason,
    turn: session.turn,
    cwd: session.cwd,
    directory: session.directory,
    lastActivityAt: session.state.lastActivityAt,
    finishedAt: session.state.finishedAt,
    quota: session.state.quota,
  };
}

/**
 * The turn the FLEET SWEEP warden is given: the whole anomaly set, and only the
 * safe recovery actions.
 *
 * Sessions are filtered to the anomalous ones — including every session a
 * fleet-wide anomaly names through `affectedSessionIds`, because a provider
 * outage's evidence is spread across the sessions that corroborated it and a
 * warden shown only the first would judge on a fraction of it.
 */
export function buildWardenSweepPrompt(input: {
  readonly anomalies: readonly WardenAnomaly[];
  readonly sessions: readonly WardenPromptSession[];
  readonly reportPath: string;
  readonly at: string;
  readonly migrateCandidates?: readonly WardenMigrateCandidates[];
  readonly settings: WardenPromptSettings;
}): string {
  const cli = input.settings.clientName;
  const anomalous = new Set(input.anomalies.flatMap(item => item.affectedSessionIds ?? [item.sessionId]));
  const facts = input.sessions.filter(session => anomalous.has(session.config.id)).map(sweepSessionFacts);
  const candidates = input.migrateCandidates ?? [];
  return [
    'You are the FLEET WARDEN — third-layer oversight for a team of autonomous coding agents.',
    `A deterministic sweep at ${input.at} found the anomalies below. Triage them and judge each one.`,
    '',
    ...authorityNotice(input.settings),
    ...(input.settings.mayAct
      ? [
          '## ALLOWED actions',
          `- \`${cli} resume <id> [message]\` a session whose interruption is clearly transient (network, connection, timeout, overloaded, a dropped harness process). Read its conversation first.`,
          `- \`${cli} send <id> <nudge>\` a session that looks wedged but recoverable.`,
          `- \`${cli} migrate <id> -a <agent>\` a QUOTA or rate-limited session onto a usable same-harness account. Pick only from that session's "Migrate candidates" list below, never a guess — the session keeps its conversation and continues on the new account.`,
          "- Answer a question ONLY when its answer is unambiguous from that session's OWN conversation. If you would have to guess, do not answer.",
          '',
          '## FORBIDDEN — never do these',
          '- Do NOT delete any session.',
          `- Stop a session only where your credential authorizes \`${cli} stop\`, and only with clear evidence that it is burning time with no progress.`,
        ]
      : ['## FORBIDDEN — never do these', '- Do NOT act on any session; recommend, and let the operator act.']),
    '- Do NOT run any git operation, and do NOT edit any repository file.',
    '- Do NOT start any non-warden session.',
    '',
    '## Required output',
    `- Write a report to EXACTLY this path: ${input.reportPath}`,
    '- State the outcome and one recommended action per session; keep the report short.',
    '- Write one `## Anomaly: <session-id> — :<teammate> / <label>` section per anomaly record; repeat a session in separate sections when it has several anomaly kinds.',
    '- Put `- **Anomaly kind:** <kind>` inside EVERY anomaly section.',
    '- Put `Verdict: LEAVE|NUDGE|RESUME|KILL|NEEDS_HUMAN` inside EVERY anomaly section.',
    '- Put `- **Recommended action:** NUDGE|STOP|RESUME|RESTART|MIGRATE (agent)|LEAVE — <one-line why>` directly under each verdict.',
    '- Put `- **Outcome:** <short reason>` directly under the recommendation.',
    '- Never use one fleet-wide verdict as the verdict for several sessions.',
    '- Use NEEDS_HUMAN only for a genuine, explicit uncertainty about whether stopping would destroy needed work or cause irreversible harm. Otherwise act (or LEAVE) and log the outcome.',
    ...reportWritingRules(input.reportPath),
    `- When the sweep is done, run: \`${cli} signal done\`.`,
    '',
    '## Anomalies (deterministic detector output)',
    '```json',
    JSON.stringify(input.anomalies, null, 2),
    '```',
    '',
    '## Per-session status for the anomalous sessions',
    '```json',
    JSON.stringify(facts, null, 2),
    '```',
    ...(candidates.length === 0
      ? []
      : [
          '',
          '## Migrate candidates (usable same-harness accounts for quota or rate-limited sessions)',
          'If a candidate list is empty, do NOT migrate that session — leave it to wait for its quota reset.',
          '```json',
          JSON.stringify(candidates, null, 2),
          '```',
        ]),
    '',
    "Each session's durable directory is listed above — read it before acting.",
  ].join('\n');
}
