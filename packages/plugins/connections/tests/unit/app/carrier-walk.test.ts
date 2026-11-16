/**
 * The app's carrier walk over a daemon's published set (`app/lib/connection.ts`): the order it dials in and the
 * carriers it refuses to dial at all.
 */
import { describe, expect, test } from 'bun:test';
import { chooseConnection, publishedConnectionMethods } from '../../../app/lib/connection.ts';
import { PublishedCarriersSchema } from '../../../contract/index.ts';

describe('the app walk over a published set', () => {
  test('R197 within a kind the daemon’s order is kept as published: no re-sort, no race, no score', () => {
    // Deliberately not alphabetical, not by length, and with the kinds interleaved.
    const published = PublishedCarriersSchema.parse([
      { kind: 'relay', url: 'https://zulu.example' },
      { kind: 'direct', url: 'https://second.box.example' },
      { kind: 'relay', url: 'https://alpha.example' },
      { kind: 'direct', url: 'https://a.example' },
      { kind: 'relay', url: 'https://mike-a-much-longer-name.example' },
    ]);
    const methods = publishedConnectionMethods(published);
    expect(methods.filter(m => m.kind === 'relay').map(m => (m.kind === 'relay' ? m.relayUrl : ''))).toEqual([
      'https://zulu.example',
      'https://alpha.example',
      'https://mike-a-much-longer-name.example',
    ]);
    expect(methods.filter(m => m.kind === 'direct').map(m => (m.kind === 'direct' ? m.daemonUrl : ''))).toEqual([
      'https://second.box.example',
      'https://a.example',
    ]);
    // Every carrier reachable: the first in the walk wins, whatever answered "faster".
    const choice = chooseConnection(methods.map(method => ({ method, reachable: true })));
    expect(choice).toMatchObject({ ok: true, method: methods[0] });
  });

  test('R581 a published relay is wss: or https:, plaintext only to loopback; anything else is no candidate', () => {
    // The daemon's wire refuses it on the way out...
    for (const url of ['http://relay.example', 'ws://relay.example', 'ftp://relay.example'])
      expect(PublishedCarriersSchema.safeParse([{ kind: 'relay', url }]).success).toBe(false);
    // ...and the app does not dial one that arrives anyway.
    const methods = publishedConnectionMethods([
      { kind: 'relay', url: 'http://relay.example' } as never,
      { kind: 'relay', url: 'ws://relay.example' } as never,
      { kind: 'relay', url: 'wss://secure.example' },
      { kind: 'relay', url: 'https://hosted.example' },
      { kind: 'relay', url: 'ws://127.0.0.1:8787' },
    ]);
    expect(methods.map(m => (m.kind === 'relay' ? m.relayUrl : m.kind))).toEqual([
      'wss://secure.example',
      'https://hosted.example',
      'ws://127.0.0.1:8787',
    ]);
    expect(publishedConnectionMethods([{ kind: 'relay', url: 'http://relay.example' } as never])).toEqual([]);
  });
});
