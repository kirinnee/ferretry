import { describe, it } from 'bun:test';
import should from 'should';
import { StorageSessionFocus } from '../../../src/adapters/board/session-board-adapters.ts';
import { parseSessionId } from '../../../src/lib/session-id.ts';

const ID = parseSessionId('22222222-2222-4222-8222-222222222222');

const focusWith = (config: Record<string, unknown>) => {
  let stored = config;
  const storage = {
    findSession: () => ({}) as never,
    readConfig: async () => stored as never,
    updateConfig: async (_id: unknown, transform: (current: never) => unknown) => {
      stored = transform(stored as never) as Record<string, unknown>;
      return stored as never;
    },
    append: async () => undefined as never,
  };
  return { focus: new StorageSessionFocus(storage as never), stored: () => stored };
};

describe('focusing a session on a card', () => {
  it("should title an auto-named session with the card's title", async () => {
    const h = focusWith({ name: 'interactive', nameSource: 'auto' });
    await h.focus.setFocus(ID, { id: 'F12' } as never, 'Sidebar titles');
    should(h.stored()).containEql({ name: 'Sidebar titles', nameSource: 'auto' });
    should(h.stored().focusTask).eql({ id: 'F12' });
  });

  it('should keep a name the owner chose, and a name when no title is passed', async () => {
    const owned = focusWith({ name: 'Mine', nameSource: 'owner' });
    await owned.focus.setFocus(ID, { id: 'F12' } as never, 'Sidebar titles');
    should(owned.stored().name).equal('Mine');
    const untitled = focusWith({ name: 'interactive', nameSource: 'auto' });
    await untitled.focus.setFocus(ID, { id: 'F12' } as never);
    should(untitled.stored().name).equal('interactive');
  });
});
