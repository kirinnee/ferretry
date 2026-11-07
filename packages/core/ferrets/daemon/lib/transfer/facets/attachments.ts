/**
 * The attachments facet: identities and manifests now, original bytes at import.
 *
 * Three measured facts decide everything here:
 *
 * 1. An attachment id is the sha256 of its content, so it is STABLE across sessions and the new
 *    session reuses it rather than minting a second name for identical bytes.
 * 2. The bytes themselves live per session, so the transfer must copy the originals daemon-locally.
 *    Routing them back through the inline start body instead would put a legitimate transfer under
 *    a wire ceiling meant for a human dragging files into a composer, and refuse it.
 * 3. A decrypted document is held per session and never crosses. A new session that inherited an
 *    unlock would be handed plaintext its own user never supplied a password for — silently
 *    widening a guarantee the product makes deliberately narrow. The plan carries the LOCKED state
 *    and the new session re-prompts.
 */

import type { AttachmentFacet, AttachmentView, TransferOmission } from '@ferretry/protocol';
import type {
  TransferAttachmentReader,
  TransferFacetContribution,
  TransferFacetContributor,
  TransferPrepareInput,
} from '../types.ts';

/**
 * An optional ceiling on what one transfer copies.
 *
 * There is no inherent limit on a daemon-local copy, which is why this is injected rather than
 * assumed: a deployment that wants one states it, and what is dropped is named file by file. A
 * truncated copy that reported success would be worse than either.
 */
export interface AttachmentTransferBudget {
  readonly maxCount: number;
  readonly maxTotalBytes: number;
}

type PlannedAttachment = AttachmentFacet['attachments'][number];

function plan(view: AttachmentView): PlannedAttachment {
  return {
    id: view.id,
    filename: view.filename,
    mime: view.mime,
    size: view.size,
    sha256: view.sha256,
    createdAt: view.createdAt,
    /** Always locked: the plan describes the ORIGINAL bytes, and the original of a locked file is locked. */
    encrypted: view.encrypted === undefined ? null : { kind: 'pdf', locked: true },
  };
}

function credentialOmission(view: AttachmentView): TransferOmission {
  return {
    facet: 'attachments',
    subject: view.filename,
    reason: 'credential',
    detail:
      'this attachment is encrypted; its original bytes are carried but no decrypted copy and no unlock are, ' +
      'so the new session asks for the password again before it can read it',
  };
}

function droppedOmission(view: AttachmentView): TransferOmission {
  return {
    facet: 'attachments',
    subject: view.filename,
    reason: 'unavailable',
    detail: 'this attachment is past the transfer budget for one session and is not copied, rather than copied in part',
  };
}

export class AttachmentFacetContributor implements TransferFacetContributor<AttachmentFacet> {
  readonly facet = 'attachments' as const;

  constructor(
    private readonly reader: TransferAttachmentReader,
    private readonly budget?: AttachmentTransferBudget,
  ) {}

  private withinBudget(views: readonly AttachmentView[]): {
    readonly carried: readonly AttachmentView[];
    readonly dropped: readonly AttachmentView[];
  } {
    const budget = this.budget;
    if (budget === undefined) return { carried: views, dropped: [] };
    const carried: AttachmentView[] = [];
    const dropped: AttachmentView[] = [];
    let bytes = 0;
    for (const view of views) {
      if (carried.length >= budget.maxCount || bytes + view.size > budget.maxTotalBytes) {
        dropped.push(view);
        continue;
      }
      bytes += view.size;
      carried.push(view);
    }
    return { carried, dropped };
  }

  async contribute(input: TransferPrepareInput): Promise<TransferFacetContribution<AttachmentFacet>> {
    const views = await this.reader.list(input.source.sessionId);
    const { carried, dropped } = this.withinBudget(views);
    return {
      value: { attachments: carried.map(plan) },
      omissions: [
        ...carried.filter(view => view.encrypted !== undefined).map(credentialOmission),
        ...dropped.map(droppedOmission),
      ],
    };
  }
}
