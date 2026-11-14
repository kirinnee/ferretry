import { chmod, mkdir, readdir, utimes } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { moveSealed } from '../sealed.ts';
import { rebaseV4Path } from '../v4/rebase.ts';
import { configs, info, json, runtimeIds, runtimeName } from '../v4/ferrets.ts';
import { agentHomesRoot as targetRoot } from '../v5/harness-paths.ts';
import type { Step } from './index.ts';

const Harness = z.enum(['claude', 'codex']);
const Manifest = z.object({
  version: z.literal(1),
  accounts: z.array(
    z.object({
      id: z.uuid(),
      kind: Harness,
      home: z.string().min(1),
    }),
  ),
  runtimes: z.array(z.object({ id: z.uuid(), name: z.string().min(1), harness: Harness })).optional(),
});

/**
 * A refusal that says where and why, and nothing else: `where` is a path inside the v4 home (never absolute, never
 * content) and `why` is a fixed sentence the owner can act on.
 */
class Refusal extends Error {
  constructor(
    readonly where: string,
    readonly why: string,
  ) {
    super(`${where}: ${why}`);
  }
}

/** Runs `work`; any failure that is not already a {@link Refusal} is reported against `where` with `why`. */
async function named<Result>(where: string, why: string, work: () => Promise<Result>): Promise<Result> {
  try {
    return await work();
  } catch (error) {
    throw error instanceof Refusal ? error : new Refusal(where, why);
  }
}

export const harnessHomesStep: Step = {
  id: 'harness-homes',
  title: 'Harness folders (copied as opaque files; chat history is left behind and NOT usable in v5)',
  owner: ['plugin-claude-code', 'plugin-codex'],
  reads: ['fleet/ids.json', 'fleet/manifest.json', 'fleet/homes/', 'fleet/shared/<claude|codex>/'],
  sealed: [],
  notCarried: [
    {
      what: 'chat history (old conversations and transcripts) as usable conversations',
      why: 'owner ruling !A516: left behind. The folders are copied as opaque files and never opened or linked into v5, so no conversation resumes from them; the originals stay in the v4 home',
    },
    {
      what: 'all harness-home symlinks (including pooled history and sign-in links)',
      why: 'agent-homes declarations specify no v5 link policy; no link is read, followed or re-made; Logins owns sign-ins',
    },
    {
      what: 'runtime-home to per-ferret-home association',
      why: 'v5 declares opaque agent-homes/* but no runtime-to-ferret mapping; runtime UUID folders and the shared pool (_shared) are kept for the owner to connect',
    },
    {
      what: 'harness homes outside fleet/homes or with no known harness',
      why: 'no safe declared source mapping; never inspect external user homes or guess a harness',
    },
    {
      what: '.fy apply bookkeeping, .leases and .migration-progress',
      why: 'generated or transient; v5 regenerates them',
    },
    {
      what: 'auth.json and .credentials.json in runtime homes',
      why: 'sign-ins belong to Logins, not this step; never opened',
    },
  ],
  async run(ctx) {
    const base = { id: this.id, title: this.title, notCarried: this.notCarried };
    /** A path inside the v4 home, for a message. */
    const inHome = (path: string) => relative(ctx.v4.home, path).split(sep).join('/');
    try {
      const homes = join(ctx.v4.fleet, 'homes');
      const shared = join(ctx.v4.fleet, 'shared');
      // Check each ancestor before descending. A fleet link could otherwise redirect into credentials.
      for (const folder of [ctx.v4.fleet, homes, shared]) {
        const source = await named(inHome(folder), 'cannot be inspected', () => info(folder));
        if (source !== undefined && !source.isDirectory()) throw new Refusal(inHome(folder), 'is not a folder');
      }
      const idsFile = inHome(join(ctx.v4.fleet, 'ids.json'));
      const manifestFile = inHome(join(ctx.v4.fleet, 'manifest.json'));
      const ids = await named(idsFile, 'is not a readable runtime id list', () => runtimeIds(ctx.v4.fleet));
      const manifest = await named(manifestFile, 'is not a readable manifest', () =>
        json(join(ctx.v4.fleet, 'manifest.json'), Manifest),
      );
      const known = new Map<string, { harness: 'claude' | 'codex'; home: string }>();
      // A home that was moved or copied: the absolute paths v4 recorded inside its own home are re-based onto `--from`.
      const rebase = (path: string): string => rebaseV4Path(ctx.v4.home, path);
      const inventory = [
        ...(manifest?.accounts ?? []).map(account => ({ ...account, home: rebase(account.home) })),
        ...(manifest?.runtimes ?? []).map(runtime => {
          const entry = ids?.runtimes[runtime.name];
          if (entry !== undefined && entry.id !== runtime.id)
            throw new Refusal(`${manifestFile} (and ${idsFile})`, `name runtime ${runtime.id} with two different ids`);
          return { id: runtime.id, kind: runtime.harness, home: resolve(homes, rebase(entry?.home ?? runtime.id)) };
        }),
      ];
      for (const runtime of inventory) {
        const previous = known.get(runtime.id);
        if (previous !== undefined && (previous.harness !== runtime.kind || previous.home !== runtime.home))
          throw new Refusal(
            `${manifestFile} (and ${idsFile})`,
            `record runtime ${runtime.id} as two different harnesses or homes`,
          );
        known.set(runtime.id, { harness: runtime.kind, home: runtime.home });
      }
      const sessionConfigs = await named(inHome(ctx.v4.sessions), 'has a session record that cannot be read', () =>
        configs(ctx.v4.sessions),
      );
      for (const config of sessionConfigs) {
        const name = runtimeName(config.agent);
        const entry = Object.entries(ids?.runtimes ?? {}).find(
          ([current, value]) => current === name || value.formerNames.includes(name),
        )?.[1];
        if (entry === undefined) continue;
        const home =
          config.transcript?.home === undefined
            ? resolve(homes, rebase(entry.home ?? entry.id))
            : rebase(config.transcript.home);
        const previous = known.get(entry.id);
        if (previous !== undefined && (previous.harness !== config.harness || resolve(previous.home) !== resolve(home)))
          throw new Refusal(
            inHome(join(ctx.v4.sessions, config.id, 'config.json')),
            `names runtime ${entry.id} with a different harness or home than ${manifestFile} does`,
          );
        known.set(entry.id, { harness: config.harness, home });
      }

      const sealed: { file: string; bytes: number }[] = [];
      let links = 0;
      const copyTree = async (from: string, to: string, runtimeHome: boolean): Promise<void> => {
        const source = await named(inHome(from), 'cannot be inspected', () => info(from));
        if (source === undefined) return;
        if (source.isSymbolicLink()) {
          links++;
          return;
        }
        if (source.isDirectory()) {
          if (!ctx.dryRun) await mkdir(ctx.v5.resolve(to), { mode: 0o700, recursive: true });
          for (const name of (await named(inHome(from), 'cannot be listed', () => readdir(from))).sort()) {
            if (name === '.fy' || name === '.leases' || name === '.migration-progress') continue;
            if (runtimeHome && (name === 'auth.json' || name === '.credentials.json')) continue;
            await copyTree(join(from, name), join(to, name), runtimeHome);
          }
          if (!ctx.dryRun) {
            await chmod(ctx.v5.resolve(to), source.mode & 0o777);
            await utimes(ctx.v5.resolve(to), source.atime, source.mtime);
          }
          return;
        }
        if (!source.isFile())
          throw new Refusal(
            inHome(from),
            'is not a regular file (a device, pipe or socket is never copied); remove it from the v4 home, then run the migration again',
          );
        if (!ctx.dryRun) await named(inHome(from), 'cannot be copied', () => moveSealed(from, ctx.v5.resolve(to)));
        sealed.push({ file: to, bytes: source.size });
      };

      // _shared cannot collide with a v4 runtime UUID. No links are invented to point at it.
      for (const harness of ['claude', 'codex'] as const)
        await copyTree(join(shared, harness), join(targetRoot(harness), '_shared'), false);
      const presentHomes = (await info(homes)) === undefined ? [] : await readdir(homes, { withFileTypes: true });
      let carriedHomes = 0;
      let omittedHomes = 0;
      const carriedIds = new Set<string>();
      for (const source of presentHomes) {
        if (source.isSymbolicLink()) {
          links++;
          continue;
        }
        if (!source.isDirectory())
          throw new Refusal(
            inHome(join(homes, source.name)),
            'is not a folder (a runtime home is a folder); remove it from the v4 home, then run the migration again',
          );
        const name = source.name;
        const runtime = [...known.entries()].find(([, item]) => resolve(item.home) === resolve(homes, name));
        if (runtime === undefined) {
          omittedHomes++;
          continue;
        }
        const [id, item] = runtime;
        const inside = relative(resolve(homes), resolve(item.home));
        if (inside === '' || inside.startsWith(`..${sep}`) || inside === '..' || inside.includes(sep)) {
          omittedHomes++;
          continue;
        }
        await copyTree(join(homes, name), join(targetRoot(item.harness), id), true);
        carriedIds.add(id);
        carriedHomes++;
      }
      // A runtime v4 recorded (its id is known) whose home sits under fleet/homes but was not carried: its conversations
      // would be lost while the report said complete. Recorded runtimes and on-disk homes are matched on the SAME key (the
      // runtime id): a recorded home with no folder on disk, or one only a differently-shaped folder stands in for, is named.
      // A recorded home outside fleet/homes is never inspected and stays in the notCarried list.
      const unmapped = [...known.entries()]
        .filter(([id]) => !carriedIds.has(id))
        .map(([, item]) => relative(resolve(homes), resolve(item.home)))
        .filter(inside => inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
        .sort();
      return {
        ...base,
        ...(unmapped.length === 0
          ? { status: 'converted' as const }
          : {
              status: 'failed' as const,
              note: `${unmapped.length} runtime home(s) v4 recorded under fleet/homes could not be mapped to a folder carried, so they were not carried: ${unmapped.join(', ')}`,
            }),
        sealed,
        kept: [
          {
            what: 'opaque harness files copied unopened (kept as files only, not usable conversations)',
            count: sealed.length,
          },
          {
            what: 'runtime homes copied as opaque folders (no conversation resumes from them in v5)',
            count: carriedHomes,
          },
          { what: 'links omitted (no v5 policy)', count: links },
          { what: 'homes omitted (no safe harness mapping)', count: omittedHomes },
        ],
      };
    } catch (error) {
      return {
        ...base,
        status: 'failed' as const,
        note: `cannot convert harness folders: ${error instanceof Refusal ? error.message : 'an unexpected failure (no file is named)'}`,
        kept: [],
        sealed: [],
      };
    }
  },
};
