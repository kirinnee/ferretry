import { describe, it } from 'bun:test';
import type { TranscriptEntry } from '@ferretry/core-ferrets/contract';
import type { Instant } from '@ferretry/std';
import should from 'should';
import { EntriesSendEvidence } from '../../../../daemon/delivery/adapters/entries-send-evidence.ts';

const at = (value: string): Instant => value as Instant;
const user = (id: string, text: string, when: string): TranscriptEntry => ({ id, role: 'user', text, at: at(when) });

const evidenceOver = (entries: readonly TranscriptEntry[] | Error, harness: 'claude' | 'codex' = 'claude') => {
  const reads: number[] = [];
  const evidence = new EntriesSendEvidence(async () => ({
    harness,
    reader: {
      read: async (...args) => {
        reads.push(args.length);
        if (entries instanceof Error) throw entries;
        return entries;
      },
    },
  }));
  return { evidence, reads };
};

describe('#45 BG-052 the tracker’s evidence over the harness plugin’s entries', () => {
  it('should read the whole conversation once and prove the inputs written since the oldest watched send', async () => {
    const { evidence, reads } = evidenceOver([
      user('u0', 'FIXTURE long ago', '2026-11-09T08:00:00.000Z'),
      user('u1', 'FIXTURE the send', '2026-11-09T10:00:30.000Z'),
    ]);

    const reading = await evidence.read('f1', '2026-11-09T10:00:00.000Z');

    should(reading.readable).be.true();
    should(reading.inputs.map(input => [input.text, input.proof])).eql([['FIXTURE the send', 'normal-user-record']]);
    // One read with no cursor: a cursor made stale by a rewritten file would read as "nothing new".
    should(reads).eql([0]);
  });

  it('should keep an input a minute before the send (clocks and record order drift) and drop the older ones', async () => {
    const { evidence } = evidenceOver([
      user('u1', 'FIXTURE 61s before', '2026-11-09T09:58:59.000Z'),
      user('u2', 'FIXTURE 59s before', '2026-11-09T09:59:01.000Z'),
    ]);

    const reading = await evidence.read('f1', '2026-11-09T10:00:00.000Z');

    should(reading.inputs.map(input => input.text)).eql(['FIXTURE 59s before']);
  });

  it('should read every input when the oldest send’s time is not a time', async () => {
    const { evidence } = evidenceOver([user('u0', 'FIXTURE old', '2026-11-09T08:00:00.000Z')]);

    should((await evidence.read('f1', 'soon')).inputs).have.length(1);
  });

  it('should feed Codex entries to Codex’s own matching', async () => {
    const { evidence } = evidenceOver([user('c1', 'FIXTURE codex', '2026-11-09T10:00:30.000Z')], 'codex');

    const reading = await evidence.read('f1', '2026-11-09T10:00:00.000Z');

    should(reading.inputs.map(input => input.harness)).eql(['codex']);
  });

  it('should say absence cannot be proven when the conversation cannot be read', async () => {
    const { evidence } = evidenceOver(new Error('FIXTURE_SECRET path'));

    const reading = await evidence.read('f1', '2026-11-09T10:00:00.000Z');

    should(reading).eql({ readable: false, inputs: [] });
  });

  it('should call a conversation with no entry at all unbound, because an empty read is also a plugin that found no file', async () => {
    const { evidence } = evidenceOver([]);

    should(await evidence.read('f1', '2026-11-09T10:00:00.000Z')).eql({ readable: false, unbound: true, inputs: [] });
  });

  it('should say absence cannot be proven for a ferret nobody knows, or whose lookup fails', async () => {
    const unknown = new EntriesSendEvidence(async () => undefined);
    const failing = new EntriesSendEvidence(async () => {
      throw new Error('boom');
    });

    should(await unknown.read('f1', '2026-11-09T10:00:00.000Z')).eql({ readable: false, inputs: [] });
    should(await failing.read('f1', '2026-11-09T10:00:00.000Z')).eql({ readable: false, inputs: [] });
  });
});
