import { describe, expect, test } from 'bun:test';
import { ferretConversationNames } from '../../../daemon/links/lib/ferret-names.ts';

const ferret = (extra: Record<string, unknown>) =>
  ({ id: 'ms-12', harness: 'claude-code', harnessConversation: 'c1', name: 'Ms-12', ...extra }) as never;

describe('which ferret runs each conversation, and its title', () => {
  test('a ferret with a title gives it, and who chose it', () => {
    expect(
      ferretConversationNames([ferret({ title: 'Fix flaky login test', titleSource: 'auto' })]).get('claude-code:c1'),
    ).toEqual({
      ferret: 'ms-12',
      name: 'Ms-12',
      title: 'Fix flaky login test',
      titleSource: 'auto',
    });
  });

  test('a title stored before its source existed is the owner’s', () => {
    expect(ferretConversationNames([ferret({ title: 'Mine' })]).get('claude-code:c1')).toMatchObject({
      title: 'Mine',
      titleSource: 'owner',
    });
  });

  test('a ferret with no title, a blank one, or only the start placeholder has none', () => {
    for (const title of [undefined, '', '   ', 'interactive', ' Interactive ']) {
      const found = ferretConversationNames([
        ferret({ title, titleSource: title === undefined ? undefined : 'auto' }),
      ]).get('claude-code:c1');
      expect(found).toEqual({ ferret: 'ms-12', name: 'Ms-12' });
    }
  });

  test('a placeholder the owner typed is their title', () => {
    expect(
      ferretConversationNames([ferret({ title: 'interactive', titleSource: 'owner' })]).get('claude-code:c1'),
    ).toMatchObject({
      title: 'interactive',
      titleSource: 'owner',
    });
  });

  test('a ferret that runs no harness conversation is not listed', () => {
    expect(ferretConversationNames([ferret({ harnessConversation: undefined })]).size).toBe(0);
  });
});
