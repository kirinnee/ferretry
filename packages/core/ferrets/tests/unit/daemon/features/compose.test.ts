import { describe, expect, test } from 'bun:test';
import type { RouteHandler } from '@ferretry/kernel/contract';
import { registerFeatures } from '../../../../daemon/features/compose.ts';
import type { FerretsContext, FerretsFeature } from '../../../../daemon/features/types.ts';

/** A feature serves what it is told to; the composition it is handed is never read here. */
const context = {} as FerretsContext;
const handler: RouteHandler = async () => new Response('') as never;
const feature = (id: string, served: ReturnType<FerretsFeature['register']>): FerretsFeature => ({
  id,
  register: () => served,
});

describe('registerFeatures', () => {
  test('merges what every feature serves, and a feature that serves nothing is fine', () => {
    const composed = registerFeatures(
      [
        feature('a', { routes: { 'GET /a': handler } }),
        feature('b', undefined),
        feature('c', { routes: { 'GET /c': handler }, sockets: { 'GET /s': (async () => undefined) as never } }),
      ],
      context,
    );
    expect(Object.keys(composed.routes)).toEqual(['GET /a', 'GET /c']);
    expect(Object.keys(composed.sockets)).toEqual(['GET /s']);
  });

  test('registers in the order given, each against the one composition', () => {
    const seen: string[] = [];
    const record = (id: string): FerretsFeature => ({
      id,
      register: f => {
        expect(f).toBe(context);
        seen.push(id);
        return undefined;
      },
    });
    registerFeatures([record('first'), record('second')], context);
    expect(seen).toEqual(['first', 'second']);
  });

  test('a route two features both serve is a wiring fault that names both', () => {
    expect(() =>
      registerFeatures(
        [feature('a', { routes: { 'GET /x': handler } }), feature('b', { routes: { 'GET /x': handler } })],
        context,
      ),
    ).toThrow('the features a and b both serve route GET /x');
  });

  test('a socket and a port member two features both serve are wiring faults too', () => {
    const accept = (async () => undefined) as never;
    expect(() =>
      registerFeatures(
        [feature('a', { sockets: { 'GET /s': accept } }), feature('b', { sockets: { 'GET /s': accept } })],
        context,
      ),
    ).toThrow('both serve socket GET /s');
    const read = async () => null;
    expect(() =>
      registerFeatures(
        [feature('a', { port: { lastAutoResume: read } }), feature('b', { port: { lastAutoResume: read } })],
        context,
      ),
    ).toThrow('both serve port member lastAutoResume');
  });

  test('two features with one id are a wiring fault', () => {
    expect(() => registerFeatures([feature('a', undefined), feature('a', undefined)], context)).toThrow(
      'two features are called a',
    );
  });
});
