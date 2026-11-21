/**
 * The Ferrets half of the drawer test for conversation titles: the REAL `FerretsService` and `FerretRegistry`, in the test's own
 * process, with only the edges fake. One ferret (`ms-12`) runs the fake Claude conversation `CONVERSATION`, so the REAL
 * `ferretConversationNames` and `titleOffer` (the daemon's own wiring) see it exactly as the daemon does. The routes answer the
 * page of `core/ferrets/tests/integration/app/fixtures/ferret-titles-scene.tsx` over HTTP: `GET /v1/ferrets`,
 * `GET /v1/ferrets/:id`, `POST /v1/ferrets/:id/rename` (the header's Rename) and `GET /__changes`. Every name and title is fake.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FerretDetails, FerretId, FerretRecord } from '@ferretry/core-ferrets/contract';
import { ok } from '@ferretry/std';
import { FerretsService, type FerretsPorts } from '../../../../../../core/ferrets/daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../../../core/ferrets/daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../../../core/ferrets/daemon/lib/tokens/tokens.ts';

export const FERRET = 'ms-12';
export const CONVERSATION = '3b1a4a52-0000-4000-8000-0000000000f1';

const AT = '2026-11-14T09:30:00.000Z' as never;
const RECORD = {
  format: 1,
  id: FERRET as FerretId,
  name: 'Ms-12',
  role: 'lead',
  harness: 'claude-code',
  harnessConversation: CONVERSATION,
  runner: 'tmux',
  runtime: 'claude-main',
  folder: '/work/app',
  state: 'working',
  birth: 'person',
  createdAt: '2026-11-01T08:00:00.000Z',
  stateAt: AT,
} as unknown as FerretRecord;

interface Change {
  readonly ferret: string;
  readonly state?: string;
  readonly gone?: true;
}

export interface DrawerDaemon {
  readonly service: FerretsService;
  readonly handle: (request: Request) => Promise<Response | undefined>;
  /** What `details.json` holds on disk for the ferret now (`undefined`: no file). */
  readonly stored: () => Promise<FerretDetails | undefined>;
  readonly close: () => Promise<void>;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const drawerDaemon = async (): Promise<DrawerDaemon> => {
  const directory = await mkdtemp(join(tmpdir(), 'ferretry-titles-drawer-'));
  const detailsFile = join(directory, `${FERRET}.details.json`);
  const changes: Change[] = [];
  const heard = (change: Change): void => void changes.push(change);
  const registry = new FerretRegistry([], heard);
  const ports = {
    now: () => AT,
    newId: () => 'f-new' as FerretId,
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
    saveDetails: async (_ferret: FerretId, details: FerretDetails) => {
      await writeFile(detailsFile, JSON.stringify(details));
    },
  } as unknown as FerretsPorts;
  const service = new FerretsService(registry, new FerretTokenDirectory(), ports);
  registry.put(RECORD);
  changes.length = 0;

  return {
    service,
    stored: async () => {
      const held = await readFile(detailsFile, 'utf8').catch(() => undefined);
      return held === undefined ? undefined : (JSON.parse(held) as FerretDetails);
    },
    close: async () => await rm(directory, { force: true, recursive: true }),
    handle: async request => {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === '/__changes') return json(changes.slice(Number(url.searchParams.get('after') ?? '0')));
      if (path === '/v1/ferrets') return json(await service.list());
      const one = /^\/v1\/ferrets\/([^/]+)(\/rename)?$/u.exec(path);
      if (one === null) return undefined;
      const ferret = decodeURIComponent(one[1] as string) as FerretId;
      if (one[2] === undefined) {
        const found = await service.get(ferret);
        return found === undefined ? json({ message: `no ferret ${ferret}` }, 404) : json(found);
      }
      const renamed = await service.rename(ferret, (await request.json()) as { name?: string; title?: string });
      return renamed.ok ? json(renamed.value) : json({ message: renamed.error.message }, 409);
    },
  };
};
