/**
 * `one-format` (§7.9, §9.3): a state file's reader accepts more than one format number. Read in subsystem source
 * (tests excepted) as: a `format` compared with a range (`<`, `>=`, …); one file comparing `format` with two or more
 * different numbers; a `switch` on `format` with two or more numeric cases; or a `format:` schema that is a union of
 * literals. The kernel store checks exactly the declared `format`; a second accepted number is a converter.
 */
import { relative, sep } from 'node:path';
import {
  type AstNode,
  type Check,
  type Finding,
  memberPath,
  nameOf,
  parseFile,
  runMain,
  walk,
} from '../gen/lib/check.ts';
import { areaOf } from '../gen/lib/imports.ts';
import { loadWorkspace, sourceFiles } from '../gen/lib/workspace.ts';

const EQUALITY = new Set(['===', '==', '!==', '!=']);
const RANGE = new Set(['<', '>', '<=', '>=']);

function isFormatRef(node: AstNode): boolean {
  const path = node.type === 'Identifier' || node.type === 'MemberExpression' ? memberPath(node) : undefined;
  return path !== undefined && /^format$/i.test(path[path.length - 1] ?? '');
}

function numberOf(node: AstNode): number | undefined {
  return node.type === 'Literal' && typeof node.value === 'number' ? node.value : undefined;
}

function literalNumbers(node: AstNode): number[] {
  const out: number[] = [];
  walk(node, inner => {
    if (inner.type !== 'CallExpression') return;
    const path = memberPath(inner.callee as AstNode);
    if (path?.[path.length - 1] !== 'literal') return;
    for (const arg of inner.arguments as readonly AstNode[]) {
      const value = numberOf(arg);
      if (value !== undefined) out.push(value);
      if (arg.type === 'ArrayExpression')
        for (const element of arg.elements as readonly AstNode[]) {
          const n = element === null ? undefined : numberOf(element);
          if (n !== undefined) out.push(n);
        }
    }
  });
  return out;
}

export function formatsIn(file: string, where = file): Finding[] {
  const check = 'one-format';
  const parsed = parseFile(file);
  const findings: Finding[] = [];
  const compared = new Map<number, number>();
  walk(parsed.program, node => {
    if (node.type === 'BinaryExpression') {
      const left = node.left as AstNode;
      const right = node.right as AstNode;
      const operator = node.operator as string;
      const [ref, other] = isFormatRef(left)
        ? [left, right]
        : isFormatRef(right)
          ? [right, left]
          : [undefined, undefined];
      if (ref === undefined || other === undefined) return;
      const n = numberOf(other);
      if (n === undefined) return;
      // Formats start at 1, so `format < 1` / `format <= 1` admit at most one valid number (a validity guard).
      const formatOnLeft = ref === left;
      const upper = formatOnLeft ? operator === '<' || operator === '<=' : operator === '>' || operator === '>=';
      const strict = operator === '<' || operator === '>';
      const admitsOne = upper && (strict ? n <= 2 : n <= 1);
      if (RANGE.has(operator) && !admitsOne)
        findings.push({
          check,
          where: `${where}:${parsed.line(node.start)}`,
          message: `format compared with ${operator} ${n}: a reader accepts exactly one format`,
        });
      else if (EQUALITY.has(operator) && !compared.has(n)) compared.set(n, node.start);
    } else if (node.type === 'SwitchStatement' && isFormatRef(node.discriminant as AstNode)) {
      const cases = (node.cases as readonly AstNode[])
        .map(c => (c.test === null ? undefined : numberOf(c.test as AstNode)))
        .filter(n => n !== undefined);
      if (new Set(cases).size > 1)
        findings.push({
          check,
          where: `${where}:${parsed.line(node.start)}`,
          message: `switch on format accepts ${[...new Set(cases)].join(', ')}`,
        });
    } else if (node.type === 'Property' && nameOf(node.key) === 'format') {
      const numbers = new Set(literalNumbers(node.value as AstNode));
      if (numbers.size > 1)
        findings.push({
          check,
          where: `${where}:${parsed.line(node.start)}`,
          message: `format schema accepts ${[...numbers].join(', ')}`,
        });
    }
  });
  if (compared.size > 1) {
    const [first] = [...compared.values()];
    findings.push({
      check,
      where: `${where}:${parsed.line(first ?? 0)}`,
      message: `format compared with ${[...compared.keys()].join(', ')}: a reader accepts exactly one format`,
    });
  }
  return findings;
}

export const check: Check = {
  name: 'one-format',
  summary: 'every stored file is read at exactly one format',
  async run(ctx) {
    const ws = loadWorkspace(ctx.root);
    const findings: Finding[] = [];
    for (const pkg of ws.packages) {
      if (pkg.kind !== 'core' && pkg.kind !== 'plugin') continue;
      if (ctx.packageId !== undefined && pkg.id !== ctx.packageId) continue;
      for (const file of sourceFiles(pkg, { tests: false }))
        if (areaOf(pkg, file) !== 'generated')
          findings.push(...formatsIn(file, relative(ws.root, file).split(sep).join('/')));
    }
    return findings;
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
