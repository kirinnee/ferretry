/**
 * `composeFeatures` is the plugin kit's runtime composer: every plugin's features register against one context, and a key
 * two features both serve is a wiring fault that names both, prefixed with the plugin's label.
 */
import { describe, expect, test } from 'bun:test';
import type { RouteHandler } from '../../../contract/route.ts';
import type { SocketAccept } from '../../../contract/socket.ts';
import { type ComposableFeature, composeFeatures } from '../../../manifest/index.ts';

interface Port {
  readonly read: () => Promise<null>;
}
const context = { shared: true };
const handler = (async () => new Response('')) as unknown as RouteHandler;
const accept = (async () => undefined) as unknown as SocketAccept;
const feature = (
  id: string,
  served: ReturnType<ComposableFeature<typeof context, Port>['register']>,
): ComposableFeature<typeof context, Port> => ({ id, register: () => served });
const compose = (...features: readonly ComposableFeature<typeof context, Port>[]) =>
  composeFeatures<typeof context, Port>('plug', features, context);

describe('composeFeatures', () => {
  test('merges what every feature serves, and a feature that serves nothing is fine', () => {
    const composed = compose(
      feature('a', { routes: { 'GET /a': handler } }),
      feature('b', undefined),
      feature('c', { routes: { 'GET /c': handler }, sockets: { 'GET /s': accept } }),
    );
    expect(Object.keys(composed.routes)).toEqual(['GET /a', 'GET /c']);
    expect(Object.keys(composed.sockets)).toEqual(['GET /s']);
  });

  test('registers in the order given, each against the one context', () => {
    const seen: string[] = [];
    const record = (id: string): ComposableFeature<typeof context, Port> => ({
      id,
      register: given => {
        expect(given).toBe(context);
        seen.push(id);
        return undefined;
      },
    });
    compose(record('first'), record('second'));
    expect(seen).toEqual(['first', 'second']);
  });

  test('a route two features both serve is a wiring fault that names the plugin and both features', () => {
    expect(() =>
      compose(feature('a', { routes: { 'GET /x': handler } }), feature('b', { routes: { 'GET /x': handler } })),
    ).toThrow('plug: the features a and b both serve route GET /x');
  });

  test('a socket and a port member two features both serve are wiring faults too', () => {
    expect(() =>
      compose(feature('a', { sockets: { 'GET /s': accept } }), feature('b', { sockets: { 'GET /s': accept } })),
    ).toThrow('plug: the features a and b both serve socket GET /s');
    const read = async () => null;
    expect(() => compose(feature('a', { port: { read } }), feature('b', { port: { read } }))).toThrow(
      'plug: the features a and b both serve port member read',
    );
  });

  test('two features with one id are a wiring fault', () => {
    expect(() => compose(feature('a', undefined), feature('a', undefined))).toThrow('plug: two features are called a');
  });
});
