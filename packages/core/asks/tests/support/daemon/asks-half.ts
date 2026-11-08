import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeGate, ownerStanding } from '@ferretry/core-gate/contract/testing';
import type { CallerGovernance } from '@ferretry/core-gate/contract';
import {
  ApiError,
  type ApiRequest,
  type CallStanding,
  type KernelPorts,
  type Log,
  type RouteHandler,
  type JobSpec,
  type StatePort,
} from '@ferretry/kernel/contract';
import { type HookInvoker, type Needer, providedFor } from '@ferretry/kernel/manifest';
import { testArrival, fixedClock, owner } from '@ferretry/kernel/testing';
import asksDaemon from '../../../daemon/index.ts';
import manifest from '../../../manifest.ts';
import { asksStateAt } from './agenda-state.ts';

/**
 * What the kernel hands a route about its caller's grants: only what a case passes explicitly. A standing that carries
 * its own governance keeps it, and one that names none stays ungoverned, as it always was.
 */
const governanceOf = (governance?: CallerGovernance): { governance?: CallerGovernance } =>
  governance === undefined ? {} : { governance };

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
export async function asksHalf(
  providers: Readonly<Record<string, unknown>> = {},
  options: {
    home?: string;
    wrapState?: (state: StatePort) => StatePort;
    resurfaceAfterMinutes?: number;
  } = {},
) {
  const home = options.home ?? (await mkdtemp(join(tmpdir(), 'asks-half-')));
  const clock = fixedClock();
  const hooks = {
    provider: (hook: { readonly name: string }, key: string) => providers[`${hook.name}:${key}`] ?? 'unavailable',
    providers: () => new Map(),
  } as unknown as HookInvoker;
  const jobs: JobSpec[] = [];
  const events: { name: string; payload: unknown }[] = [];
  const stops: (() => void | Promise<void>)[] = [];
  const stored = asksStateAt(home);
  const pending = new Set<Promise<unknown>>();
  const tracked = new Proxy(options.wrapState?.(stored) ?? stored, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result = Reflect.apply(value, target, args);
        if (result instanceof Promise) {
          pending.add(result);
          void result.then(
            () => pending.delete(result),
            () => pending.delete(result),
          );
        }
        return result;
      };
    },
  });
  const drain = async () => {
    await Bun.sleep(0);
    while (pending.size > 0) await Promise.allSettled([...pending]);
  };
  const kernel = {
    clock,
    log: silent,
    state: tracked,
    jobs: { add: (job: JobSpec) => jobs.push(job) },
    events: { publish: (event: { name: string }, payload: unknown) => events.push({ name: event.name, payload }) },
    lifecycle: { onStop: (stop: () => void | Promise<void>) => stops.push(stop) },
    config: {
      file: () =>
        options.resurfaceAfterMinutes === undefined
          ? undefined
          : { resurfaceAfterMinutes: options.resurfaceAfterMinutes },
    },
  } as unknown as KernelPorts;
  const build = asksDaemon.build;
  if (build === undefined) throw new Error('the Asks daemon half has no build');
  const half = build({ manifest, needs: { gate: new FakeGate() }, uses: {}, kernel, hooks } as never) as unknown as {
    readonly routes: Readonly<Record<string, RouteHandler>>;
    readonly provides: { readonly asks: unknown };
  };
  type Asks = import('../../../contract/index.ts').AsksApi;
  /** The Asks view the kernel hands the plugin with this id: only the Vault's has `tell`. */
  const asksFor = (id: string): Asks =>
    providedFor(half.provides.asks, { id, permissions: {}, ownedSecretReferences: () => new Set() } as Needer) as Asks;
  return {
    home,
    clock,
    /** The Vault's view (the one with `tell`); the other tests use no more than every view has. */
    asks: asksFor('vault'),
    asksFor,
    events,
    jobs,
    start: async () => {
      for (const job of jobs) await job.run(new AbortController().signal);
    },
    restart: async () => {
      for (const stop of stops) await stop();
      await drain();
      return asksHalf(providers, {
        home,
        ...(options.resurfaceAfterMinutes === undefined
          ? {}
          : { resurfaceAfterMinutes: options.resurfaceAfterMinutes }),
      });
    },
    async call(
      key: string,
      params: Readonly<Record<string, string>>,
      body?: unknown,
      standing: CallStanding = ownerStanding(),
      governance?: CallerGovernance,
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
        const response = await handler({
          request,
          params: new Map(Object.entries(params)),
          ...standing,
          ...governanceOf(governance),
        });
        status = response.status;
        text = response.body;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        status = error.status;
        text = JSON.stringify({ error: error.message, code: error.code });
      }
      return { status, body: text, json: <T>() => JSON.parse(text) as T };
    },
    close: async () => {
      for (const stop of stops) await stop();
      await drain();
      await rm(home, { recursive: true, force: true });
    },
  };
}
