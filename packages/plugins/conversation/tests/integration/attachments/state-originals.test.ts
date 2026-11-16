import { describe, expect, test } from 'bun:test';
import { ATTACHMENT_MANIFEST_STATE, ATTACHMENT_ORIGINAL_STATE } from '../../../daemon/attachments/adapters/state.ts';
import { StateAttachmentOriginals } from '../../../daemon/attachments/adapters/originals.ts';
import { AttachmentStore } from '../../../daemon/attachments/lib/index.ts';
import { memoryStatePort } from '../../support/state.ts';

/**
 * A ferret's attachment originals over the plugin's state port. The store's policy is proved in the unit tier over an
 * in-memory fake; what only the real adapter shows is the layout, that an upload writes exactly an original and a
 * manifest, that a failed one leaves neither, and that an unlock never writes plaintext beside the original.
 */

const ID = `att_${'a'.repeat(64)}`;
const encryptedPdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Encrypt 2 0 R >>\n');
const plaintext = new TextEncoder().encode('%PDF-1.7\nsecret plaintext must stay in RAM\n');

const setup = () => {
  const state = memoryStatePort([ATTACHMENT_ORIGINAL_STATE, ATTACHMENT_MANIFEST_STATE]);
  return { state, originals: new StateAttachmentOriginals(state) };
};

describe('StateAttachmentOriginals', () => {
  test('publishes exactly an original and a manifest under the ferret and attachment names', async () => {
    const { state, originals } = setup();
    await originals.publish('ferret-a', ID, new Uint8Array([1, 2]), '{"m":1}\n');
    expect([...state.bytes.keys()].sort()).toEqual([
      `attachments/ferret-a~${ID}.manifest`,
      `attachments/ferret-a~${ID}.original`,
    ]);
    expect(await originals.readManifest('ferret-a', ID)).toBe('{"m":1}\n');
    expect([...(await originals.readOriginal('ferret-a', ID))]).toEqual([1, 2]);
  });

  test('lists one ferret attachments only, and an absent ferret as empty', async () => {
    const { originals } = setup();
    expect(await originals.attachmentIds('ferret-a')).toEqual([]);
    await originals.publish('ferret-a', ID, new Uint8Array([1]), '{}');
    await originals.publish('ferret-b', `att_${'b'.repeat(64)}`, new Uint8Array([1]), '{}');
    expect(await originals.attachmentIds('ferret-a')).toEqual([ID]);
    expect(await originals.readManifest('ferret-a', `att_${'c'.repeat(64)}`)).toBeUndefined();
  });

  test('removes a half-written attachment so no manifest vouches for missing bytes', async () => {
    const { state, originals } = setup();
    const write = state.write.bind(state);
    state.write = (async (file: never, value: never, name?: string) => {
      if ((file as { name: string }).name === 'attachment-manifest') throw new Error('disk full');
      return await write(file, value, name);
    }) as never;
    await expect(originals.publish('ferret-a', ID, new Uint8Array([1]), '{}')).rejects.toThrow('disk full');
    expect(state.bytes.size).toBe(0);
  });

  test('an unlock never writes plaintext beside the original', async () => {
    const { state, originals } = setup();
    const store = new AttachmentStore({
      originals,
      decrypt: async () => plaintext.slice(),
      now: () => new Date(1_770_000_000_000),
    });
    const uploaded = await store.upload('ferret-a', {
      filename: 'private.pdf',
      mime: 'application/pdf',
      bytes: encryptedPdf,
    });
    const before = [...state.bytes.keys()].sort();
    const unlocked = await store.unlock('ferret-a', uploaded.id, 'use once');
    expect(unlocked.encrypted?.locked).toBe(false);
    expect([...state.bytes.keys()].sort()).toEqual(before);
    for (const bytes of state.bytes.values()) expect(Buffer.from(bytes).includes(Buffer.from(plaintext))).toBe(false);
  });
});
