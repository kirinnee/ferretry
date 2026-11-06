/**
 * The owner-surface words gate's scanner: every string the PWA can SHOW, by PARSING it.
 *
 * THE RULE (docs/agenda.md § One model: the agenda asks, the card shows). The agenda item is the only place the owner
 * acts; a card is read-only status and never the one asking. So no screen heads a box "Card &F12:", says "your answer
 * for the card", or calls anything a "card ask" — the daemon's word for its bookkeeping. The owner restated that rule
 * eight times in five days while each fix patched one screen; the words kept coming back because nothing failed when
 * they did. This makes them fail the commit.
 *
 * WHAT IS READ. Only what can reach a screen: string literals, template literals (each `${…}` read as `{}`), JSX text,
 * and a JSX element's run of text children joined the same way (so `Card &amp;{id}: your answer` is read whole).
 * Comments, identifiers (`cardAsk`, `CardAskBlock`) and data attributes (`data-agenda-card-ask`) are not words anyone
 * sees, and are never read. `oxc-parser` walks the syntax tree, as the synchronous-IO gate's does.
 *
 * Usage: `bun scripts/validate/owner-surface-words.ts <repo root> [file…]`; exits 0 clean, 1 a violation, 2 a broken
 * gate. With files, only those are read (the gate's own tests); without, every file the SCOPE names.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSync } from 'oxc-parser';

/**
 * Every place a string can reach a person: the PWA's own words, and the daemon and protocol code that writes the errors,
 * refusals, notes and history lines the PWA shows as they are. A daemon's log line reads here too: one word to keep out
 * of every string is cheaper than judging which ones a screen might show.
 */
const SCOPE: readonly string[] = [
  'packages/pwa/src/**/*.{ts,tsx}',
  'packages/daemon/src/lib/agenda/**/*.ts',
  'packages/daemon/src/lib/board/**/*.ts',
  'packages/daemon/src/lib/runtime/mounts/**/*.ts',
  'packages/protocol/src/lib/**/*.ts',
];

/** Each forbidden shape, with the words a violation is reported in. */
export const FORBIDDEN: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: '"your answer for the card"', pattern: /\byour answer for the card\b/iu },
  { name: '"card ask"', pattern: /\bcard asks?\b/iu },
  // A heading that names a card as the one asking: "Card &F12:", "Card &amp;{id}:", "Card &${id}:".
  { name: '"Card &…:" heading', pattern: /\bcard\s*&(?:amp;)?\s*(?:[A-Z]+\d+|\{\}|\$\{\})\s*:/iu },
];

export interface Violation {
  readonly line: number;
  readonly name: string;
  readonly text: string;
}

type Node = { readonly type?: unknown; readonly start?: number; readonly [key: string]: unknown };

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';

/** The words one node shows, or `undefined` for a node that shows none of its own. */
const shown = (node: Node): string | undefined => {
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string' ? node.value : undefined;
    case 'TemplateLiteral':
      return (node.quasis as readonly { readonly value: { readonly cooked?: string; readonly raw: string } }[])
        .map(quasi => quasi.value.cooked ?? quasi.value.raw)
        .join('{}');
    case 'JSXText':
      return typeof node.value === 'string' ? node.value : undefined;
    case 'JSXElement':
    case 'JSXFragment': {
      // The element's text children read as one sentence, an expression child as `{}`; nested elements break it.
      const children = (node.children as readonly Node[] | undefined) ?? [];
      if (!children.some(child => child.type === 'JSXText')) return undefined;
      return children
        .map(child =>
          child.type === 'JSXText' ? String(child.value) : child.type === 'JSXExpressionContainer' ? '{}' : ' ',
        )
        .join('');
    }
    default:
      return undefined;
  }
};

/** Every violation in one file's text. A file that does not parse is a broken gate, said by `unparsable`. */
export const scan = (
  fileName: string,
  text: string,
): { readonly violations: readonly Violation[]; readonly unparsable?: string } => {
  const parsed = parseSync(fileName, text, { lang: fileName.endsWith('.tsx') ? 'tsx' : 'ts', sourceType: 'module' });
  if (parsed.errors.length > 0) return { violations: [], unparsable: parsed.errors[0]?.message ?? 'parse error' };
  const lineOf = (offset: number): number => text.slice(0, offset).split('\n').length;
  const violations: Violation[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const each of value) visit(each);
      return;
    }
    if (!isNode(value)) return;
    // A module path is not a word anyone sees.
    if (
      value.type === 'ImportDeclaration' ||
      value.type === 'ExportAllDeclaration' ||
      value.type === 'ImportExpression'
    )
      return;
    const words = shown(value);
    if (words !== undefined) {
      for (const { name, pattern } of FORBIDDEN) {
        if (!pattern.test(words)) continue;
        const line = lineOf(value.start ?? 0);
        const key = `${line}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        violations.push({ line, name, text: words.replace(/\s+/gu, ' ').trim().slice(0, 120) });
      }
    }
    for (const [key, child] of Object.entries(value)) if (key !== 'type') visit(child);
  };
  visit(parsed.program);
  return { violations };
};

const main = async (): Promise<number> => {
  const [root, ...only] = process.argv.slice(2);
  if (root === undefined) {
    console.error('❌ usage: owner-surface-words.ts <repo root> [file…]');
    return 2;
  }
  const files =
    only.length > 0
      ? only
      : SCOPE.flatMap(pattern => [...new Bun.Glob(pattern).scanSync({ cwd: root })]).filter(
          file => !file.endsWith('.d.ts'),
        );
  // Every pattern must find something: a moved directory must fail the gate, not shrink it.
  const empty =
    only.length > 0 ? [] : SCOPE.filter(pattern => !new Bun.Glob(pattern).scanSync({ cwd: root }).next().value);
  if (files.length === 0 || empty.length > 0) {
    console.error(
      `❌ no files matched ${empty.length > 0 ? empty.join(', ') : SCOPE.join(', ')}: the gate would pass on nothing`,
    );
    return 2;
  }
  let broken = false;
  const report: string[] = [];
  for (const file of files.sort()) {
    const result = scan(file, readFileSync(resolve(root, file), 'utf8'));
    if (result.unparsable !== undefined) {
      broken = true;
      console.error(`❌ ${file} could not be parsed: ${result.unparsable}`);
      continue;
    }
    for (const violation of result.violations) {
      report.push(`  ${file}:${violation.line}  ${violation.name}  «${violation.text}»`);
    }
  }
  if (broken) return 2;
  if (report.length > 0) {
    console.error('❌ owner-facing words that make a card the one asking (docs/agenda.md § One model):');
    for (const line of report) console.error(line);
    console.error(`
The agenda item is the only place the owner acts, and a card is read-only status. Say the ask as the
ITEM's own ("Try it", "Approve", "What I need from you"), and name the card at most once, as a plain
reference line ("For &F12 Badge colour"). "Card ask" is the daemon's word for its bookkeeping: keep it in
comments and identifiers, never in a string a screen can show.`);
    return 1;
  }
  console.log(`✅ no owner-facing string makes a card the one asking: ${files.length} source files read`);
  return 0;
};

if (import.meta.main) process.exit(await main());
