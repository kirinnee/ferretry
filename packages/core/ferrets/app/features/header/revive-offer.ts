import type { FerretSummary } from '../../../contract/index.ts';

/** Whether to put a Resume button in front of this person for this ferret, and the words for why not. */
export interface ReviveOffer {
  readonly offered: boolean;
  readonly reason: string;
}

/** Whether a ferret in this state can be brought back — the ONE rule behind every Resume button. */
export const reviveRuling = (ferret: Pick<FerretSummary, 'state' | 'finishedAt'>): ReviveOffer => {
  switch (ferret.state) {
    case 'stopped':
      return {
        offered: true,
        reason:
          ferret.finishedAt === undefined
            ? 'It was stopped. Resume relaunches its CLI on the same conversation.'
            : 'It finished. Resume relaunches its CLI on the same conversation.',
      };
    case 'starting':
      return { offered: false, reason: 'It is starting.' };
    case 'working':
    case 'idle':
      return { offered: false, reason: 'It is still running.' };
  }
};

/**
 * THE ONE ANSWER every Resume button reads — the header's Actions menu and any list row's menu. It is the ruling on the
 * ferret plus the one thing only this connection knows: whether it may change anything. A surface that decides from
 * `state` itself will one day disagree with the others.
 */
export const reviveOffer = (ferret: Pick<FerretSummary, 'state' | 'finishedAt'>, canControl: boolean): ReviveOffer =>
  canControl ? reviveRuling(ferret) : { offered: false, reason: 'This connection can look but not change anything.' };
