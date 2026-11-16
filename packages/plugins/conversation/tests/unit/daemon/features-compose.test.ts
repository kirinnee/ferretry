import { describe, expect, test } from 'bun:test';
import { composeConversation } from '../../../daemon/features/compose.ts';
import type { ConversationContext, ConversationFeature } from '../../../daemon/features/types.ts';

const context = { late: {} } as unknown as ConversationContext;
const handler = (async () => ({ status: 200 })) as never;
const feature = (id: string, register: ConversationFeature['register']): ConversationFeature => ({ id, register });

describe('composeConversation', () => {
  test('merges every feature’s sections and refuses a key two features both serve', () => {
    const composed = composeConversation(
      [
        feature('a', () => ({ routes: { 'GET /a': handler }, tools: { one: handler }, scrubsItsOwnBody: ['GET /a'] })),
        feature('b', () => ({ routes: { 'GET /b': handler }, verbatimFields: { 'GET /b': ['payload'] } })),
        feature('quiet', () => undefined),
      ],
      context,
    );
    expect(Object.keys(composed.routes)).toEqual(['GET /a', 'GET /b']);
    expect(Object.keys(composed.tools)).toEqual(['one']);
    expect([...composed.scrubsItsOwnBody]).toEqual(['GET /a']);
    expect(composed.verbatimFields).toEqual({ 'GET /b': ['payload'] });

    const twice = (sections: Partial<ReturnType<ConversationFeature['register']> & object>) => () =>
      composeConversation([feature('a', () => sections), feature('b', () => sections)], context);
    expect(twice({ routes: { 'GET /x': handler } })).toThrow('the features a and b both serve route GET /x');
    expect(twice({ tools: { t: handler } })).toThrow('the features a and b both serve tool t');
    expect(twice({ hooks: () => ({ 'sitrep.lines': () => [] }) })).toThrow('both serve hook sitrep.lines');
    expect(twice({ subscribers: { 'asks.changed': async () => undefined } })).toThrow(
      'both serve subscriber asks.changed',
    );
    expect(() => composeConversation([feature('a', () => undefined), feature('a', () => undefined)], context)).toThrow(
      'two features are called a',
    );
  });

  test('makes hooks after every feature has registered, so one may read what another built', () => {
    const seen: string[] = [];
    const composed = composeConversation(
      [
        feature('reader', f => ({
          hooks: () => {
            seen.push(`hook sees ${String(f.late.askedQuestion !== undefined)}`);
            return {};
          },
        })),
        feature('owner', f => {
          f.late.askedQuestion = async () => undefined;
          return undefined;
        }),
      ],
      { late: {} } as unknown as ConversationContext,
    );
    expect(seen).toEqual(['hook sees true']);
    expect(composed.hooks).toEqual({});
  });

  test('stops run in registration order', () => {
    const order: string[] = [];
    const composed = composeConversation(
      [
        feature('first', () => ({ stop: () => void order.push('first') })),
        feature('second', () => ({ stop: () => void order.push('second') })),
      ],
      context,
    );
    composed.stop();
    expect(order).toEqual(['first', 'second']);
  });
});
