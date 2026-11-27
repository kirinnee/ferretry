import { expect, test } from 'bun:test';
import { FERRET } from '../support/fake-ferrets.ts';
import { world } from '../support/world.ts';

test.each(['attachments', 'attachments/nested'])(
  'R3 a refused source listing refuses export before stop, naming %s',
  async directory => {
    const w = await world({ noTree: true });
    w.source.files = async () => {
      throw new Error(`${directory} could not be listed for a move`);
    };
    await expect(w.relocation.export(FERRET, (await w.offer()).offer)).rejects.toThrow(directory);
    expect(w.ferrets.calls).not.toContain('stop');
  },
);
