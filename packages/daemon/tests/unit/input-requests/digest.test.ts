import { createHash } from 'node:crypto';
import { describe, it } from 'bun:test';
import type { InputTargetFacts } from '@ferretry/protocol';
import should from 'should';
import { digestFacts, digestLine } from '../../../src/lib/input-requests/digest.ts';

const facts: Extract<InputTargetFacts, { kind: 'terminal' }> = {
  kind: 'terminal',
  paneProof: { paneId: '%3', pid: 4242, sessionCreated: 1_700_000_000 },
  foreground: { pid: 4300, pgid: 4300, comm: 'sudo', argv: 'sudo -v' },
  echo: 'off',
  cursorRow: 7,
  promptLine: '[sudo] password for kirin:',
  promptLineDigest: digestLine('[sudo] password for kirin:'),
  recognisedConsumer: true,
};

describe('digesting what the daemon saw at a target', () => {
  it('should give a lowercase sha-256 hex digest', () => {
    should(digestFacts(facts)).match(/^[0-9a-f]{64}$/u);
  });

  it('should not depend on key order', () => {
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(facts).reverse())));

    should(digestFacts(reordered)).equal(digestFacts(facts));
  });

  it('should change when any one fact changes', () => {
    const changed: readonly InputTargetFacts[] = [
      { ...facts, paneProof: { ...facts.paneProof, pid: 4243 } },
      { ...facts, paneProof: { ...facts.paneProof, paneId: '%4' } },
      { ...facts, foreground: { ...facts.foreground, comm: 'bash' } },
      { ...facts, foreground: { ...facts.foreground, pgid: 1 } },
      { ...facts, echo: 'on' },
      { ...facts, cursorRow: 8 },
      { ...facts, promptLineDigest: digestLine('Password:') },
    ];

    for (const other of changed) should(digestFacts(other)).not.equal(digestFacts(facts));
  });

  it('should key every digest so a guess cannot be tested against a shown one', () => {
    should(digestLine('hunter2-UNIQUE')).not.equal(createHash('sha256').update('hunter2-UNIQUE').digest('hex'));
    should(digestFacts(facts)).not.equal(createHash('sha256').update(JSON.stringify(facts)).digest('hex'));
  });

  it('should digest a line deterministically', () => {
    should(digestLine('a')).equal(digestLine('a'));
    should(digestLine('a')).not.equal(digestLine('b'));
  });

  it('should digest facts that carry an array', () => {
    const odd = { kind: 'terminal', list: [{ b: 1, a: 2 }, 3] } as unknown as InputTargetFacts;

    should(digestFacts(odd)).match(/^[0-9a-f]{64}$/u);
  });
});
