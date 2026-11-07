import { describe, it } from 'bun:test';
import should from 'should';
import { parseSessionId } from '../../../../daemon/seams/index.ts';
import type { ObservedHumanInput } from '../../../../daemon/seams/transcript-types.ts';
import {
  judgeWatchedSends,
  replyProofInTail,
  type SendRecord,
  type SendTranscriptTail,
  TranscriptRetractionProof,
} from '../../../../daemon/delivery/lib/index.ts';
import { at } from '../../../support/instant.ts';

/**
 * &B153: telling a pointer the harness took back from one a person recalled, from the transcript alone. The
 * records below are the shape of marge's real transcript of 2026-11-06: turn-007's user record `aeeeefa4…`, two
 * api requests, then the next record parented to the record BEFORE it — and, once a person pressed Enter on
 * the text, a new user record that was answered.
 */

const ID = parseSessionId('mw4m80sx-5624d777');
const TAKEN_BACK = 'aeeeefa4-973d-452a-aff6-c7cde97456e8';
const ANSWERED = 'e7d3ded4-47ac-4b92-ac07-c5ebc422f393';
const line = (record: object): string => JSON.stringify(record);
const TAIL = [
  `xt":"a cut first line","uuid":"11111111-1111-4111-8111-111111111111"}`,
  line({ parentUuid: '9b04d2d8-7c2d-44b7-af21-054a407c9294', type: 'user', uuid: TAKEN_BACK }),
  line({ type: 'api-request', id: '2ad6c5a9-ef66-45c2-84f3-a68c898a75fd' }),
  line({
    parentUuid: '9b04d2d8-7c2d-44b7-af21-054a407c9294',
    type: 'user',
    uuid: '8bc017aa-cd37-42a7-b575-b1ad3446c1a8',
  }),
  line({ parentUuid: '01c8649d-1e36-4e08-be2c-9da03374bf7d', type: 'user', uuid: ANSWERED }),
  line({ parentUuid: ANSWERED, type: 'assistant', uuid: 'b446a203-0000-4000-8000-000000000000' }),
].join('\n');

describe('reading a transcript tail for the answer to one user record', () => {
  it('says unanswered for a record nothing chains to, answered for one something does', () => {
    should(replyProofInTail(TAIL, TAKEN_BACK)).equal('unanswered');
    should(replyProofInTail(TAIL, ANSWERED)).equal('answered');
  });

  it('says unknown for a record outside what was read, or a key that is not a record id', () => {
    should(replyProofInTail(TAIL, '00000000-0000-4000-8000-000000000000')).equal('unknown');
    should(replyProofInTail(TAIL, 'aeeeefa4')).equal('unknown');
    should(replyProofInTail(TAIL, '.*')).equal('unknown');
    should(replyProofInTail('', TAKEN_BACK)).equal('unknown');
  });

  it('tolerates whitespace a writer might put around the separator', () => {
    should(replyProofInTail(`{"uuid" : "${TAKEN_BACK}"}`, TAKEN_BACK)).equal('unanswered');
    should(replyProofInTail(`{"uuid":"${TAKEN_BACK}"}\n{"parentUuid" : "${TAKEN_BACK}"}`, TAKEN_BACK)).equal(
      'answered',
    );
  });
});

describe('the retraction proof a send path asks', () => {
  const delivered = (overrides: Partial<SendRecord> = {}): SendRecord => ({
    sendId: 'turn-007',
    acceptedAt: at('2026-11-06T08:23:30.847Z'),
    acceptedTurn: 6,
    path: 'turn-file',
    message: 'turn seven',
    turn: 7,
    fate: 'delivered',
    evidence: {
      key: TAKEN_BACK,
      harness: 'claude',
      kind: 'chat.user',
      proof: 'normal-user-record',
      observedAt: at('2026-11-06T08:23:31.388Z'),
      shapeVersion: 1,
      matchedTurn: 7,
      tier: 'turn-instruction',
    },
    ...overrides,
  });
  class Tail implements SendTranscriptTail {
    readonly asked: number[] = [];
    constructor(private readonly text: string | undefined | Error) {}
    async tail(_id: unknown, bytes: number): Promise<string | undefined> {
      this.asked.push(bytes);
      if (this.text instanceof Error) throw this.text;
      return this.text;
    }
  }

  it('proves a Claude send settled on its own user record, read from a bounded tail', async () => {
    const tail = new Tail(TAIL);
    should(await new TranscriptRetractionProof(tail, 4096).unanswered(ID, delivered())).be.true();
    should(tail.asked).eql([4096]);
  });

  it('proves nothing for an answered record, another harness or proof, an open send, or an unreadable file', async () => {
    const proof = new TranscriptRetractionProof(new Tail(TAIL));
    const evidence = delivered().evidence!;
    should(await proof.unanswered(ID, delivered({ evidence: { ...evidence, key: ANSWERED } }))).be.false();
    should(await proof.unanswered(ID, delivered({ evidence: { ...evidence, harness: 'codex' } }))).be.false();
    should(
      await proof.unanswered(ID, delivered({ evidence: { ...evidence, proof: 'native-queue-drain' } })),
    ).be.false();
    should(await proof.unanswered(ID, delivered({ evidence: undefined }))).be.false();
    should(await proof.unanswered(ID, delivered({ fate: 'accepted' }))).be.false();
    should(await new TranscriptRetractionProof(new Tail(undefined)).unanswered(ID, delivered())).be.false();
    should(await new TranscriptRetractionProof(new Tail(new Error('EACCES'))).unanswered(ID, delivered())).be.false();
  });
});

describe('a re-opened retraction settles only on the user record its new Enter wrote (review round 2)', () => {
  const POINTER =
    'Read the file /state/sessions/mw4m80sx-5624d777/turns/turn-007.md now, then carefully follow every instruction inside it. This is your complete task for this turn.';
  const input = (key: string, observedAt: string): ObservedHumanInput => ({
    harness: 'claude',
    text: POINTER,
    proof: 'normal-user-record',
    observedAt,
    proofKey: key,
    shapeVersion: 1,
  });

  it('never binds to the rewound record its old evidence names, and binds to the new one', () => {
    const reopened: SendRecord = {
      sendId: 'turn-007',
      acceptedAt: at('2026-11-06T08:23:30.847Z'),
      acceptedTurn: 6,
      path: 'turn-file',
      message: 'turn seven',
      matchText: POINTER,
      turn: 7,
      fate: 'accepted',
      attempt: 1,
      attemptAt: at('2026-11-06T11:01:00.000Z'),
      evidence: {
        key: TAKEN_BACK,
        harness: 'claude',
        kind: 'chat.user',
        proof: 'normal-user-record',
        observedAt: at('2026-11-06T08:23:31.388Z'),
        shapeVersion: 1,
        matchedTurn: 7,
        tier: 'turn-instruction',
      },
    };
    const claimed = new Set([TAKEN_BACK]);
    const rewound = input(TAKEN_BACK, at('2026-11-06T08:23:31.388Z'));

    should(judgeWatchedSends([reopened], claimed, [rewound], 5_000).get('turn-007')?.delivered).be.undefined();
    const verdict = judgeWatchedSends(
      [reopened],
      claimed,
      [rewound, input(ANSWERED, at('2026-11-06T11:01:00.500Z'))],
      5_000,
    ).get('turn-007');
    should(verdict?.delivered?.key).equal(ANSWERED);
  });
});
