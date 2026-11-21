/**
 * The daemon half of the ferret titles browser test: the REAL `FerretsService` and `FerretRegistry`, in the test's own
 * process, with only the edges fake. The state port writes each ferret's `details.json` into a temp directory (so a
 * `restart()` reads what an earlier service wrote, as the daemon does), and a few routes (`GET /v1/ferrets`,
 * `GET /v1/ferrets/:id`, `POST /v1/ferrets/:id/rename`, `GET /__changes`) answer the page's client over HTTP. No network
 * beyond 127.0.0.1; every ferret, name and title is fake data.
 */

import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ok } from '@ferretry/std';
import type { FerretDetails, FerretId, FerretRecord } from '../../../../contract/index.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';

const AT = '2026-11-14T09:30:00.000Z' as never;
const id = (value: string) => value as FerretId;
const record = (ferret: string, name: string, folder: string, state: FerretRecord['state'] = 'working') =>
  ({
    format: 1,
    id: id(ferret),
    name,
    role: 'lead',
    harness: 'claude-code',
    runner: 'tmux',
    runtime: 'claude-main',
    folder,
    state,
    birth: 'person',
    createdAt: '2026-11-01T08:00:00.000Z',
    stateAt: AT,
  }) as unknown as FerretRecord;

const RECORDS = [
  record('f-zoe', 'zoe', '/work/ferretry'),
  record('f-kai', 'kai', '/work/ferretry'),
  record('f-ora', 'ora', '/work/handbook', 'idle'),
];

/** What `details.json` holds when the daemon first starts: an owner's title, a conversation's, and none yet. */
const FIRST_DETAILS: Readonly<Record<string, FerretDetails>> = {
  'f-zoe': { title: 'Fix stuck sign-in', titleSource: 'owner' },
  'f-kai': { title: 'Fix Flaky Login Test', titleSource: 'auto' },
};

interface Change {
  readonly ferret: string;
  readonly state?: string;
  readonly gone?: true;
}

export interface TitlesDaemon {
  /** The routes the page calls; `undefined` for any other path. */
  readonly handle: (request: Request) => Promise<Response | undefined>;
  /** The call the Conversation half makes in process. */
  readonly adoptTitle: (ferret: string, title: string) => Promise<'adopted' | 'kept'>;
  /** The same Rename the header's form sends, started without waiting for anything else. */
  readonly rename: (ferret: string, change: { readonly title?: string }) => Promise<unknown>;
  /** What `details.json` holds on disk for a ferret now (`undefined`: no file). */
  readonly stored: (ferret: string) => Promise<FerretDetails | undefined>;
  /** A daemon restart: a new registry and service that read the details files again. */
  readonly restart: () => Promise<void>;
  /** Back to the first state (the details files as first written, no changes heard), on a fresh service. */
  readonly reset: () => Promise<void>;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const titlesDaemon = async (directory: string): Promise<TitlesDaemon> => {
  const detailsFile = (ferret: string) => join(directory, `${ferret}.details.json`);
  const changes: Change[] = [];
  const heard = (change: Change): void => void changes.push(change);

  const build = async (): Promise<FerretsService> => {
    const registry = new FerretRegistry([], heard);
    const ports = {
      now: () => AT,
      newId: () => id('f-new'),
      newName: () => 'new',
      save: async () => {},
      saveTokens: async () => {},
      harness: () => {
        throw new Error('the test starts nothing');
      },
      harnessKeys: () => ['claude-code'],
      runner: () => {
        throw new Error('the test starts nothing');
      },
      decide: async () => ({ allow: true }),
      launchParts: () => [],
      sitrepSources: () => [],
      instructions: () => [],
      folder: (path: string) => ok(path),
      changed: heard,
      history: async () => {},
      vault: { childEnvironment: async () => ok({}) },
      asks: { open: async () => [] },
      saveDetails: async (ferret: FerretId, details: FerretDetails) => {
        await writeFile(detailsFile(ferret), JSON.stringify(details));
      },
    } as unknown as FerretsPorts;
    const service = new FerretsService(registry, new FerretTokenDirectory(), ports);
    for (const each of RECORDS) {
      registry.put(each);
      const held = await readFile(detailsFile(each.id), 'utf8').catch(() => undefined);
      if (held !== undefined) registry.putDetails(each.id, JSON.parse(held) as FerretDetails);
    }
    return service;
  };
  let service = await build();
  const reset = async (): Promise<void> => {
    for (const each of RECORDS) {
      const first = FIRST_DETAILS[each.id];
      if (first === undefined) await rm(detailsFile(each.id), { force: true });
      else await writeFile(detailsFile(each.id), JSON.stringify(first));
    }
    changes.length = 0;
    service = await build();
    changes.length = 0;
  };
  await reset();

  return {
    adoptTitle: async (ferret, title) => await service.adoptTitle(id(ferret), title),
    rename: async (ferret, change) => await service.rename(id(ferret), change),
    stored: async ferret => {
      const held = await readFile(detailsFile(ferret), 'utf8').catch(() => undefined);
      return held === undefined ? undefined : (JSON.parse(held) as FerretDetails);
    },
    restart: async () => {
      service = await build();
    },
    reset,
    handle: async request => {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === '/__changes') return json(changes.slice(Number(url.searchParams.get('after') ?? '0')));
      if (path === '/v1/ferrets') return json(await service.list());
      const one = /^\/v1\/ferrets\/([^/]+)(\/rename)?$/u.exec(path);
      if (one === null) return undefined;
      const ferret = id(decodeURIComponent(one[1] as string));
      if (one[2] === undefined) {
        const found = await service.get(ferret);
        return found === undefined ? json({ message: `no ferret ${ferret}` }, 404) : json(found);
      }
      const renamed = await service.rename(ferret, (await request.json()) as { name?: string; title?: string });
      return renamed.ok ? json(renamed.value) : json({ message: renamed.error.message }, 409);
    },
  };
};
