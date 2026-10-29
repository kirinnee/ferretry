/**
 * ASK THE WARDEN TO INVESTIGATE NOW — the words and decisions behind Actions › Warden, as data. Pure.
 *
 * The owner's own request skips Jev and the blessing (it is already decided that this ferret is worth a
 * look), still waits for a free investigation slot, and still counts against today's investigation
 * cap. Everything here is read from the daemon's own `GET /v1/warden/status` and grants views, so the
 * form never states a price or a cap the daemon would not.
 *
 * THE FOCUS TRAVELS IN THE NOTE. `POST /v1/warden/investigate` takes one free-text `note` — what the
 * investigator should look at, in the owner's words — so the focus is the note's first sentence and the
 * owner's optional notes follow it. No second field for the daemon to learn.
 */

import type { GrantsView, WardenStatusView } from '@ferretry/protocol';
import { usd } from './warden-overview-model.ts';
import { wardenInvestigationHead, wardenLoginProblem, wardenPacedUntil } from './warden-status-model.ts';

export type AskWardenFocus = 'stuck' | 'failures' | 'recent';

export const ASK_WARDEN_FOCI: readonly { readonly value: AskWardenFocus; readonly label: string }[] = [
  { value: 'stuck', label: 'Why it seems stuck' },
  { value: 'failures', label: 'The recent failures' },
  { value: 'recent', label: 'Everything recent' },
];

const FOCUS_NOTE: Readonly<Record<AskWardenFocus, string>> = {
  stuck: 'Focus: why it seems stuck.',
  failures: 'Focus: the recent failures.',
  recent: 'Focus: everything recent.',
};

/**
 * The longest the owner's own notes may be. The route caps the whole note at 500 characters; the
 * longest focus sentence is under 30, so 400 leaves the note inside the route's limit with room to spare and
 * nothing is ever cut off after the owner typed it.
 */
export const ASK_WARDEN_NOTES_MAX = 400;

/** The request's `note`: the focus sentence, then the owner's notes when there are any. */
export const askWardenNote = (focus: AskWardenFocus, notes: string): string => {
  const extra = notes.trim();
  return extra === '' ? FOCUS_NOTE[focus] : `${FOCUS_NOTE[focus]} ${extra}`;
};

/**
 * What a run costs and what it counts against. The price is the average PRICED investigation the
 * daemon has seen — never a guess — so before any has been priced the line says the cost is unknown.
 */
export const askWardenCostLine = (status: WardenStatusView): string => {
  const { spend, savings } = status;
  const cost =
    savings.averageInvestigationUsd === undefined
      ? 'Cost unknown until one has been priced'
      : `About ${usd(savings.averageInvestigationUsd)}`;
  return `${cost}, counted against today’s ${usd(spend.investigationCapUsd)} investigation cap (${usd(spend.investigationUsd)} used).`;
};

/** Who would investigate: the head of the Warden's failover list, read-only. */
export const askWardenInvestigatorLine = (status: WardenStatusView): string => {
  const head = wardenInvestigationHead(status);
  const model = head?.model === undefined ? '' : ` with ${head.model}`;
  const login = head === undefined ? '' : ` on ${head.agent}${model}`;
  return `A read-only assigned warden${login} reads the transcript, pane, diffs and CI and writes a report with a verdict. Manual requests skip Jev and wait for a free slot.`;
};

/**
 * Why the daemon would refuse right now, when the status already says so — or null when it would
 * take the request. The daemon still decides (409, in its own words); this only saves the owner a
 * click that can only fail.
 */
export const askWardenBlocker = (status: WardenStatusView): string | null => {
  if (!status.config.enabled) return 'The Warden is off. Turn it on in Settings › Warden.';
  const login = wardenLoginProblem(status.login, status.failover?.accounts ?? []);
  if (login !== null) return `${login}. Choose one in Settings › Warden.`;
  const paced = wardenPacedUntil(status, 'investigation');
  if (paced !== undefined) return `This hour’s share of the investigation cap is spent. Try again at ${paced}.`;
  if (status.spend.capsHit.includes('investigation'))
    return `Today’s ${usd(status.spend.investigationCapUsd)} investigation cap is reached. Raise it in Settings › Warden.`;
  return null;
};

/** The toast once the daemon has taken it. */
export const askWardenQueuedSentence = (name: string, state: 'queued' | 'running'): string =>
  `Investigation of ${name} ${state === 'running' ? 'started' : 'queued'} — the report lands in Info › Signals.`;

/**
 * Whether this caller may be offered the row at all. Open when `warden.use` is open, or when only a
 * passkey confirmation stands in the way (the carrier asks for it at the request). Any other refusal —
 * switched off, not granted to this device, a document the daemon cannot read — hides the row, and so
 * does a grants view that does not mention the Warden.
 */
export const mayAskWarden = (view: GrantsView): boolean => {
  const entry = view.capabilities.find(candidate => candidate.capability === 'warden');
  if (entry === undefined) return false;
  return entry.use || entry.useRefusal === 'step-up-required';
};
