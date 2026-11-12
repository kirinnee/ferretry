/**
 * `unwired-seams` (§7.9): a seam a manifest OFFERS and nothing in production USES.
 *
 * The other graph checks prove every edge a manifest declares has an end. This one is about the edge nobody declared:
 *
 * - R1 a hook offered with no taker (and, for a provide hook with a closed key set, a KEY with no taker);
 * - R2 a hook the offerer's own daemon code never reads or invokes;
 * - R3 a port provided that nothing reaches: no other manifest needs or uses it, the kernel does not bind it, and
 *   the plugin's own `app/` and `cli/` halves never name one of its route paths (the way a half reaches its own
 *   port over HTTP). Static and narrow by ruling (britnee): a port consumed some other way is listed, not guessed at;
 *
 * - R4 a seam left unbound in code: `unbound(` / `unboundFn(`, a `notBuilt*` fallback, a hard-coded
 *   `const x: T | undefined = undefined;`, read by one fixed regex.
 *
 * Each raw seam must be wired or listed in `ports-pending.json` under `"unwired"`, with a `&F<digits>` card and one
 * sentence on what the owner loses (R5). The list only shrinks against the base ref; an entry whose seam is now wired,
 * or names something that does not exist, is a finding.
 *
 * Seam grammar: `hook:<name>[:<key>]` (R1; the bare name covers every key), `read:<hook>` (R2), `port:<name>` (R3),
 * `code:<repo path>:<identifier>` (R4; `<identifier>` may be `*` for the whole file).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { HookDef } from '../../packages/core/kernel/contract/index.ts';
import type { Manifest } from '../../packages/core/kernel/manifest/index.ts';
import { type Check, type Finding, runMain } from '../gen/lib/check.ts';
import { contractPath } from '../gen/lib/workspace.ts';

const CHECK = 'unwired-seams';
const PORTS_PENDING = 'ports-pending.json';

export interface UnwiredEntry {
  readonly seam: string;
  readonly card: string;
  readonly why: string;
}

export interface CodeSeam {
  readonly seam: string;
  /** `path:line`, for the finding. */
  readonly where: string;
}

export interface Facts {
  readonly manifests: ReadonlyMap<string, Manifest>;
  /** offerer id → hook names its daemon code reads or invokes */
  readonly hookReads: ReadonlyMap<string, ReadonlySet<string>>;
  readonly codeSeams: readonly CodeSeam[];
  /** plugin id → its own app/ or cli/ code names one of that plugin's route paths (R3) */
  readonly halfReach: ReadonlyMap<string, boolean>;
  /** repo-relative daemon source files that exist (R5: a code entry names a real file) */
  readonly existingFiles: ReadonlySet<string>;
}

export interface RawSeam {
  readonly seam: string;
  readonly where: string;
  readonly message: string;
}

/**
 * Seams that may enter the list although it only shrinks. The first baseline (a base ref with no `"unwired"` key)
 * needs no entry here: it is the one allowed growth. Add an entry only for a later correction, with its reason.
 */
export const ONE_TIME_UNWIRED_ALLOWANCE: readonly { readonly seam: string; readonly reason: string }[] = [];

// ─── facts ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The closed key set of a provide hook (`z.enum` / `z.literal`), or `undefined` for an open key. */
export function closedKeys(hook: HookDef): readonly string[] | undefined {
  if (hook.mode !== 'provide') return undefined;
  const schema = hook.key as unknown as { options?: unknown; values?: unknown };
  if (Array.isArray(schema.options) && schema.options.every(o => typeof o === 'string'))
    return schema.options as string[];
  if (schema.values instanceof Set) return [...schema.values].filter((v): v is string => typeof v === 'string');
  return undefined;
}

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' ')).replace(/^\s*\/\/.*$/gm, '');

const UNDEFINED_CONST = /^\s*(?:export\s+)?const\s+(\w+)\s*:[^=;]*\|\s*undefined\s*=\s*undefined\s*;/;
const UNBOUND_PROP = /^\s*(\w+)\s*:\s*(?:[\w.]+\s*\?\?\s*)?unbound(?:Fn)?\s*\(/;
const NOT_BUILT_USE = /\b(notBuiltTool|notBuiltRoute)\b/;
const NOT_BUILT_DECL = /\bconst\s+notBuilt(?:Tool|Route)\b/;

/** R4, the fixed regex: every unbound seam in one daemon source file, by identifier. */
export function codeSeamsOf(path: string, source: string): CodeSeam[] {
  const found: CodeSeam[] = [];
  const seen = new Set<string>();
  const add = (ident: string, line: number): void => {
    const seam = `code:${path}:${ident}`;
    if (seen.has(seam)) return;
    seen.add(seam);
    found.push({ seam, where: `${path}:${line}` });
  };
  stripComments(source)
    .split('\n')
    .forEach((text, index) => {
      const line = index + 1;
      const constant = UNDEFINED_CONST.exec(text);
      if (constant !== null) return add(constant[1] as string, line);
      const prop = UNBOUND_PROP.exec(text);
      if (prop !== null) return add(prop[1] as string, line);
      const notBuilt = NOT_BUILT_USE.exec(text);
      if (notBuilt !== null && !NOT_BUILT_DECL.test(text)) add(notBuilt[1] as string, line);
    });
  return found;
}

/** The invoker methods a hook's offerer may call, read from the kernel's `HookInvoker` (not a fixed list). */
export function invokerMethods(root: string): readonly string[] {
  const source = readFileSync(join(root, 'packages/core/kernel/manifest/implement.ts'), 'utf8');
  const body = /export interface HookInvoker \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
  return [...body.matchAll(/^ {2}(\w+)\s*[<(]/gm)].map(match => match[1] as string);
}

function listTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    const full = join(entry.parentPath, entry.name);
    if (full.includes('/testing/') || full.includes('/node_modules/')) continue;
    files.push(full);
  }
  return files.sort();
}

function listTsx(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(e => e.isFile() && e.name.endsWith('.tsx') && !e.name.endsWith('.test.tsx'))
    .map(e => join(e.parentPath, e.name))
    .filter(full => !full.includes('/node_modules/') && !full.includes('/testing/'))
    .sort();
}

/**
 * A route path as a regex over source text: the whole path, a `:param` standing for any segment (or a `${…}`
 * interpolation), and the path must END there (a quote, backtick, `?`, `#` or space), so `/v1/ferrets` does not
 * match `/v1/ferrets/${id}/agenda`, and a base path shared by many plugins reaches only the plugin that owns it whole.
 */
export function routeRegex(path: string): RegExp {
  const segment = '(?:[^/\\s\'"`?#]+|\\$\\{[^}]*\\})';
  const body = path
    .split('/')
    .map(part => (part.startsWith(':') ? segment : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(body + '(?=[\'"`?#\\s]|$)');
}

/** R3: whether any of these files names one of the manifest's own route paths. */
function namesOwnRoute(manifest: Manifest | undefined, files: readonly string[]): boolean {
  const patterns = (manifest?.actions?.routes ?? []).map(r => routeRegex(r.path));
  if (patterns.length === 0 || files.length === 0) return false;
  return files.some(file => {
    const text = stripComments(readFileSync(file, 'utf8'));
    return patterns.some(pattern => pattern.test(text));
  });
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Reads the workspace: every offerer's daemon code (R2) and every daemon file's unbound seams (R4). */
export async function readFacts(ctx: Parameters<Check['run']>[0]): Promise<Facts> {
  const model = await ctx.model();
  const methods = invokerMethods(ctx.root);
  const hookReads = new Map<string, Set<string>>();
  const codeSeams: CodeSeam[] = [];
  const halfReach = new Map<string, boolean>();
  const existingFiles = new Set<string>();
  for (const pkg of model.ws.subsystems) {
    const id = pkg.id as string;
    // The kernel reads its own hooks in its host; every other piece reads them in its daemon half.
    const files = [...listTs(join(pkg.dir, 'daemon')), ...(id === 'kernel' ? listTs(join(pkg.dir, 'host')) : [])];
    const sources = files.map(file => ({
      rel: relative(ctx.root, file),
      text: stripComments(readFileSync(file, 'utf8')),
    }));
    for (const file of files) existingFiles.add(relative(ctx.root, file));
    for (const source of sources)
      codeSeams.push(...codeSeamsOf(source.rel, readFileSync(join(ctx.root, source.rel), 'utf8')));
    halfReach.set(
      id,
      namesOwnRoute(model.graph.manifests.get(id), [
        ...listTs(join(pkg.dir, 'app')),
        ...listTs(join(pkg.dir, 'cli')),
        ...listTsx(join(pkg.dir, 'app')),
      ]),
    );
    const offers = model.graph.manifests.get(id)?.hooks?.offers ?? [];
    if (offers.length === 0) continue;
    const names = new Map<HookDef, string[]>();
    const entry = contractPath(pkg);
    const exported = entry === undefined ? [] : Object.entries((await import(entry)) as Record<string, unknown>);
    for (const offer of offers)
      names.set(
        offer.hook,
        exported.filter(([, v]) => v === offer.hook).map(([k]) => k),
      );
    const reads = new Set<string>();
    const call = `\\.(?:${methods.join('|')})\\s*(?:<[^()]*?>)?\\(\\s*`;
    // An indirect read: the hook is handed BY VALUE to a reader that passes its parameter to the invoker
    // (`components: hook => hooks.provider(hook, KEY)`, then `components(ProfileMcpSource)`).
    const dynamic = new RegExp(`\\.(?:${methods.join('|')})\\s*(?:<[^()]*?>)?\\(\\s*[a-z]\\w*\\s*[,)]`);
    const usesDynamic = sources.some(s => dynamic.test(s.text));
    const code = (text: string): string => text.replace(/^\s*import[\s\S]*?;\s*$/gm, '');
    for (const offer of offers)
      for (const ident of names.get(offer.hook) ?? []) {
        const word = new RegExp(`\\b${escapeRe(ident)}\\b`);
        if (
          sources.some(s => new RegExp(`${call}${escapeRe(ident)}\\b`).test(s.text)) ||
          (usesDynamic && sources.some(s => word.test(code(s.text))))
        )
          reads.add(offer.hook.name);
      }
    hookReads.set(id, reads);
  }
  return { manifests: model.graph.manifests, hookReads, codeSeams, halfReach, existingFiles };
}

// ─── the raw seams ────────────────────────────────────────────────────────────────────────────────────────────────

/** Every seam that is offered and not used (R1–R4), before the allowlist. */
export function unwiredSeams(facts: Facts): RawSeam[] {
  const seams: RawSeam[] = [];
  const takes = (name: string): { id: string; key?: string }[] => {
    const takers: { id: string; key?: string }[] = [];
    for (const [id, manifest] of facts.manifests)
      for (const take of manifest.hooks?.takes ?? [])
        if (take.hook.name === name) takers.push({ id, ...(take.key === undefined ? {} : { key: take.key }) });
    return takers;
  };
  for (const [id, manifest] of facts.manifests) {
    for (const { hook } of manifest.hooks?.offers ?? []) {
      const takers = takes(hook.name);
      const keys = closedKeys(hook);
      if (keys !== undefined) {
        for (const key of keys)
          if (!takers.some(t => t.key === key))
            seams.push({
              seam: `hook:${hook.name}:${key}`,
              where: id,
              message: `offers hook "${hook.name}" and no plugin takes key "${key}"`,
            });
      } else if (takers.length === 0)
        seams.push({
          seam: `hook:${hook.name}`,
          where: id,
          message: `offers hook "${hook.name}" and nothing takes it`,
        });
      if (!(facts.hookReads.get(id) ?? new Set<string>()).has(hook.name))
        seams.push({
          seam: `read:${hook.name}`,
          where: id,
          message: `offers hook "${hook.name}" and its daemon code never reads or invokes it`,
        });
    }
  }
  for (const [id, manifest] of facts.manifests)
    for (const token of Object.values(manifest.provides ?? {})) {
      if (token.boundBy !== undefined || facts.halfReach.get(id) === true) continue;
      const consumed = [...facts.manifests].some(
        ([other, m]) =>
          other !== id &&
          [...Object.values(m.needs ?? {}), ...Object.values(m.uses ?? {})].some(t => t.name === token.name),
      );
      if (!consumed)
        seams.push({
          seam: `port:${token.name}`,
          where: id,
          message: `provides port "${token.name}" that no other plugin and no app or cli half of its own reaches`,
        });
    }
  for (const code of facts.codeSeams)
    seams.push({ seam: code.seam, where: code.where, message: `leaves a seam unbound in code (${code.seam})` });
  return seams;
}

// ─── the allowlist ────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether an allowlist seam covers a raw seam: exact, a bare hook name over its keys, or a whole-file code entry. */
export function covers(entry: string, raw: string): boolean {
  if (entry === raw) return true;
  if (entry.startsWith('hook:') && raw.startsWith('hook:')) return raw.startsWith(`${entry}:`);
  if (entry.startsWith('code:') && entry.endsWith(':*')) return raw.startsWith(entry.slice(0, -1));
  return false;
}

const portNames = (facts: Facts): Set<string> => {
  const names = new Set<string>();
  for (const manifest of facts.manifests.values())
    for (const token of Object.values(manifest.provides ?? {})) names.add(token.name);
  return names;
};
const hookNames = (facts: Facts): Set<string> => {
  const names = new Set<string>();
  for (const manifest of facts.manifests.values())
    for (const { hook } of manifest.hooks?.offers ?? []) names.add(hook.name);
  return names;
};

export function unwiredFindings(
  facts: Facts,
  entries: readonly UnwiredEntry[],
  base: readonly UnwiredEntry[] | undefined,
): Finding[] {
  const findings: Finding[] = [];
  const at = (where: string, message: string): void => {
    findings.push({ check: CHECK, where, message });
  };
  const raw = unwiredSeams(facts);
  const hooks = hookNames(facts);
  const ports = portNames(facts);
  const seen = new Set<string>();
  for (const entry of entries) {
    const where = PORTS_PENDING;
    if (seen.has(entry.seam)) at(where, `unwired "${entry.seam}" is listed twice`);
    seen.add(entry.seam);
    if (!/^&F\d+$/.test(entry.card)) at(where, `unwired "${entry.seam}" has no &F<digits> card (got "${entry.card}")`);
    if (entry.why.trim() === '') at(where, `unwired "${entry.seam}" does not say why (what the owner loses)`);
    const [kind, name = '', ...rest] = entry.seam.split(':');
    let exists = true;
    if (kind === 'hook' || kind === 'read') {
      if (!hooks.has(name)) {
        at(where, `unwired "${entry.seam}": no hook named "${name}" is offered`);
        exists = false;
      }
    } else if (kind === 'port') {
      if (!ports.has(name)) {
        at(where, `unwired "${entry.seam}": no port named "${name}" is provided`);
        exists = false;
      }
    } else if (kind === 'code') {
      const file = entry.seam.slice('code:'.length).replace(/:[^:]*$/, '');
      if (!facts.existingFiles.has(file)) {
        at(where, `unwired "${entry.seam}": no file ${file} in any daemon half`);
        exists = false;
      }
    } else {
      at(where, `unwired "${entry.seam}" is not hook:, read:, port: or code:`);
      exists = false;
    }
    void rest;
    if (exists && !raw.some(r => covers(entry.seam, r.seam)))
      at(where, `unwired "${entry.seam}" is stale: it is wired now; delete the line`);
  }
  for (const r of raw)
    if (!entries.some(entry => covers(entry.seam, r.seam)))
      at(
        r.where,
        `${r.message}: wire it, or list "${r.seam}" in ${PORTS_PENDING} "unwired" with a &F card and what the owner loses`,
      );
  if (base !== undefined) {
    for (const entry of entries)
      if (
        !base.some(b => b.seam === entry.seam) &&
        !ONE_TIME_UNWIRED_ALLOWANCE.some(allowed => allowed.seam === entry.seam)
      )
        at(PORTS_PENDING, `unwired "${entry.seam}" was added; the list may only shrink`);
  }
  return findings;
}

// ─── reading ports-pending.json ───────────────────────────────────────────────────────────────────────────────────

/** The `"unwired"` list of a `ports-pending.json` text; `undefined` when the key is absent. */
export function parseUnwired(text: string, where: string): UnwiredEntry[] | undefined {
  const value = (JSON.parse(text) as { unwired?: unknown }).unwired;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${where}: "unwired" is not a list`);
  return value.map((item, index) => {
    const row = item as Partial<Record<keyof UnwiredEntry, unknown>> | null;
    if (
      row === null ||
      typeof row !== 'object' ||
      typeof row.seam !== 'string' ||
      typeof row.card !== 'string' ||
      typeof row.why !== 'string'
    )
      throw new Error(`${where}: "unwired[${index}]" needs a string seam, card and why`);
    return { seam: row.seam, card: row.card, why: row.why };
  });
}

/**
 * The `"unwired"` list the base holds. `undefined` means ONE thing: the base was read and parsed and has no
 * `unwired` key (the true first baseline). A base git cannot read (a bad ref, the file missing at an existing
 * ref, any git error) throws, because comparing against nothing would let the list grow unchecked.
 * `file:<path>` is the test spelling; an absent file there is "no baseline".
 */
export function readBaseUnwired(root: string, ref: string): UnwiredEntry[] | undefined {
  if (ref.startsWith('file:')) {
    const file = ref.slice(5);
    return existsSync(file) ? parseUnwired(readFileSync(file, 'utf8'), file) : undefined;
  }
  const shown = spawnSync('git', ['show', `${ref}:${PORTS_PENDING}`], { cwd: root, encoding: 'utf8' });
  if (shown.status !== 0)
    throw new Error(
      `the base ${ref} cannot be read, so nothing proves the unwired list did not grow; fetch the base or pass a readable --base`,
    );
  return parseUnwired(shown.stdout, `${ref}:${PORTS_PENDING}`);
}

export const check: Check = {
  name: CHECK,
  summary:
    'a hook, port or unbound seam that is offered and not wired is listed with a card, and the list only shrinks',
  async run(ctx) {
    const file = join(ctx.root, PORTS_PENDING);
    let entries: UnwiredEntry[] = [];
    let base: UnwiredEntry[] | undefined;
    try {
      entries = existsSync(file) ? (parseUnwired(readFileSync(file, 'utf8'), PORTS_PENDING) ?? []) : [];
      base = readBaseUnwired(ctx.root, ctx.base ?? 'origin/rebuild/5.0');
    } catch (error) {
      return [{ check: CHECK, where: PORTS_PENDING, message: error instanceof Error ? error.message : String(error) }];
    }
    return unwiredFindings(await readFacts(ctx), entries, base);
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
