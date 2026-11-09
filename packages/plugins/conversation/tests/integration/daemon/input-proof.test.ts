import { describe, it } from 'bun:test';
import type { TranscriptEntry } from '@ferretry/core-ferrets/contract';
import type { Instant } from '@ferretry/std';
import should from 'should';
import { inputObserverFor, isInputProofEntry, observedInputsOf } from '../../../daemon/reader/adapters/input-proof.ts';

const at = (value: string): Instant => value as Instant;
const entry = (over: Partial<TranscriptEntry> & Pick<TranscriptEntry, 'id' | 'role'>): TranscriptEntry => ({
  at: at('2026-11-09T10:00:00.000Z'),
  ...over,
});

describe('#45 BG-052 what a harness plugin’s entry proves of an input, through today’s observers', () => {
  it('should know the harness’s queue records apart from a message', () => {
    should(isInputProofEntry(entry({ id: 'q', role: 'system', data: { proof: 'queue-operation' } }))).be.true();
    should(isInputProofEntry(entry({ id: 'p', role: 'system', data: { proof: 'queued-prompt' } }))).be.true();
    should(isInputProofEntry(entry({ id: 'u', role: 'user', text: 'hi' }))).be.false();
    should(isInputProofEntry(entry({ id: 'd', role: 'user', data: { proof: 'something-else' } }))).be.false();
    should(isInputProofEntry(entry({ id: 'a', role: 'user', data: ['queue-operation'] }))).be.false();
  });

  it('should read a Claude user entry as a normal user record, keyed by the entry', () => {
    const observer = inputObserverFor('claude');
    const proven = observedInputsOf(observer, entry({ id: 'u1', role: 'user', text: 'FIXTURE hello' }), 0);
    should(proven).eql([
      {
        harness: 'claude',
        text: 'FIXTURE hello',
        proof: 'normal-user-record',
        observedAt: '2026-11-09T10:00:00.000Z',
        proofKey: 'u1',
        shapeVersion: 1,
      },
    ]);
  });

  it('should read what Claude held and let go of as queue bookkeeping, never as the input itself', () => {
    const observer = inputObserverFor('claude');
    const held = observedInputsOf(
      observer,
      entry({
        id: 'queue-operation:3',
        role: 'system',
        text: 'FIXTURE held',
        data: { proof: 'queue-operation', operation: 'enqueue' },
      }),
      3,
    );
    const released = observedInputsOf(
      observer,
      entry({
        id: 'queue-operation:4',
        role: 'system',
        text: 'FIXTURE held',
        data: { proof: 'queue-operation', operation: 'remove' },
      }),
      4,
    );
    should(held.map(input => input.proof)).eql(['native-queue-hold']);
    should(released.map(input => input.proof)).eql(['native-queue-release']);
  });

  it('should read a drained prompt as proof, stamped with the time Claude let go of it and the time the person typed it', () => {
    const observer = inputObserverFor('claude');
    observedInputsOf(
      observer,
      entry({
        id: 'queue-operation:1',
        role: 'system',
        at: at('2026-11-09T10:00:05.000Z'),
        text: 'FIXTURE queued',
        data: { proof: 'queue-operation', operation: 'remove' },
      }),
      1,
    );
    const drained = observedInputsOf(
      observer,
      entry({
        id: 'att-1',
        role: 'system',
        at: at('2026-11-09T10:00:09.000Z'),
        text: 'FIXTURE queued',
        data: { proof: 'queued-prompt', originatedAt: '2026-11-09T10:00:02.000Z' },
      }),
      2,
    );
    should(drained).eql([
      {
        harness: 'claude',
        text: 'FIXTURE queued',
        proof: 'native-queue-drain',
        // The removal's own time, as v4's observer takes it; the person typed it earlier.
        observedAt: '2026-11-09T10:00:05.000Z',
        originatedAt: '2026-11-09T10:00:02.000Z',
        proofKey: 'att-1',
        shapeVersion: 1,
      },
    ]);
    // A drain with no recorded typing time reads the same, without it.
    const bare = observedInputsOf(
      inputObserverFor('claude'),
      entry({ id: 'att-2', role: 'system', text: 'FIXTURE other', data: { proof: 'queued-prompt' } }),
      5,
    );
    should(bare.map(input => [input.proof, input.originatedAt])).eql([
      ['native-queue-drain', '2026-11-09T10:00:00.000Z'],
    ]);
  });

  it('should read a Codex user entry as a normal user record, and skip the preamble Codex writes first', () => {
    const observer = inputObserverFor('codex');
    const proven = observedInputsOf(observer, entry({ id: 'c1', role: 'user', text: 'FIXTURE codex words' }), 0);
    should(proven.map(input => [input.harness, input.proof, input.text, input.proofKey])).eql([
      ['codex', 'normal-user-record', 'FIXTURE codex words', 'c1'],
    ]);
    should(
      observedInputsOf(
        observer,
        entry({ id: 'c2', role: 'user', text: '<environment_context>cwd</environment_context>' }),
        1,
      ),
    ).eql([]);
  });

  it('should prove nothing from an entry that is no input: an assistant’s words, a tool result, or no text', () => {
    for (const harness of ['claude', 'codex'] as const) {
      const observer = inputObserverFor(harness);
      should(observedInputsOf(observer, entry({ id: 'a', role: 'assistant', text: 'FIXTURE reply' }), 0)).eql([]);
      should(observedInputsOf(observer, entry({ id: 't', role: 'tool' }), 1)).eql([]);
      should(observedInputsOf(observer, entry({ id: 'u', role: 'user' }), 2)).eql([]);
    }
  });
});
