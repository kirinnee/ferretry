import { describe, it } from 'bun:test';
import should from 'should';
import * as fork from '../../src/lib/session-fork.ts';
import { forkOutcome, forkPlan, forkPoint, forkRequest, forkSelectionBinding, forkSession } from '../fork-fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const cases: SchemaCase[] = [
  { name: 'fork request', schema: fork.ForkSessionRequestSchema, value: forkRequest },
  { name: 'forked session summary', schema: fork.ForkedSessionSummarySchema, value: forkSession },
  { name: 'fork plan summary', schema: fork.ForkSessionPlanSummarySchema, value: forkPlan },
  { name: 'fork outcome', schema: fork.ForkSessionOutcomeSchema, value: forkOutcome },
  { name: 'fork failure', schema: fork.ForkSessionFailureSchema, value: 'cut_rewritten' },
];

describe('the session fork protocol', () => {
  it('should round-trip every exported schema through strict durable values', () => {
    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(fork, cases);
  });

  it('should address the cut with the protocol-owned point, version and all', () => {
    // The fork request must not carry a SECOND coordinate shape: `through` is the same value the
    // transfer plan pins as its cut, so a string, a UI block id or a version-less object here would
    // be a coordinate the plan cannot be built from.
    // Act
    const minimal = fork.ForkSessionRequestSchema.parse({
      through: { v: 1, byteOffset: 0, blockIndex: 0 },
      selectionBinding: 'selection-binding-1',
      agent: 'claude-auto',
    });

    // Assert — every durable point identifies one exact message inside its JSONL record.
    should(minimal).deepEqual({
      through: { v: 1, byteOffset: 0, blockIndex: 0 },
      selectionBinding: 'selection-binding-1',
      agent: 'claude-auto',
    });
    should(fork.ForkSessionRequestSchema.parse(forkRequest).through).deepEqual(forkPoint);
    assertRejects([
      {
        name: 'version-less point',
        schema: fork.ForkSessionRequestSchema,
        value: { ...forkRequest, through: { byteOffset: 4_096, blockIndex: 2 } },
      },
      {
        name: 'a later point version is not this one',
        schema: fork.ForkSessionRequestSchema,
        value: { ...forkRequest, through: { v: 2, byteOffset: 4_096, blockIndex: 2 } },
      },
      {
        name: 'an offset without its block index is ambiguous',
        schema: fork.ForkSessionRequestSchema,
        value: { ...forkRequest, through: { v: 1, byteOffset: 4_096 } },
      },
      {
        name: 'string coordinate',
        schema: fork.ForkSessionRequestSchema,
        value: { ...forkRequest, through: '4096:2' },
      },
      {
        name: 'UI identity',
        schema: fork.ForkSessionRequestSchema,
        value: {
          ...forkRequest,
          through: { v: 1, byteOffset: 0, blockIndex: 0, blockId: 'record|message|uuid|0' },
        },
      },
      {
        name: 'fractional offset',
        schema: fork.ForkSessionRequestSchema,
        value: { ...forkRequest, through: { v: 1, byteOffset: 1.5, blockIndex: 0 } },
      },
    ]);
  });

  it('should require the selection evidence beside the point and keep its bytes untouched', () => {
    // A point says WHERE the cut is and nothing about whether the message there is still the
    // message the caller read. Without required evidence, a source rewritten between listing and
    // forking would hand back the same offset holding different words, and the fork of the
    // replacement is indistinguishable from the fork that was asked for on every surface.
    // Arrange
    const { selectionBinding: _binding, ...unbound } = forkRequest;

    // Act
    const parsed = fork.ForkSessionRequestSchema.parse(forkRequest);

    // Assert — byte-for-byte, padding and surrounding whitespace and all. A schema that trimmed
    // here would present the daemon with evidence nobody issued.
    should(parsed.selectionBinding).equal(forkSelectionBinding);
    should(JSON.stringify(parsed)).containEql(JSON.stringify(forkSelectionBinding).slice(1, -1));
    assertRejects([
      { name: 'a point with no evidence', schema: fork.ForkSessionRequestSchema, value: unbound },
      {
        name: 'an empty binding',
        schema: fork.ForkSessionRequestSchema,
        value: { ...forkRequest, selectionBinding: '' },
      },
      {
        name: 'an explicitly absent binding',
        schema: fork.ForkSessionRequestSchema,
        value: { ...forkRequest, selectionBinding: null },
      },
      {
        name: 'a binding taken apart into the facts it authenticates',
        schema: fork.ForkSessionRequestSchema,
        value: { ...forkRequest, selectionBinding: { mac: 'a'.repeat(64), point: forkPoint } },
      },
      {
        name: 'a raw digest offered in place of opaque evidence',
        schema: fork.ForkSessionRequestSchema,
        value: { ...forkRequest, selectionBinding: undefined, rawSha256: 'a'.repeat(64) },
      },
    ]);
  });

  it('should carry only what the caller chooses and refuse every field a fork must not take', () => {
    // Each rejected field below is a capability a fork deliberately does not have: shared-board
    // access is never inherited, the parent is always null, the conversation comes from the source
    // rather than a prompt, there is no preview arm on this route, and nothing about the SOURCE may
    // be changed by forking it.
    // Act + Assert
    assertRejects([
      { name: 'no message', schema: fork.ForkSessionRequestSchema, value: { agent: 'claude-auto' } },
      { name: 'no agent', schema: fork.ForkSessionRequestSchema, value: { through: forkPoint } },
      { name: 'blank agent', schema: fork.ForkSessionRequestSchema, value: { through: forkPoint, agent: '' } },
      { name: 'blank model', schema: fork.ForkSessionRequestSchema, value: { ...forkRequest, model: '' } },
      { name: 'blank effort', schema: fork.ForkSessionRequestSchema, value: { ...forkRequest, effort: '' } },
      {
        name: 'harness is resolved from the agent, not asserted by the caller',
        schema: fork.ForkSessionRequestSchema,
        value: { ...forkRequest, harness: 'codex' },
      },
      { name: 'board access', schema: fork.ForkSessionRequestSchema, value: { ...forkRequest, boardAccess: 'reader' } },
      {
        name: 'parent session',
        schema: fork.ForkSessionRequestSchema,
        value: { ...forkRequest, parentSessionId: 'session-1' },
      },
      { name: 'opening prompt', schema: fork.ForkSessionRequestSchema, value: { ...forkRequest, prompt: 'go' } },
      { name: 'attachments', schema: fork.ForkSessionRequestSchema, value: { ...forkRequest, attachments: [] } },
      { name: 'dry run', schema: fork.ForkSessionRequestSchema, value: { ...forkRequest, dryRun: true } },
      { name: 'source mutation', schema: fork.ForkSessionRequestSchema, value: { ...forkRequest, stopSource: true } },
      {
        name: 'the request id is a header, never a field',
        schema: fork.ForkSessionRequestSchema,
        value: { ...forkRequest, requestId: 'request-1' },
      },
    ]);
  });

  it('should report every omission through the plan alone', () => {
    // `plan.notCarried` is the single PUBLIC owner. A second list on the outcome could disagree with
    // the safe projection, and the surface that renders "what did not cross" would render the copy
    // rather than the decision.
    // Act
    const parsed = fork.ForkSessionOutcomeSchema.parse(forkOutcome);

    // Assert
    should(parsed.plan.notCarried.map(entry => entry.reason)).deepEqual(['not_implemented']);
    assertRejects([
      {
        name: 'a second omission inventory',
        schema: fork.ForkSessionOutcomeSchema,
        value: { ...forkOutcome, omissions: [] },
      },
      {
        name: 'a daemon-local report',
        schema: fork.ForkSessionOutcomeSchema,
        value: { ...forkOutcome, directory: '/state/sessions/session-2' },
      },
      { name: 'no plan', schema: fork.ForkSessionOutcomeSchema, value: { session: forkSession } },
      { name: 'no session', schema: fork.ForkSessionOutcomeSchema, value: { plan: forkPlan } },
      {
        name: 'a refusal is not an arm of the outcome',
        schema: fork.ForkSessionOutcomeSchema,
        value: { outcome: 'failed', failure: 'target_not_found' },
      },
    ]);
  });

  it('should keep every daemon-local transfer and session fact outside the public outcome', () => {
    // The durable transfer plan needs these values to replay after restart, and a normal session
    // view needs them to operate against its daemon. Neither makes them a public fork response: a
    // phone across a relay cannot act on a daemon cwd, transcript file, correlation proof or account
    // record, and the portable conversation itself belongs only in the target's opening brief.
    // Act + Assert
    assertRejects([
      {
        name: 'source transcript provenance',
        schema: fork.ForkSessionOutcomeSchema,
        value: {
          ...forkOutcome,
          plan: {
            ...forkPlan,
            source: {
              ...forkPlan.source,
              transcriptProvenance: {
                v: 1,
                home: '/daemon/home',
                identity: 'correlated',
                correlationToken: 'daemon-only-proof',
                file: '/daemon/home/transcript.jsonl',
              },
            },
          },
        },
      },
      {
        name: 'target account identity',
        schema: fork.ForkSessionOutcomeSchema,
        value: { ...forkOutcome, plan: { ...forkPlan, target: { ...forkPlan.target, accountId: 'private-account' } } },
      },
      {
        // The binding is evidence about the REQUEST. It was verified before anything was claimed, so
        // a copy in the answer would be a second point-like fact that nothing re-checks — and one a
        // surface could replay into a later fork of a conversation that has moved since.
        name: 'the selection evidence, which stops at the request',
        schema: fork.ForkSessionOutcomeSchema,
        value: {
          ...forkOutcome,
          plan: { ...forkPlan, source: { ...forkPlan.source, selectionBinding: forkSelectionBinding } },
        },
      },
      {
        name: 'durable launch config',
        schema: fork.ForkSessionOutcomeSchema,
        value: { ...forkOutcome, plan: { ...forkPlan, durable: { cwd: '/daemon/work' } } },
      },
      {
        name: 'transfer facets',
        schema: fork.ForkSessionOutcomeSchema,
        value: { ...forkOutcome, plan: { ...forkPlan, facets: { workspace: { cwd: '/daemon/work' } } } },
      },
      {
        name: 'normal daemon session view',
        schema: fork.ForkSessionOutcomeSchema,
        value: {
          ...forkOutcome,
          session: {
            ...forkSession,
            config: { id: forkSession.id, cwd: '/daemon/work' },
            directory: '/daemon/state/session-2',
          },
        },
      },
      {
        name: 'session transcript proof',
        schema: fork.ForkSessionOutcomeSchema,
        value: {
          ...forkOutcome,
          session: {
            ...forkSession,
            transcript: {
              home: '/daemon/home',
              file: '/daemon/home/transcript.jsonl',
              correlationToken: 'daemon-only-proof',
            },
          },
        },
      },
    ]);

    const encoded = JSON.stringify(fork.ForkSessionOutcomeSchema.parse(forkOutcome));
    for (const privateName of [
      'cwd',
      'directory',
      'accountId',
      'transcript',
      'transcriptProvenance',
      'correlationToken',
      'home',
      'file',
      'facets',
      'durable',
      'report',
      'selectionBinding',
    ])
      should(encoded.includes(`"${privateName}"`)).be.false();
  });

  it('should accept every declared failure code and nothing else', () => {
    // Completeness against the const that owns the set: a code added to the array without a schema
    // arm — or an arm with no code — cannot survive this.
    // Arrange
    const codes = fork.FORK_SESSION_FAILURE_CODES;

    // Act
    const accepted = codes.filter(code => fork.ForkSessionFailureSchema.safeParse(code).success);

    // Assert
    should(accepted).deepEqual([...codes]);
    // Spelled out, because these strings are a WIRE contract a later surface renders and a producer
    // raises: the prepare and import arms carry their producer's own word, so a rename in either
    // direction has to fail here rather than reach a client as an unrecognised code.
    should(codes).deepEqual([
      'invalid_session_id',
      'source_not_found',
      'selection_stale',
      'incomplete_transcript',
      'target_not_found',
      'target_not_message',
      'conversation_unavailable',
      'lineage_untraceable',
      'plan_invalid',
      'edge_invalid',
      'cut_not_carried',
      'cut_unreadable',
      'cut_rewritten',
      'unknown_agent',
      'agent_unavailable',
      'request_id_reused',
      'session_fork_failed',
    ]);
    assertRejects([
      // Crossing harness families is ALLOWED and merely lossy, so a migration's refusal is not one a
      // fork can ever answer with. This is the difference the two taxonomies exist to keep apart.
      { name: 'a migration refusal', schema: fork.ForkSessionFailureSchema, value: 'harness_mismatch' },
      { name: 'a migration downgrade', schema: fork.ForkSessionFailureSchema, value: 'context_downgrade' },
      // Every well-formed selection mismatch answers with the ONE code above. A taxonomy of near
      // spellings would let a caller distinguish "tampered" from "rewritten" from "wrong session",
      // which turns the refusal into an oracle over a transcript it was refused permission to read.
      { name: 'a tampering arm', schema: fork.ForkSessionFailureSchema, value: 'selection_invalid' },
      { name: 'a replay arm', schema: fork.ForkSessionFailureSchema, value: 'selection_replayed' },
      { name: 'a binding-shaped arm', schema: fork.ForkSessionFailureSchema, value: 'binding_mismatch' },
      { name: 'prose', schema: fork.ForkSessionFailureSchema, value: 'the transcript was incomplete' },
      { name: 'nothing', schema: fork.ForkSessionFailureSchema, value: '' },
    ]);
  });
});
