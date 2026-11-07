import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeGate, ownerStanding } from '@ferretry/core-gate/contract/testing';
import {
  ApiError,
  type ApiRequest,
  type CallStanding,
  type KernelPorts,
  type Log,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import type { HookInvoker } from '@ferretry/kernel/manifest';
import { testArrival, fixedClock, owner } from '@ferretry/kernel/testing';
import asksDaemon from '../../../daemon/index.ts';
import manifest from '../../../manifest.ts';
import { asksStateAt } from './agenda-state.ts';

/** What a handler answered, as a client reads it. */
export interface Answered {
  readonly status: number;
  readonly body: string;
  json<T = unknown>(): T;
}

const silent: Log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
};

/**
 * The Asks daemon half built over a REAL kernel state folder in a temporary home, with the hook providers a test
 * chooses, and its route handlers called with a Gate standing. Admission (who may call which route) is Gate's and is
 * not run here: these are handler tests. The kernel's in-memory test host cannot hold this half's opaque files yet.
 */
export async function asksHalf(providers: Readonly<Record<string, unknown>> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'asks-half-'));
  const clock = fixedClock();
  const hooks = {
    provider: (hook: { readonly name: string }, key: string) => providers[`${hook.name}:${key}`] ?? 'unavailable',
    providers: () => new Map(),
  } as unknown as HookInvoker;
  const kernel = { clock, log: silent, state: asksStateAt(home) } as unknown as KernelPorts;
  const build = asksDaemon.build;
  if (build === undefined) throw new Error('the Asks daemon half has no build');
  const half = build({ manifest, needs: { gate: new FakeGate() }, uses: {}, kernel, hooks } as never) as unknown as {
    readonly routes: Readonly<Record<string, RouteHandler>>;
    readonly provides: { readonly asks: import('../../../contract/index.ts').AsksApi };
  };
  return {
    home,
    clock,
    asks: half.provides.asks,
    async call(
      key: string,
      params: Readonly<Record<string, string>>,
      body?: unknown,
      standing: CallStanding = ownerStanding(),
    ): Promise<Answered> {
      const handler = half.routes[key];
      if (handler === undefined) throw new Error(`no handler for ${key}`);
      const [method, path] = key.split(' ') as [string, string];
      const request: ApiRequest = {
        method,
        path,
        query: new Map(),
        headers: new Map(),
        arrival: testArrival(owner()),
        text: async () => (body === undefined ? '' : JSON.stringify(body)),
      };
      let status: number;
      let text: string;
      try {
        const response = await handler({ request, params: new Map(Object.entries(params)), ...standing });
        status = response.status;
        text = response.body;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        status = error.status;
        text = JSON.stringify({ error: error.message, code: error.code });
      }
      return { status, body: text, json: <T>() => JSON.parse(text) as T };
    },
    close: async () => await rm(home, { recursive: true, force: true }),
  };
}
