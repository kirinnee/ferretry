/**
 * The references facet: an inventory for the report, and nothing rewritten.
 *
 * A reference token becomes a link only when a live resolver proves its target, in the reader's own
 * session, at the moment it is painted. So references are never "transferred" — they are RE-PROVED
 * in the new session, and the only thing that crosses is the byte the author typed. Rewriting a
 * token into prose because it will not resolve would edit somebody's words on their behalf and
 * break the rule that every surrounding byte is left untouched.
 *
 * The axis that decides what survives is "can it cross SESSIONS", not only "can it cross harnesses":
 *
 * | token           | proof scope                     | survives |
 * | --------------- | ------------------------------- | -------- |
 * | agent           | this daemon's fleet slice       | yes, re-proved |
 * | file            | the session filesystem          | yes in practice — same cwd, still re-proved |
 * | task, attention | THIS session's board / ledger   | no — the new session's are empty |
 * | terminal, browser | a surface its owner holds now | no — a live handle names nothing elsewhere |
 * | skill           | the session's skills catalogue  | re-proved against the target's catalogue; may degrade |
 *
 * The first two need no report: they are expected to resolve, and an unproved token quietly staying
 * plain text is the honest outcome, not a failure. The rest are reported, with `session_scoped` and
 * `harness_incompatible` kept apart so the report can say WHICH boundary a token failed to cross.
 */

import type { ReferenceFacet, TransferOmission } from '@ferretry/protocol';
import type {
  TransferFacetContribution,
  TransferFacetContributor,
  TransferFacetInput,
  TransferReferenceInventory,
} from '../types.ts';

type ReferenceCounts = ReferenceFacet['counts'];

const NO_REFERENCES: ReferenceCounts = {
  agent: 0,
  file: 0,
  task: 0,
  attention: 0,
  skill: 0,
  terminal: 0,
  browser: 0,
};

/** Session-scoped kinds, with the sentence each one needs. Written as prose the operator reads. */
const SESSION_SCOPED: readonly {
  readonly kind: keyof ReferenceCounts;
  readonly token: string;
  readonly why: string;
}[] = [
  { kind: 'task', token: '&task', why: "their proof is this session's task board, and a new session's is empty" },
  {
    kind: 'attention',
    token: '!attention',
    why: "their proof is this session's Attention ledger, and a new session's is empty",
  },
  {
    kind: 'terminal',
    token: '%terminal:',
    why: 'a terminal key names a shell one session is holding right now, and names nothing in another',
  },
  {
    kind: 'browser',
    token: '%browser:',
    why: 'a browser key names a page one session is holding right now, and names nothing in another',
  },
];

function sessionScopedOmissions(counts: ReferenceCounts): readonly TransferOmission[] {
  return SESSION_SCOPED.filter(entry => counts[entry.kind] > 0).map(entry => ({
    facet: 'references' as const,
    subject: entry.token,
    reason: 'session_scoped' as const,
    detail:
      `${counts[entry.kind]} ${entry.token} reference(s) are carried as text and will not resolve in the new ` +
      `session: ${entry.why}`,
  }));
}

export class ReferenceFacetContributor implements TransferFacetContributor<ReferenceFacet, TransferFacetInput> {
  readonly facet = 'references' as const;

  constructor(private readonly inventory?: TransferReferenceInventory) {}

  async contribute(input: TransferFacetInput): Promise<TransferFacetContribution<ReferenceFacet>> {
    const texts = input.conversation === null ? [] : input.conversation.messages.map(message => message.text);
    if (texts.length === 0) return { value: { counts: NO_REFERENCES }, omissions: [] };

    /**
     * The reference grammar has exactly one owner, and this package is not it. A build with no
     * inventory injected says so mechanically rather than reporting a confident zero that a second,
     * drifting copy of the grammar computed here.
     */
    if (this.inventory === undefined)
      return {
        value: { counts: NO_REFERENCES },
        omissions: [
          {
            facet: 'references',
            subject: 'inventory',
            reason: 'not_implemented',
            detail:
              'this build cannot count the reference tokens in the carried text, so the report names no ' +
              'reference totals; the tokens themselves are carried byte for byte and re-proved in the new session',
          },
        ],
      };

    const counts = await this.inventory.count(texts);
    const skill: readonly TransferOmission[] =
      counts.skill > 0 && input.source.harness !== input.request.target.harness
        ? [
            {
              facet: 'references',
              subject: '/skill',
              reason: 'unavailable',
              detail:
                `${counts.skill} skill reference(s) are carried as text, and whether they resolve is decided by ` +
                `the ${input.request.target.harness} catalogue, which cannot be read while the plan is being made`,
            },
          ]
        : [];
    return { value: { counts }, omissions: [...sessionScopedOmissions(counts), ...skill] };
  }
}
