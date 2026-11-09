import { describe, expect, it } from 'bun:test';
import { addToChatMessage, NO_ADD_TO_CHAT } from '../../../app/lib/add-to-chat.ts';

describe('S15 Board asks Conversation to add a card to the chat', () => {
  it('S15 says the sentence the provider gave, for the ferret and reference it was asked about', () => {
    const asked: unknown[][] = [];
    const hook = {
      add: (...args: unknown[]) => {
        asked.push(args);
        return { outcome: 'added', message: "Added &F12 to this ferret's message." };
      },
    };
    expect(addToChatMessage(hook, 'ms-98', '&F12')).toBe("Added &F12 to this ferret's message.");
    expect(asked).toEqual([['ms-98', '&F12']]);
  });

  it('S15 with no provider (absent, paused, or two providers) says so in words and sends nothing', () => {
    expect(addToChatMessage(undefined, 'ms-98', '&F12')).toBe(NO_ADD_TO_CHAT);
    expect(addToChatMessage({}, 'ms-98', '&F12')).toBe(NO_ADD_TO_CHAT);
    expect(addToChatMessage({ add: 'x' }, 'ms-98', '&F12')).toBe(NO_ADD_TO_CHAT);
  });
});
