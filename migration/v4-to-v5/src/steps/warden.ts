/**
 * Warden: v4 `state/warden/` → v5 `state/warden/` (`packages/plugins/warden/manifest.ts`: `state.json`,
 * `reports/*`, `jev-checks/*.json`, `remembered.json`).
 *
 * - `state.json`: v4's sections are carried under v5's `format: 1` stamp (v5's schema is the condensed
 *   `looseObject({format})` until the Warden port restores today's strict sections), except `blessings` (→
 *   `remembered.json`) and `assignments` (not carried, see below). Each `reportPath` is rewritten into the new home.
 * - `remembered.json`: v4's blessing store (keyed by session id) becomes v5's blessing list.
 * - `reports/`: every report and its `.meta.json` copied unopened, mode and times kept.
 * - `jev-checks/<day>.jsonl` → `jev-checks/<day>.json`: `{format: 1, day, checks: [<each v4 line, unchanged>]}`.
 *
 * Nothing here holds a runtime uuid (accounts, failover strikes and investigations name runtimes by NAME), so
 * there is nothing to re-key for M7.
 */
import {
  JevChecksFileSchema,
  RememberedFileSchema,
  WardenBlessingViewSchema,
  WardenStateFileSchema,
} from '@ferretry/plugin-warden/contract';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { KeptItem, StepReport } from '../report.ts';
import { moveSealed } from '../sealed.ts';
import { failureNote, isRecord, readV4Json, V4InputError } from '../v4/documents.ts';
import {
  V4_JEV_CHECK_FILE,
  V4_WARDEN_DIR,
  V4_WARDEN_JEV_CHECKS,
  V4_WARDEN_REPORTS,
  V4_WARDEN_STATE,
  V4Blessing,
} from '../v4/warden.ts';
import type { Step } from './index.ts';

/** `packages/plugins/warden/manifest.ts` (declared in the manifest, not the contract), under `state/warden/`. */
const V5_DIR = 'state/warden';
export const V5_WARDEN_STATE = join(V5_DIR, 'state.json');
export const V5_WARDEN_REMEMBERED = join(V5_DIR, 'remembered.json');
export const V5_WARDEN_REPORTS = join(V5_DIR, 'reports');
export const V5_WARDEN_JEV_CHECKS = join(V5_DIR, 'jev-checks');

/** The path below `parent`, or `undefined` when `child` is not inside it. */
function below(parent: string, child: string): string | undefined {
  if (!isAbsolute(child)) return undefined;
  const path = relative(resolve(parent), resolve(child));
  return path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path) ? undefined : path;
}

/** A folder of the v4 warden, or `undefined` when absent. A link in its place is refused, never followed. */
async function folder(home: string, path: string): Promise<string[] | undefined> {
  const name = relative(home, path);
  const facts = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw new V4InputError(`${name}: cannot be inspected`);
  });
  if (facts === undefined) return undefined;
  if (!facts.isDirectory()) throw new V4InputError(`${name}: is not a folder`);
  return (await readdir(path)).sort();
}

export const wardenStep: Step = {
  id: 'warden',
  title: 'Warden history (sweep memory, blessings, reports, Jev checks)',
  owner: ['plugin-warden'],
  reads: [V4_WARDEN_STATE, `${V4_WARDEN_REPORTS}/*`, `${V4_WARDEN_JEV_CHECKS}/<day>.jsonl`],
  sealed: [],
  notCarried: [
    {
      what: 'state.json assignments (live assigned wardens)',
      why: 'each holds the plaintext stop capability minted into one v4 warden terminal; a v5 warden acts through its own token class, so the capability would authorize nothing and a secret is never copied',
    },
    {
      what: 'a blessing’s status, blessedAt and wardenId',
      why: 'WardenBlessingViewSchema keeps ferret, kinds, expiresAt, by, streak and untilChange only',
    },
    {
      what: 'state/warden/auto-migrate.json (the login-move ledger)',
      why: 'Warden declares no v5 file for it; it remembers only the last hour of moves, so at worst one extra move happens in the first hour',
    },
    {
      what: 'state/warden-{auto-move-failed,orphans,input-stuck,inbox-stuck}.json and state/machine-agenda-members.json',
      why: 'machine-agenda dedupe lists with no v5 file; rebuilt on the next sweep',
    },
    { what: 'torn Jev check lines', why: 'a line that is not a JSON object is skipped, as v4’s own reader skips it' },
    {
      what: 'a reportPath outside state/warden/reports/',
      why: 'v5 must never reach into the old home; v4 only ever writes reports there',
    },
  ],
  async run(ctx): Promise<StepReport> {
    const base = { id: this.id, title: this.title, notCarried: this.notCarried, sealed: [] };
    const home = ctx.v4.home;
    try {
      await folder(home, join(home, V4_WARDEN_DIR));
      const kept: KeptItem[] = [];
      const notes: string[] = [];
      const reportsFrom = join(home, V4_WARDEN_REPORTS);
      let pathsDropped = 0;
      const rebase = (record: Record<string, unknown>): Record<string, unknown> => {
        const { reportPath, ...rest } = record;
        const path = typeof reportPath === 'string' ? below(reportsFrom, reportPath) : undefined;
        if (path === undefined) {
          if (reportPath !== undefined) pathsDropped++;
          return rest;
        }
        return { ...rest, reportPath: ctx.v5.resolve(join(V5_WARDEN_REPORTS, path)) };
      };

      const state = await readV4Json(home, join(home, V4_WARDEN_STATE));
      if (state !== undefined) {
        if (!isRecord(state)) throw new V4InputError(`${V4_WARDEN_STATE}: is not a JSON object`);
        const { blessings, assignments: _secret, format: _none, investigations, sweepCoverage, ...rest } = state;
        const remembered = [];
        let blessingsSkipped = 0;
        if (isRecord(blessings)) {
          for (const [key, entry] of Object.entries(blessings).sort(([a], [b]) => a.localeCompare(b))) {
            const v4 = V4Blessing.safeParse(entry);
            const view =
              v4.success && v4.data.sessionId === key
                ? WardenBlessingViewSchema.safeParse({
                    ferret: v4.data.sessionId,
                    kinds: v4.data.kinds,
                    expiresAt: v4.data.expiresAt,
                    by: v4.data.by ?? 'warden',
                    streak: v4.data.streak,
                    untilChange: v4.data.untilChange,
                  })
                : undefined;
            if (view?.success === true) remembered.push(view.data);
            else blessingsSkipped++;
          }
        } else if (blessings !== undefined) blessingsSkipped++;
        if (blessingsSkipped > 0)
          notes.push(`${String(blessingsSkipped)} damaged blessing(s) not carried (the warden judges those again)`);

        const document = WardenStateFileSchema.parse({
          format: 1,
          ...rest,
          ...(Array.isArray(investigations) ? { investigations: investigations.filter(isRecord).map(rebase) } : {}),
          ...(isRecord(sweepCoverage) ? { sweepCoverage: rebase(sweepCoverage) } : {}),
        });
        await ctx.v5.json({ path: V5_WARDEN_STATE, format: 1, schema: WardenStateFileSchema }, document);
        await ctx.v5.json(
          { path: V5_WARDEN_REMEMBERED, format: 1, schema: RememberedFileSchema },
          RememberedFileSchema.parse({ format: 1, blessings: remembered }),
        );
        kept.push({ what: 'warden sweep memory', count: 1 }, { what: 'blessings', count: remembered.length });
      }
      if (pathsDropped > 0) notes.push(`${String(pathsDropped)} report path(s) outside the reports folder dropped`);

      let reports = 0;
      let leftBehind = 0;
      for (const name of (await folder(home, reportsFrom)) ?? []) {
        const source = join(reportsFrom, name);
        if (!(await lstat(source)).isFile()) {
          leftBehind++;
          continue;
        }
        if (!ctx.dryRun) await moveSealed(source, ctx.v5.resolve(join(V5_WARDEN_REPORTS, name)));
        reports++;
      }
      kept.push({ what: 'investigation reports and provenance files', count: reports });
      if (leftBehind > 0)
        notes.push(`${String(leftBehind)} entr(ies) in the reports folder are not files: left behind`);

      const checksFrom = join(home, V4_WARDEN_JEV_CHECKS);
      let days = 0;
      let checks = 0;
      let torn = 0;
      for (const name of (await folder(home, checksFrom)) ?? []) {
        const day = V4_JEV_CHECK_FILE.exec(name)?.[1];
        if (day === undefined) continue;
        const source = join(checksFrom, name);
        if (!(await lstat(source)).isFile()) throw new V4InputError(`${relative(home, source)}: is not a regular file`);
        const lines: Record<string, unknown>[] = [];
        for (const line of (await readFile(source, 'utf8')).split('\n')) {
          if (line.trim() === '') continue;
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            value = undefined;
          }
          if (isRecord(value)) lines.push(value);
          else torn++;
        }
        await ctx.v5.json(
          { path: join(V5_WARDEN_JEV_CHECKS, `${day}.json`), format: 1, schema: JevChecksFileSchema },
          JevChecksFileSchema.parse({ format: 1, day, checks: lines }),
        );
        days++;
        checks += lines.length;
      }
      kept.push({ what: 'Jev check days', count: days }, { what: 'Jev checks', count: checks });
      if (torn > 0) notes.push(`${String(torn)} torn Jev check line(s) skipped`);
      if (ctx.dryRun) notes.unshift('dry run: nothing written');
      return {
        ...base,
        status: 'converted',
        ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
        kept,
      };
    } catch (error) {
      return { ...base, status: 'failed', note: failureNote(error, 'cannot convert the warden’s files'), kept: [] };
    }
  },
};
