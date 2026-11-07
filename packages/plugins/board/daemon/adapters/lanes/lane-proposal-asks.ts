import {
  type AsksApi,
  type AskDraft,
  type EntryId,
  EntryIdSchema,
  type SourceKey,
  SourceKeySchema,
} from '@ferretry/core-asks/contract';
import type { LaneProposalCard } from '../../lib/lanes/lane-proposal-card.ts';
import { LANE_PROPOSAL_SOURCE } from '../../lib/lanes/lane-proposal-card.ts';
import { LANE_ASK_WITHDRAWN } from '../../lib/lanes/lane-set-service.ts';
import type { LaneProposalAsks } from '../../lib/lanes/ports.ts';

const SOURCE: SourceKey = SourceKeySchema.parse(LANE_PROPOSAL_SOURCE);
const entryOf = (reference: string): EntryId => EntryIdSchema.parse(reference);

/**
 * Raises a lane proposal as a daemon-sourced `choice` ask for the proposing ferret. The entry is the proposal's
 * reference, stable per project and version, so raising the same proposal twice is one ask (Asks is idempotent by
 * `(source, entry)`). The Agenda shows it as ONE answer row; the owner's Accept comes back through `asks.answered`.
 */
export class AsksLaneProposals implements LaneProposalAsks {
  constructor(private readonly asks: Pick<AsksApi, 'raise' | 'open' | 'close'>) {}

  async raise(ferretId: string, reference: string, card: LaneProposalCard): Promise<void> {
    const draft: AskDraft = {
      source: SOURCE,
      ref: { lanes: reference },
      entry: entryOf(reference),
      kind: 'choice',
      subject: card.subject,
      why: card.why,
      howToResolve: card.howToResolve,
      ...(card.recommendation === undefined
        ? {}
        : { context: `Recommended: ${card.recommendation.decision}. ${card.recommendation.why}` }),
      options: card.options.map(option => ({ label: option.label, description: option.description })),
      raisedBy: { kind: 'daemon' },
      ferret: ferretId,
    };
    await this.asks.raise(draft);
  }

  /**
   * Closes the ask for a proposal that is gone. An ask already closed stays closed. Asks keeps no note, so the reason
   * is the close reason: a newer proposal replaced it (`superseded`), or it was withdrawn.
   */
  async withdraw(ferretId: string, reference: string, note: string): Promise<void> {
    const open = await this.asks.open({ source: SOURCE, entry: entryOf(reference), state: 'open' });
    for (const ask of open) {
      if (ask.ferret !== undefined && ask.ferret !== ferretId) continue;
      await this.asks.close({ ferret: ask.ferret ?? ferretId, id: ask.id }, note === LANE_ASK_WITHDRAWN.replaced ? 'superseded' : 'withdrawn');
    }
  }
}
