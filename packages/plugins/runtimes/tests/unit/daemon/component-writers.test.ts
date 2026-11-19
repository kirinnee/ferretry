/**
 * The setup import's door to each owner's `put`: every answer is an outcome, never a throw.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { type ComponentPutResult, type ProfileComponentSource } from '../../../contract/index.ts';
import { componentWriters } from '../../../daemon/adapters/component-writers.ts';
import { TIMED_OUT, type Within } from '../../../daemon/adapters/profile-components.ts';

const WRITE = { kind: 'mcp', name: 'github', reference: 'mcp/github', file: 'mcp/github.yaml', text: '{}\n' } as const;
const direct: Within = work => work;

const owner = (put?: ProfileComponentSource['put']): ProfileComponentSource => ({
  list: async () => [],
  read: async () => undefined,
  ...(put === undefined ? {} : { put }),
});

describe('componentWriters', () => {
  it('should answer written, and hand the owner the name and the document', async () => {
    // Arrange
    const seen: string[] = [];
    const writers = componentWriters(
      () =>
        owner(async (name, text) => {
          seen.push(name, text);
          return { ok: true };
        }),
      direct,
    );

    // Act / Assert
    should(await writers.put(WRITE)).eql({ outcome: 'written' });
    should(seen).eql(['github', '{}\n']);
  });

  it('should answer held when the owner saved it and holds it', async () => {
    const writers = componentWriters(() => owner(async () => ({ ok: true, held: true })), direct);
    should(await writers.put(WRITE)).eql({ outcome: 'held' });
  });

  it("should carry the owner's refusal sentence", async () => {
    const refusal: ComponentPutResult = { ok: false, reason: 'a raw secret is not allowed in "env"' };
    const writers = componentWriters(() => owner(async () => refusal), direct);
    should(await writers.put(WRITE)).eql({ outcome: 'refused', reason: 'a raw secret is not allowed in "env"' });
  });

  it('should refuse in a sentence when the owner is off, offers no write, is slow or throws', async () => {
    // Arrange
    const off = componentWriters(() => 'unavailable', direct);
    const none = componentWriters(() => owner(), direct);
    const slow = componentWriters(() => owner(async () => ({ ok: true })), (async () => TIMED_OUT) as Within);
    const broken = componentWriters(
      () =>
        owner(async () => {
          throw new Error('disk full');
        }),
      direct,
    );

    // Act / Assert
    should(await off.put(WRITE)).eql({
      outcome: 'refused',
      reason: 'the part of Ferretry that owns them is not running',
    });
    should(await none.put(WRITE)).eql({
      outcome: 'refused',
      reason: 'the part of Ferretry that owns them cannot take an import yet',
    });
    should(await slow.put(WRITE)).eql({
      outcome: 'refused',
      reason: 'the part of Ferretry that owns them did not answer in time',
    });
    should(await broken.put(WRITE)).eql({ outcome: 'refused', reason: 'disk full' });
  });
});

describe('componentWriters warnings', () => {
  it("should carry the owner's warnings on a written file", async () => {
    const writers = componentWriters(
      () => owner(async () => ({ ok: true, warnings: ['command "x" is not on this machine'] })),
      direct,
    );
    should(await writers.put(WRITE)).eql({ outcome: 'written', warnings: ['command "x" is not on this machine'] });
  });
});
