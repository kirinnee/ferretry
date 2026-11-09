/**
 * The route report: for every open route row (`kind R`) of `docs/design/rebuild-parity.tsv`, whether descriptor-parity
 * proves it (necessary, never sufficient: a route is `[x]` only with an id-titled route test, see
 * `scripts/validate/parity-ticks.ts`) and whether its handler is a pending or GAP stub. It NEVER edits the ledger.
 *
 *   bun scripts/rebuild/tick-routes.ts            print the report
 *   bun scripts/rebuild/tick-routes.ts --report   write docs/design/rebuild-parity-routes.md
 *   bun scripts/rebuild/tick-routes.ts --check    fail when that file differs from what the report would say
 *
 * Stub detection is a source scan, not a run: from the route key's literal in the owner's non-test `daemon/` source
 * it reads the handler window (down to the next route key) for `pending(`, `*Pending`, `unavailable*`, `GAP(`,
 * `refuses every request` and `not ported`, and it names the lines of those markers the handler FILE carries
 * ("maybe", the handler may reach a stub through a helper). It also reads `ports-pending.json`'s reasons for the
 * route's path. A route whose key is not a literal (built by a helper) says so.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { rowsOf } from '../../packages/core/kernel/testing/parity.ts';
import { contextFor } from '../gen/lib/check.ts';
import { sourceFiles } from '../gen/lib/workspace.ts';
import { movedPairs } from '../validate/descriptor-parity.ts';
import {
  LEDGER,
  type LedgerRow,
  type RouteWorld,
  loadWorld,
  readLedger,
  routeStatus,
} from '../validate/parity-ticks.ts';

export const ROUTES_DOC = 'docs/design/rebuild-parity-routes.md';

const MARKER = /\bpending\(|\w*Pending\b|\bunavailable\w*|\bGAP\(|refuses every request|not ported|is pending/;
const NEXT_KEY = /^\s*'(?:GET|POST|PUT|PATCH|DELETE|WS) \//;

export interface Handler {
  readonly verdict: 'stub' | 'maybe' | 'ok' | 'not-found' | 'no-route';
  readonly text: string;
}

export function scanHandler(
  key: string,
  files: readonly { readonly rel: string; readonly text: string }[],
  reasons: readonly string[],
): Handler {
  const path = key.replace(/^\S+ /, '');
  const named = reasons.find(r => r.includes(path));
  for (const file of files) {
    const lines = file.text.split('\n');
    const at = lines.findIndex(
      l => l.includes(`'${key}'`) && !/^\s*(?:\/\/|\*|route\()/.test(l) && /['"]\s*:|\)\s*=>|,\s*$/.test(l),
    );
    if (at < 0) continue;
    let end = at + 1;
    while (end < lines.length && end < at + 80 && !NEXT_KEY.test(lines[end] as string)) end++;
    const hit = lines.slice(at, end).findIndex(l => MARKER.test(l));
    if (hit >= 0)
      return {
        verdict: 'stub',
        text: `stub at ${file.rel}:${at + hit + 1}: ${(lines[at + hit] as string).trim().slice(0, 80)}`,
      };
    const marks = lines.flatMap((l, i) => (MARKER.test(l) && !/^\s*(?:\/\/|\*)/.test(l) ? [i + 1] : []));
    if (named !== undefined) return { verdict: 'maybe', text: `${file.rel}:${at + 1}; ports-pending names ${path}` };
    return marks.length > 0
      ? {
          verdict: 'maybe',
          text: `${file.rel}:${at + 1}; the file carries pending/GAP markers at ${marks.slice(0, 6).join(', ')}`,
        }
      : { verdict: 'ok', text: `${file.rel}:${at + 1}` };
  }
  // The key is built by a helper: look for the route's last literal segment (`compact-at`, `cancel`) beside a marker.
  const word = path
    .split('/')
    .filter(p => p !== '' && !p.startsWith(':'))
    .pop()
    ?.replace(/-/g, '')
    .toLowerCase();
  if (word !== undefined)
    for (const file of files) {
      const lines = file.text.split('\n');
      const at = lines.findIndex(
        (l, i) =>
          l.replace(/-/g, '').toLowerCase().includes(word) &&
          !/^\s*(?:\/\/|\*)/.test(l) &&
          lines.slice(Math.max(0, i - 1), i + 3).some(w => MARKER.test(w)),
      );
      if (at >= 0)
        return {
          verdict: 'maybe',
          text: `${file.rel}:${at + 1}; "${word}" sits beside a pending/GAP marker (key not a literal)`,
        };
    }
  return named === undefined
    ? {
        verdict: 'not-found',
        text: 'no handler literal for the key in daemon source (built by a helper); check by hand',
      }
    : { verdict: 'maybe', text: `ports-pending names ${path}` };
}

export async function report(root: string): Promise<string> {
  const ctx = contextFor(root);
  const world = await loadWorld(root, ctx.model);
  const model = await ctx.model();
  const rows = readLedger(readFileSync(join(root, LEDGER), 'utf8')).filter(
    (r: LedgerRow) => r.kind === 'R' && !r.status.startsWith('[x]') && !r.status.startsWith('removed by design'),
  );
  const pendingFile = join(root, 'ports-pending.json');
  const pendingReasons = existsSync(pendingFile)
    ? ((JSON.parse(readFileSync(pendingFile, 'utf8')) as { pendingReasons?: Record<string, string[]> })
        .pendingReasons ?? {})
    : {};
  const owner = new Map<string, (typeof model.loaded)[number]>();
  for (const s of model.loaded) for (const r of rowsOf(s.manifest)) owner.set(`${r.table}\t${r.key}`, s);
  const cache = new Map<string, { rel: string; text: string }[]>();
  const filesOf = (s: (typeof model.loaded)[number]) => {
    const hit = cache.get(s.id);
    if (hit) return hit;
    const files = sourceFiles(s.pkg, { tests: false })
      .filter(f => /[/\\]daemon[/\\]/.test(f))
      .map(f => ({ rel: relative(root, f).split('\\').join('/'), text: readFileSync(f, 'utf8') }));
    cache.set(s.id, files);
    return files;
  };
  const body: string[] = [];
  const count = { proven: 0, not: 0, stub: 0, maybe: 0 };
  const why = new Map<string, number>();
  for (const row of rows) {
    const status = routeStatus(row, world);
    const table = row.what.startsWith('WS ') ? 'socket' : 'route';
    // The 5.0 route: the same key, or the one it moved to.
    const now = movedKey(row, world, table);
    const s = now === undefined ? undefined : (owner.get(`${table}\t${now}`) ?? owner.get(`member\t${now}`));
    const handler: Handler =
      now === undefined || s === undefined
        ? { verdict: 'no-route', text: 'no single 5.0 route derivable, so no handler to scan' }
        : scanHandler(now, filesOf(s), pendingReasons[s.id] ?? []);
    if (status.kind === 'proven') count.proven++;
    else {
      count.not++;
      why.set(status.kind, (why.get(status.kind) ?? 0) + 1);
    }
    if (handler.verdict === 'stub') count.stub++;
    if (handler.verdict === 'maybe') count.maybe++;
    const state = status.kind === 'proven' ? 'descriptor proven' : `not proven (${status.kind}): ${status.text}`;
    body.push(
      `| ${row.id} | \`${row.what}\` | ${state.replace(/\|/g, '\\|')} | ${handler.verdict}: ${handler.text.replace(/\|/g, '\\|')} |`,
    );
  }
  return [
    '# Ferretry 5.0 route report',
    '',
    'Generated by `scripts/rebuild/tick-routes.ts --report`. Do not edit by hand; it never edits the parity ledger.',
    '',
    'Descriptor parity is NECESSARY, never sufficient: a route row is `[x]` only with a route test that drives the real handler',
    'through the host and whose title names the row id (enforced by `scripts/validate/parity-ticks.ts`). Use this report to see',
    'which open routes are stubs (`stub`: a pending or GAP refusal in the handler; `maybe`: the handler file carries a marker, or',
    '`ports-pending.json` names the route) before spending a batch on them.',
    '',
    `Open route rows: ${rows.length}. Descriptor proven: ${count.proven}. Not proven: ${count.not}${
      [...why].length > 0
        ? ` (${[...why]
            .sort()
            .map(([k, n]) => `${k} ${n}`)
            .join(', ')})`
        : ''
    }. Handler a stub: ${count.stub}. Maybe a stub: ${count.maybe}.`,
    '',
    '<!-- prettier-ignore -->',
    '| Row | Route | Descriptor | Handler |',
    '| --- | --- | --- | --- |',
    ...body,
    '',
  ].join('\n');
}

function movedKey(row: Pick<LedgerRow, 'what'>, world: RouteWorld, table: string): string | undefined {
  const key = row.what.startsWith('WS ') ? row.what.slice(3) : row.what;
  if (world.next.some(r => r.table === table && r.key === key)) return key;
  return movedPairs(world.today, world.next, world.changes).pairs.find(p => p.was.key === key && p.was.table === table)
    ?.now.key;
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..', '..');
  const text = await report(root);
  const path = join(root, ROUTES_DOC);
  const args = process.argv.slice(2);
  if (args.includes('--check')) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text)
      throw new Error(`${ROUTES_DOC} differs. Regenerate with: bun scripts/rebuild/tick-routes.ts --report`);
  } else if (args.includes('--report')) writeFileSync(path, text);
  else console.log(text);
}
