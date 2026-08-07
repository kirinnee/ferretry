/**
 * The lineage facet carries warden descent, and it may only ever get STRONGER.
 *
 * Provenance is a safety mechanism, not bookkeeping. The warden detector shields a session from
 * every anomaly class when it descends from a warden, because a warden that escalates against its
 * own offspring loops forever. A transfer produces a TOP-LEVEL session — its parent is null by
 * construction — so nothing downstream can rediscover that descent by walking ancestors: if the
 * stamp does not cross here, the shield is gone and the new session lands in the loop the stamp
 * exists to prevent.
 *
 * Monotonic therefore means, precisely: the new session is warden-descended if the source was. A
 * The production detector has two authoritative shields: the durable stamp and the exact warden
 * label. A source with neither is not evidence of a warden, but a labelled source must carry the
 * shield even when its stamp is absent or predates provenance. In that legacy case the source id is
 * the traceable warden boundary; dropping the shield would be strictly weaker than the source.
 *
 * The transfer EDGE is deliberately not this fact, and not the spawn parent either. Those are three
 * different questions, and merging any two of them under one name is how a shield silently starts
 * answering a question about ancestry it was never asked.
 */

import type { LineageFacet } from '@ferretry/protocol';
import { WARDEN_LABEL } from '../../warden/types.ts';
import {
  type TransferFacetContribution,
  type TransferFacetContributor,
  TransferPrepareError,
  type TransferPrepareInput,
} from '../types.ts';

export class LineageFacetContributor implements TransferFacetContributor<LineageFacet> {
  readonly facet = 'lineage' as const;

  async contribute(input: TransferPrepareInput): Promise<TransferFacetContribution<LineageFacet>> {
    const provenance = input.source.provenance;
    if (input.source.label === WARDEN_LABEL) {
      return {
        value: { wardenLineage: true, warden: provenance?.warden ?? input.source.sessionId },
        omissions: [],
      };
    }
    if (provenance === undefined || !provenance.wardenLineage)
      return { value: { wardenLineage: false, warden: null }, omissions: [] };

    /**
     * A shield with no traceback cannot be carried honestly: the record it would produce claims
     * descent from a warden it cannot name, and the attribution a verdict is later read against
     * would point at nothing. Refuse rather than invent one, and refuse rather than drop the
     * shield — the two wrong answers this branch exists to avoid.
     */
    if (provenance.warden === undefined)
      throw new TransferPrepareError(
        'lineage_untraceable',
        `session ${input.source.sessionId} records warden descent without naming the warden it traces back to, ` +
          'so the transfer can neither carry the shield honestly nor drop it safely',
      );

    return { value: { wardenLineage: true, warden: provenance.warden }, omissions: [] };
  }
}

/**
 * The label a transferred target must actually store.
 *
 * The source label remains inventoried on `plan.source.label`, but warden descent forces the
 * target's operational label just as an ordinary spawn does. Keeping this decision beside the
 * lineage facet gives preparation, the envelope writer and target reconciliation one owner for the
 * relationship between the durable stamp and the label-based shield.
 */
export function transferTargetLabel(lineage: LineageFacet, carriedLabel: string | null): string | null {
  return lineage.wardenLineage ? WARDEN_LABEL : carriedLabel;
}
