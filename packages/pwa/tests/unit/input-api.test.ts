/** The browser's half of the input bridge: one card this build cannot read must not hide the others. */

import { describe, expect, it } from 'bun:test';
import { readInputRequest } from '../../src/lib/input-api.ts';
import { request } from '../support/input-fixtures.ts';

const clientAnswering = (requests: readonly unknown[]) =>
  ({
    request: async (_path: string, schema: { parse: (value: unknown) => unknown }) => schema.parse({ requests }),
  }) as never;

describe('reading the open input requests of a session', () => {
  it('finds the card asked for, even when another card in the list is one this build cannot read', async () => {
    const wanted = request({ id: 'cd'.repeat(16) });
    const found = await readInputRequest(
      clientAnswering([{ id: 'not-a-card', from: 'a newer daemon' }, wanted]),
      wanted.sessionId,
      wanted.id,
    );
    expect(found?.id).toBe(wanted.id);
  });

  it('says nothing is there when the card is no longer listed', async () => {
    const found = await readInputRequest(clientAnswering([{ odd: true }]), 'sess-1', 'gone');
    expect(found).toBeUndefined();
  });
});
