/**
 * The shape every §7.9 check shares: a name, a `run(ctx)` that answers findings, and a `main` that prints them and
 * exits 1 on any. A check reads the workspace through `ctx` only, so its planted-violation test can hand it a fixture
 * root. The model (manifests, graph, imports, hashes) is built once and shared by every check in one `fy check`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'oxc-parser';
import { type Model, buildModel } from '../registries.ts';
import type { Finding } from './graph.ts';

export type { Finding };

export interface CheckContext {
  readonly root: string;
  model(): Promise<Model>;
  /** `--package <id>`: restrict findings to one package where the check can. */
  readonly packageId?: string;
  /** The git ref `ports-pending.json` may not grow from (default `origin/rebuild/5.0`). */
  readonly base?: string;
  /** Check rows owned by pending packages too (`guarantees`). */
  readonly strict?: boolean;
  /** `--results <path>` (repeatable): JUnit files or folders holding them, where `guarantees` reads whether a test passed. */
  readonly results?: readonly string[];
  /** `--existence-only`: `guarantees` proves a test exists, not that it passed (the commit hook, which runs no tests). */
  readonly existenceOnly?: boolean;
  /**
   * `--tier unit|int`: `guarantees` proves only the rows that have a test in that tier, from the report that tier wrote.
   * A row tested in the other tier alone is that tier's to prove, never a missing report here.
   */
  readonly tier?: 'unit' | 'int';
}

export interface Check {
  readonly name: string;
  readonly summary: string;
  run(ctx: CheckContext): Promise<readonly Finding[]>;
}

export function contextFor(
  root: string,
  options: {
    readonly packageId?: string;
    readonly base?: string;
    readonly strict?: boolean;
    readonly results?: readonly string[];
    readonly existenceOnly?: boolean;
    readonly tier?: 'unit' | 'int';
  } = {},
): CheckContext {
  let model: Promise<Model> | undefined;
  return {
    root,
    model: () => {
      model ??= buildModel(root);
      return model;
    },
    ...options,
  };
}

export function parseArgs(args: readonly string[]): {
  readonly root: string;
  readonly packageId?: string;
  readonly base?: string;
  readonly strict: boolean;
  readonly results?: readonly string[];
  readonly existenceOnly: boolean;
  readonly tier?: 'unit' | 'int';
  readonly rest: readonly string[];
} {
  let root = join(import.meta.dir, '..', '..', '..');
  let packageId: string | undefined;
  let base: string | undefined;
  let strict = false;
  let existenceOnly = false;
  let tier: 'unit' | 'int' | undefined;
  const results: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--root') root = args[++i] as string;
    else if (arg === '--package') packageId = args[++i];
    else if (arg === '--base') base = args[++i];
    else if (arg === '--strict') strict = true;
    else if (arg === '--existence-only') existenceOnly = true;
    else if (arg === '--results') results.push(args[++i] as string);
    else if (arg === '--tier') {
      const value = args[++i];
      if (value !== 'unit' && value !== 'int') throw new Error(`--tier is unit or int, not "${value ?? ''}"`);
      tier = value;
    } else rest.push(arg);
  }
  // CI names the commit the only-down checks compare against (scripts/ci/check-base.sh); `--base` still wins.
  base ??= process.env.FY_CHECK_BASE || undefined;
  return {
    root,
    ...(packageId === undefined ? {} : { packageId }),
    ...(base === undefined ? {} : { base }),
    strict,
    existenceOnly,
    ...(tier === undefined ? {} : { tier }),
    ...(results.length === 0 ? {} : { results }),
    rest,
  };
}

export function report(name: string, findings: readonly Finding[]): number {
  if (findings.length === 0) {
    console.log(`✅ ${name}`);
    return 0;
  }
  for (const finding of findings) console.error(`❌ ${finding.check} · ${finding.where}: ${finding.message}`);
  console.error(`${name}: ${findings.length} finding${findings.length === 1 ? '' : 's'}`);
  return 1;
}

/** `bun scripts/validate/<check>.ts [--root <dir>] [--package <id>] [--base <ref>] [--strict]`. */
export async function runMain(check: Check, argv: readonly string[]): Promise<never> {
  const args = parseArgs(argv);
  const findings = await check.run(contextFor(args.root, args));
  process.exit(report(check.name, findings));
}

// ─── source helpers ───────────────────────────────────────────────────────────────────────────────────────────────

export interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

export interface ParsedFile {
  readonly file: string;
  readonly source: string;
  readonly program: AstNode;
  line(offset: number): number;
}

export function parseFile(file: string): ParsedFile {
  const source = readFileSync(file, 'utf8');
  const parsed = parseSync(file, source, { sourceType: 'module' });
  const starts: number[] = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return {
    file,
    source,
    program: parsed.program as unknown as AstNode,
    line: offset => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((starts[mid] as number) <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    },
  };
}

/** Depth-first over every AST node; `visit` gets the node and its parent chain (nearest last). */
export function walk(root: AstNode, visit: (node: AstNode, parents: readonly AstNode[]) => void): void {
  const parents: AstNode[] = [];
  const step = (node: AstNode): void => {
    visit(node, parents);
    parents.push(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent') continue;
      if (Array.isArray(value)) {
        for (const child of value)
          if (child !== null && typeof child === 'object' && typeof (child as AstNode).type === 'string')
            step(child as AstNode);
      } else if (value !== null && typeof value === 'object' && typeof (value as AstNode).type === 'string')
        step(value as AstNode);
    }
    parents.pop();
  };
  step(root);
}

/** The name of an Identifier-ish node, or undefined. */
export function nameOf(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const n = node as { type?: string; name?: unknown; value?: unknown };
  if (
    (n.type === 'Identifier' || n.type === 'IdentifierName' || n.type === 'IdentifierReference') &&
    typeof n.name === 'string'
  )
    return n.name;
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  return undefined;
}

/** `a.b` → ['a', 'b'] for a static member expression; undefined otherwise. */
export function memberPath(node: AstNode): readonly string[] | undefined {
  if (node.type === 'Identifier') return [node.name as string];
  if (node.type === 'MemberExpression' && node.computed !== true) {
    const object = memberPath(node.object as AstNode);
    const property = nameOf(node.property);
    return object === undefined || property === undefined ? undefined : [...object, property];
  }
  return undefined;
}
