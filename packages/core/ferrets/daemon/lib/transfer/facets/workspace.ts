/**
 * The workspace facet reports a working tree; it does not restore one.
 *
 * Three unrelated things share the word "snapshot" in this repository — a pane frame, the daemon's
 * own build artefacts, and "the repository as it stood at message N" — and only the third is what a
 * transfer would need to put the filesystem back where the conversation was. Nothing captures or
 * retains it, so `repositorySnapshot` is hard `null` here and the transfer says so out loud.
 *
 * That warning is emitted as a structured omission rather than left to a sentence in some interface,
 * because a schema field this build does not honour has to say so mechanically, in output an
 * operator sees. The field stays in the shape with a null rather than being made optional: a later
 * build can fill it without a wire change, and absence would otherwise read as "clean".
 */

import type { WorkspaceFacet } from '@ferretry/protocol';
import type {
  TransferFacetContribution,
  TransferFacetContributor,
  TransferPrepareInput,
  TransferWorkspaceProbe,
} from '../types.ts';

export class WorkspaceFacetContributor implements TransferFacetContributor<WorkspaceFacet> {
  readonly facet = 'workspace' as const;

  constructor(private readonly probe: TransferWorkspaceProbe) {}

  async contribute(input: TransferPrepareInput): Promise<TransferFacetContribution<WorkspaceFacet>> {
    const evidence = await this.probe.probe(input.source.cwd);
    return {
      value: {
        cwd: input.source.cwd,
        head: evidence.head,
        status: evidence.status,
        repositorySnapshot: null,
      },
      omissions: [
        {
          facet: 'workspace',
          subject: input.source.cwd,
          reason: 'not_implemented',
          detail:
            'conversation time was rewound but filesystem state was not: this build cannot capture or restore the ' +
            `working tree as it stood at the chosen message, so ${input.source.cwd} is whatever it is right now`,
        },
      ],
    };
  }
}
