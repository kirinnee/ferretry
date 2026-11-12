/**
 * Logins: the harness sign-ins and the model catalog state (`packages/plugins/logins/contract`: `credentials/*`,
 * opaque, and `models.json`).
 *
 * - `fleet/credentials/<login>/` → `state/logins/credentials/<login>/`, moved WHOLE and NEVER OPENED
 *   (`moveSealedTree`): only `lstat` and folder listings are used; each file is copied by the kernel, and one this user
 *   may not read fails the step by path (never hard-linked: the backup must stay its own file); a link is made again,
 *   never followed. A link that points
 *   outside the old credentials folder (a login kept in the harness's own store) stays the very same link; one that
 *   points inside it is pointed at the same place in the new home. The login id (the folder name) is kept: it is the
 *   key of `config/logins/<id>.yaml`, runtimes, budgets and spend.
 * - `state/model-catalog.json` → `state/logins/models.json` `published` (the catalog last taken and verified by v4).
 *
 * - A Codex login with `store: host` (5.0 cannot start Codex from a host store): the Settings step writes it
 *   `store: ferretry` under the same name; here it gets an EMPTY private (0700) folder, nothing is copied or read, and the
 *   report names it for `fy login signin <name>`. See `./host-logins.ts`.
 *
 * `config/logins/*.yaml` is the Settings step's (`./settings.ts`). Logins are keyed by NAME in
 * v4 already, so there is no runtime uuid to re-key here (M7 applies to routing and usage rows).
 */
import { LOGINS_CREDENTIALS, LOGINS_MODELS, LoginIdSchema, ModelsStateSchema } from '@ferretry/plugin-logins/contract';
import { chmod, mkdir, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { KeptItem, StepReport } from '../report.ts';
import { moveSealedTree, SealedUnreadableError } from '../sealed.ts';
import { failureNote, isRecord, readV4Json, V4InputError } from '../v4/documents.ts';
import {
  hasCredentialsRoot,
  V4_CREDENTIALS,
  V4_MODEL_CATALOG,
  V4_PASSIVE_USAGE,
  V4LoginId,
  V4ModelCatalog,
} from '../v4/logins.ts';
import { codexHostLogins, HOST_CODEX_MOVED } from './host-logins.ts';
import type { Step } from './index.ts';

const V5_LOGINS = 'state/logins';
export const V5_CREDENTIALS = join(V5_LOGINS, LOGINS_CREDENTIALS.path.replace(/\/\*$/u, ''));
export const V5_MODELS = join(V5_LOGINS, LOGINS_MODELS.path);

/** The path below `parent` ('' for `parent` itself), or `undefined` when `child` is relative or outside it. */
function within(parent: string, child: string): string | undefined {
  if (!isAbsolute(child)) return undefined;
  const path = relative(resolve(parent), resolve(child));
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path) ? undefined : path;
}

/** The published catalog v4 last took, as v5's `published`; `undefined` when v4 held none or it is unusable. */
async function publishedCatalog(home: string) {
  let value: unknown;
  try {
    value = await readV4Json(home, join(home, V4_MODEL_CATALOG));
  } catch {
    // v4 reads a damaged cache as nothing held; v5 then downloads the catalog again.
    return { held: false as const, damaged: true };
  }
  if (!isRecord(value)) return { held: false as const, damaged: value !== undefined };
  const v4 = V4ModelCatalog.parse(value);
  if (v4.version === undefined || v4.document === undefined || v4.fetchedAt === undefined || v4.checkedAt === undefined)
    return { held: false as const, damaged: false };
  const state = ModelsStateSchema.safeParse({
    format: LOGINS_MODELS.format,
    published: { version: v4.version, fetchedAt: v4.fetchedAt, checkedAt: v4.checkedAt, catalog: v4.document },
  });
  return state.success ? { held: true as const, state: state.data } : { held: false as const, damaged: true };
}

export const loginsStep: Step = {
  id: 'logins',
  title: 'Logins (harness sign-ins moved whole, never opened; model catalog state)',
  owner: ['plugin-logins'],
  reads: [`${V4_CREDENTIALS}/** (listed and moved, never opened)`, V4_MODEL_CATALOG],
  sealed: [`${V4_CREDENTIALS}/<login>/**`],
  notCarried: [
    {
      what: `${V4_CREDENTIALS}/<login>/${V4_PASSIVE_USAGE}`,
      why: 'the last passive rate-limit reading is Usage’s cache, not a sign-in; it is taken again on the next Claude turn or Codex rollout scan',
    },
    {
      what: 'model-catalog.json last (the outcome of the last catalog check)',
      why: 'ModelsStateSchema keeps the catalog held, not the last check’s result; v5 checks again',
    },
    {
      what: 'sign-ins outside the v4 home (store: host, the macOS keychain)',
      why: 'they are the harness’s own store, never Ferretry’s to move or read. A Claude store: host login keeps pointing at it (5.0 starts it from the terminal’s own sign-in); a Codex one is written store: ferretry under the same name with an empty folder, and signed in once',
    },
  ],
  async run(ctx): Promise<StepReport> {
    const home = ctx.v4.home;
    const base = { id: this.id, title: this.title, notCarried: this.notCarried };
    try {
      const credentialsFrom = join(home, V4_CREDENTIALS);
      const credentialsTo = ctx.v5.resolve(V5_CREDENTIALS);
      // `fleet` and `fleet/credentials` are each lstatted: a link in either is refused, never resolved.
      const present = await hasCredentialsRoot(home);

      // Codex logins v4 kept in the terminal's own folder (the Settings step wrote them `store: ferretry`): each gets an
      // EMPTY private folder here, and v4's folder of that name (only usage.json, or a link out) is not moved or followed.
      const codexHost = new Set(await codexHostLogins(ctx));
      const sealed: { file: string; bytes: number }[] = [];
      let logins = 0;
      let links = 0;
      let usageLeft = 0;
      for (const name of present ? (await readdir(credentialsFrom)).sort() : []) {
        const where = `${V4_CREDENTIALS}/${name}`;
        if (!V4LoginId.safeParse(name).success) throw new V4InputError(`${where}: is not a v4 login id`);
        if (!LoginIdSchema.safeParse(name).success)
          throw new V4InputError(
            `${where}: login "${name}" is not a v5 login id (lowercase letters, digits and dashes); rename the login in v4 first`,
          );
        if (codexHost.has(name)) continue;
        const usage = join(credentialsFrom, name, V4_PASSIVE_USAGE);
        const entries = await moveSealedTree(join(credentialsFrom, name), join(credentialsTo, name), {
          write: !ctx.dryRun,
          skip: source => {
            if (source !== usage) return false;
            usageLeft++;
            return true;
          },
          relink: target => {
            const inside = within(credentialsFrom, target);
            return inside === undefined ? target : join(credentialsTo, inside);
          },
        }).catch((error: unknown) => {
          // The mover's own error names paths only, but this sentence is the one the report carries.
          if (error instanceof SealedUnreadableError)
            throw new V4InputError(
              `${V4_CREDENTIALS}/${relative(credentialsFrom, error.path)}: this user cannot read it; give it back to its owner (chmod u+r) in the backup and run the converter again`,
            );
          throw new V4InputError(`${where}: cannot be moved (a socket or device in it, or the target exists)`);
        });
        logins++;
        for (const entry of entries) {
          if (entry.kind === 'link') {
            links++;
            continue;
          }
          sealed.push({ file: relative(ctx.v5.resolve('.'), entry.to), bytes: entry.bytes });
        }
      }

      for (const name of codexHost) {
        if (!V4LoginId.safeParse(name).success || !LoginIdSchema.safeParse(name).success)
          throw new V4InputError(
            `config/logins/${name}.yaml: login "${name}" is not a v5 login id (lowercase letters, digits and dashes); rename the login in v4 first`,
          );
        if (ctx.dryRun) continue;
        const folder = join(credentialsTo, name);
        await mkdir(credentialsTo, { recursive: true, mode: 0o700 });
        await mkdir(folder, { mode: 0o700 });
        await chmod(folder, 0o700);
      }
      const notes: string[] = ctx.dryRun ? ['dry run: nothing written'] : [];
      for (const name of codexHost) notes.push(HOST_CODEX_MOVED(name));
      if (usageLeft > 0) notes.push(`${String(usageLeft)} passive usage reading(s) left for Usage`);
      const catalog = await publishedCatalog(home);
      if (catalog.held)
        await ctx.v5.json({ path: V5_MODELS, format: LOGINS_MODELS.format, schema: ModelsStateSchema }, catalog.state);
      else if (catalog.damaged) notes.push(`${V4_MODEL_CATALOG} is damaged: v5 downloads the catalog again`);

      const kept: KeptItem[] = [
        { what: 'login sign-in folders (moved unopened)', count: logins },
        { what: 'links in sign-in folders made again, never followed', count: links },
        { what: 'published model catalog', count: catalog.held ? 1 : 0 },
      ];
      if (codexHost.size > 0)
        kept.push({
          what: 'Codex store: host logins moved to Ferretry’s own sign-in (empty folder; sign in once)',
          count: codexHost.size,
        });
      return {
        ...base,
        status: 'converted',
        ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
        kept,
        sealed,
      };
    } catch (error) {
      return {
        ...base,
        status: 'failed',
        note: failureNote(error, 'cannot move the login sign-ins'),
        kept: [],
        sealed: [],
      };
    }
  },
};
