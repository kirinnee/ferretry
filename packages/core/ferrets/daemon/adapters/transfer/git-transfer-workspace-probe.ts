/**
 * Evidence about the source session's working directory — and no ability to change one.
 *
 * Implements `TransferWorkspaceProbe`. It holds a `GitWorktreeGateway` and calls exactly two of its
 * read methods, `inspect` and `status`. It never calls `add`, `remove` or anything else that would
 * create or mutate a checkout: a transfer describes a working tree, it does not restore or clone one,
 * and the source must be byte-for-byte untouched by having been forked from (I1).
 *
 * THE FACET, NOT THIS PROBE, OWNS THE MISSING PIECE. `repositorySnapshot: null` and the structured
 * `not_implemented` warning that conversation time was rewound while filesystem state was not are
 * emitted by `WorkspaceFacetContributor` for every transfer, including this one. Nothing here
 * attempts to stand in for that snapshot — a HEAD sha and a dirty-file summary describe the tree as
 * it is NOW, which is exactly the fact the warning exists to distinguish from the tree as it stood at
 * the chosen message.
 *
 * MISSING EVIDENCE IS NULL, NOT A FAILURE. A cwd that is not a repository, has been deleted, or sits
 * behind a Git that cannot answer produces `{ head: null, status: null }`. The schema keeps both
 * nullable for precisely this, and the alternative — failing a transfer that is otherwise completely
 * describable because a report field could not be filled in — would refuse work over a detail nobody
 * asked to depend on. `head` without `status` is likewise a legitimate partial answer rather than
 * something to suppress: it says the checkout was identified and its dirtiness was not.
 */

import type { GitWorktreeGateway } from '../worktrees/git-gateway.ts';
import type { TransferWorkspaceEvidence, TransferWorkspaceProbe } from '../../lib/transfer/types.ts';

export class GitTransferWorkspaceProbe implements TransferWorkspaceProbe {
  constructor(private readonly gateway: GitWorktreeGateway) {}

  async probe(cwd: string): Promise<TransferWorkspaceEvidence> {
    const checkout = await this.gateway.inspect(cwd).catch(() => undefined);
    if (checkout === undefined || !checkout.repo) return { head: null, status: null };
    const status = await this.gateway.status(cwd).catch(() => undefined);
    return { head: checkout.head ?? null, status: status ?? null };
  }
}
