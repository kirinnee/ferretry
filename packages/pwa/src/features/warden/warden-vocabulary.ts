/**
 * The Warden's words: every anomaly code as a plain chip, and the layers by name.
 *
 * One table for the whole app — the Warden page, the fleet-checks strip and Settings all say "long
 * think", never `sus_thinking`. A raw code on screen is a bug.
 */

import type { WardenActor, WardenAnomalyKind, WardenLayers, WardenOutcome } from '@ferretry/protocol';

/** The Badge tones the Warden draws with. No new colours: these are the theme's own. */
export type WardenChipTone = 'ok' | 'warn' | 'err' | 'pend' | 'accent';

export interface WardenChip {
  readonly label: string;
  readonly tone: WardenChipTone;
  /** A spinner beside the label: something is running now. */
  readonly busy?: boolean;
}

export const chip = (label: string, tone: WardenChipTone, busy = false): WardenChip =>
  busy ? { label, tone, busy } : { label, tone };

export const ANOMALY_CHIPS: Readonly<Record<WardenAnomalyKind, WardenChip>> = {
  sus_thinking: chip('long think', 'warn'),
  sus_subprocess: chip('long command', 'pend'),
  agent_frozen: chip('frozen', 'err'),
  unattended_question: chip('question', 'warn'),
  dead_monitor: chip('pane lost', 'err'),
  quota_reset_passed: chip('quota reset', 'pend'),
  provider_unavailable: chip('provider down', 'warn'),
  abandoned_wreckage: chip('left broken', 'err'),
  declared_wait_overdue: chip('wait overdue', 'warn'),
  peer_wait_unanswerable: chip('waiting on nobody', 'warn'),
  bootstrap_degraded: chip('setup broken', 'err'),
  owner_request: chip('you asked', 'accent'),
};

/**
 * The layers by name, rules first because they are always there: `Rules only`, `Rules + Jev`,
 * `Rules + LLM`, `Rules + Jev + LLM`.
 */
export const layersLabel = (layers: WardenLayers): string =>
  !layers.jev && !layers.llm
    ? 'Rules only'
    : ['Rules', ...(layers.jev ? ['Jev'] : []), ...(layers.llm ? ['LLM'] : [])].join(' + ');

/** Who acted, in the words every part of the Warden page uses: the tiles, the chart, the row chips. */
export const ACTOR_LABEL: Readonly<Record<WardenActor, string>> = {
  auto: 'Auto',
  jev: 'Jev',
  llm: 'LLM',
  owner: 'You',
};

/**
 * The actor's colour, shared by the tile dots, the chart bars and the row chips so one actor is one
 * colour on the whole page. These are the chart's own tones (`pend`, `info`, `accent`).
 */
export const ACTOR_DOT: Readonly<Record<WardenActor, string>> = {
  auto: 'bg-pend',
  jev: 'bg-syn-type',
  llm: 'bg-accent',
  owner: 'bg-faint',
};

/** What became of a flag, as a row chip says it. */
export const OUTCOME_LABEL: Readonly<Record<WardenOutcome, string>> = {
  moved: 'Moved',
  cleared: 'Cleared',
  stopped: 'Stopped',
  asked: 'Asked',
};

const OUTCOME_TONE: Readonly<Record<WardenOutcome, WardenChipTone>> = {
  moved: 'ok',
  cleared: 'pend',
  stopped: 'err',
  asked: 'warn',
};

export const outcomeChip = (outcome: WardenOutcome): WardenChip => chip(OUTCOME_LABEL[outcome], OUTCOME_TONE[outcome]);
