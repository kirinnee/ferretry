/**
 * The resumable SHA-256 agrees with `node:crypto` at every block-boundary length, however the bytes
 * are chunked, and a saved state resumes to the same digest; `isSha256State` refuses every state it
 * would not have written.
 */

import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import should from 'should';
import { isSha256State, Sha256 } from '../../../src/lib/stt/sha256.ts';

const bytesOf = (length: number): Uint8Array => Uint8Array.from({ length }, (_, index) => (index * 31 + 7) % 256);
const reference = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const oneShot = (bytes: Uint8Array): string => new Sha256().update(bytes).hex();

const LENGTHS = [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 4096, 5000, 12_345];

describe('Sha256 digest', () => {
  for (const length of LENGTHS) {
    it(`matches node:crypto for ${length} bytes`, () => {
      const bytes = bytesOf(length);
      should(oneShot(bytes)).equal(reference(bytes));
    });
  }

  it('hashes the empty input to the well-known digest', () => {
    should(new Sha256().hex()).equal('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('is unchanged by how the bytes are chunked', () => {
    const bytes = bytesOf(3000);
    for (const size of [1, 3, 7, 63, 64, 65, 100, 1000]) {
      const hasher = new Sha256();
      for (let offset = 0; offset < bytes.length; offset += size) hasher.update(bytes.subarray(offset, offset + size));
      should(hasher.hex()).equal(reference(bytes));
    }
  });

  it('returns itself from update so calls chain', () => {
    const hasher = new Sha256();
    should(hasher.update(new Uint8Array(0))).equal(hasher);
  });

  it('counts the bytes hashed so far in `length`', () => {
    const hasher = new Sha256();
    should(hasher.length).equal(0);
    hasher.update(bytesOf(10));
    should(hasher.length).equal(10);
    hasher.update(bytesOf(100));
    should(hasher.length).equal(110);
  });
});

describe('Sha256 resume', () => {
  for (const split of [0, 1, 55, 63, 64, 65, 200, 1000]) {
    it(`resumes from a state saved after ${split} bytes`, () => {
      const bytes = bytesOf(1500);
      const first = new Sha256().update(bytes.subarray(0, split));
      const resumed = new Sha256(first.state()).update(bytes.subarray(split));
      should(resumed.hex()).equal(reference(bytes));
      should(resumed.length).equal(bytes.length);
    });
  }

  it('survives a JSON round trip of the state', () => {
    const bytes = bytesOf(777);
    const saved = JSON.stringify(new Sha256().update(bytes.subarray(0, 300)).state());
    const parsed: unknown = JSON.parse(saved);
    should(isSha256State(parsed)).be.true();
    if (!isSha256State(parsed)) throw new Error('state did not survive JSON');
    should(new Sha256(parsed).update(bytes.subarray(300)).hex()).equal(reference(bytes));
  });

  it('reports the unfinished block as hex under 64 bytes', () => {
    const state = new Sha256().update(bytesOf(70)).state();
    should(state.length).equal(70);
    should(state.pending.length).equal(12);
    should(state.h.length).equal(8);
  });

  it('does not finish the original when hex() is read', () => {
    const bytes = bytesOf(200);
    const hasher = new Sha256().update(bytes.subarray(0, 100));
    const early = hasher.hex();
    should(early).equal(reference(bytes.subarray(0, 100)));
    should(hasher.length).equal(100);
    hasher.update(bytes.subarray(100));
    should(hasher.hex()).equal(reference(bytes));
  });

  it('does not let a resumed hasher alter the state it started from', () => {
    const state = new Sha256().update(bytesOf(10)).state();
    const copy = structuredClone(state);
    new Sha256(state).update(bytesOf(500)).hex();
    should(state).eql(copy);
  });
});

describe('isSha256State', () => {
  const real = new Sha256().update(bytesOf(70)).state();

  it('accepts a state this module wrote, empty or part-way', () => {
    should(isSha256State(real)).be.true();
    should(isSha256State(new Sha256().state())).be.true();
    should(isSha256State(new Sha256().update(bytesOf(64)).state())).be.true();
  });

  const rejected: readonly (readonly [string, unknown])[] = [
    ['undefined', undefined],
    ['null', null],
    ['a string', 'state'],
    ['a number', 42],
    ['an empty object', {}],
    ['h that is not an array', { ...real, h: 'nope' }],
    ['h too short', { ...real, h: real.h.slice(0, 7) }],
    ['h too long', { ...real, h: [...real.h, 0] }],
    ['an h word above 32 bits', { ...real, h: [0x1_0000_0000, ...real.h.slice(1)] }],
    ['a negative h word', { ...real, h: [-1, ...real.h.slice(1)] }],
    ['a fractional h word', { ...real, h: [1.5, ...real.h.slice(1)] }],
    ['a string h word', { ...real, h: ['1', ...real.h.slice(1)] }],
    ['a missing length', { h: real.h, pending: real.pending }],
    ['a string length', { ...real, length: '70' }],
    ['a negative length', { ...real, length: -64, pending: '' }],
    ['a fractional length', { ...real, length: 70.5 }],
    ['an unsafe length', { ...real, length: Number.MAX_SAFE_INTEGER + 1, pending: '' }],
    ['an infinite length', { ...real, length: Number.POSITIVE_INFINITY, pending: '' }],
    ['a missing pending', { h: real.h, length: 70 }],
    ['a non-string pending', { ...real, pending: 12 }],
    ['non-hex pending', { ...real, pending: 'zz'.repeat(6) }],
    ['uppercase pending', { ...real, pending: real.pending.toUpperCase() }],
    ['odd-length pending', { ...real, pending: `${real.pending}0` }],
    ['pending of a full block', { ...real, length: 64, pending: '00'.repeat(64) }],
    ['pending shorter than length % 64', { ...real, pending: real.pending.slice(0, -2) }],
    ['pending longer than length % 64', { ...real, pending: `${real.pending}00` }],
  ];

  for (const [name, value] of rejected) {
    it(`rejects ${name}`, () => {
      should(isSha256State(value)).be.false();
    });
  }
});
