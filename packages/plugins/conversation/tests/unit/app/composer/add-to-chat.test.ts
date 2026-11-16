/**
 * S15 `conversation.add-to-chat`: the shared action other surfaces call. Provided over Conversation's own composer
 * registry, keyed by BOTH the daemon the shell names and the ferret the caller names.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { registerComposerQuoteTarget } from '@ferretry/app';
import { addToChatFor } from '../../../../app/composer/add-to-chat.ts';
import { CONVERSATION_ADD_TO_CHAT_HOOK, CONVERSATION_PROVIDED_APP_HOOKS } from '../../../../contract/app-hooks.ts';

const disposers: (() => void)[] = [];
afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
});
const open = (daemonId: string, ferretId: string, draft = '') => {
  const state = { draft };
  disposers.push(
    registerComposerQuoteTarget({
      daemonId,
      ferretId,
      draft: () => state.draft,
      replaceDraft: next => {
        state.draft = next;
      },
    }),
  );
  return state;
};

describe('S15 conversation.add-to-chat', () => {
  test('S15 the provided value passes the contract narrowing; anything else does not', () => {
    const narrows = CONVERSATION_PROVIDED_APP_HOOKS[CONVERSATION_ADD_TO_CHAT_HOOK];
    expect(narrows(addToChatFor('d1'))).toBe(true);
    expect(narrows({})).toBe(false);
    expect(narrows(null)).toBe(false);
    expect(narrows('add')).toBe(false);
  });

  test('S15 adds to exactly the composer of the daemon and ferret named, and says the usual sentence', () => {
    const a = open('d1', 'ms-98', 'look at');
    const sameFerretOtherDaemon = open('d2', 'ms-98');
    const otherFerret = open('d1', 'ms-99');
    const result = addToChatFor('d1').add('ms-98', '&F12');
    expect(result).toEqual({ outcome: 'added', message: "Added &F12 to this ferret's message." });
    expect(a.draft).toBe('look at &F12 ');
    expect(sameFerretOtherDaemon.draft).toBe('');
    expect(otherFerret.draft).toBe('');
  });

  test('S15 a repeat is a duplicate and a ferret with no open composer has nowhere to add it', () => {
    open('d1', 'ms-98', '&F12 ');
    expect(addToChatFor('d1').add('ms-98', '&F12').outcome).toBe('duplicate');
    expect(addToChatFor('d1').add('nobody', '&F12').outcome).toBe('no-composer');
  });

  test('S15 only one whole reference token is accepted: prose, two tokens and an empty ferret are rejected', () => {
    const state = open('d1', 'ms-98');
    for (const bad of ['hello', '&F12 &F13', ' &F12', '&F12 please', '', '%terminal:bad key'])
      expect(addToChatFor('d1').add('ms-98', bad).outcome).toBe('rejected');
    expect(addToChatFor('d1').add('  ', '&F12').outcome).toBe('rejected');
    expect(state.draft).toBe('');
  });
});
