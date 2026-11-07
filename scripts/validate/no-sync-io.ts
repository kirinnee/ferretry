/**
 * The synchronous-IO gate's counter: every use of a blocking file function in daemon code, by PARSING it.
 *
 * WHY A PARSER. The first version counted regular-expression matches, and review found each way it was fail-open:
 * it counted lines, not calls; a nested `statSync(realpathSync(p))` was one match, because the first match ate the
 * parenthesis the second needed as its boundary; `realpathSync.native(p)` and a multi-line `readFileSync as read`
 * import slipped past. A count that a normal line of code can fool is evidence of nothing, so this walks the
 * syntax tree instead (`oxc-parser`: this repository's `typescript` is the native compiler, which has no JavaScript API).
 *
 * WHAT COUNTS. Every IDENTIFIER spelled as one of the blocking names (each `…Sync` function `node:fs` exports, read
 * from the runtime itself, plus `spawnSync`, `execSync` and `execFileSync`) in a position where it is a VALUE: the
 * callee of a call, the name in `fs.readFileSync(…)` or `Bun.spawnSync(…)`, the base of `realpathSync.native(…)`, or a
 * reference handed on (`exists: existsSync`) — the function then runs wherever it is called — and a member
 * spelled as a string (`fs['readFileSync'](…)`). Nested calls count once each, and so does a call inside a
 * destructuring default or a computed key, however deeply the pattern nests. Names that only DECLARE something are not uses: a property or method name in a declaration or
 * signature, a parameter, an import specifier itself.
 *
 * WHAT IS REFUSED OUTRIGHT. Binding a blocking function to ANOTHER NAME — `import { readFileSync as read }`,
 * `const { readFileSync: read } = fs`, at any depth of a pattern, by identifier or by string — because every later
 * call of the new name would be invisible to the count.
 *
 * Usage: `bun scripts/validate/no-sync-io.ts <repo root>`; exits 0 clean, 1 a violation, 2 a broken gate.
 */
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { parseSync } from 'oxc-parser';

const LEDGER = 'scripts/validate/sync-io-allowlist.txt';
// Every daemon half and the kernel's daemon host (Ferretry 5.0 layout); a new plugin is in scope the moment it has
// a `daemon/` half. Glob pathspecs: `*` stays inside one directory (so a test folder named `daemon` is out of
// scope) and `**` reaches every depth below a half.
const SCOPES = [
  ':(glob)packages/core/kernel/host/**/*.ts',
  ':(glob)packages/core/*/daemon/**/*.ts',
  ':(glob)packages/plugins/*/daemon/**/*.ts',
];

/** The runtime's synchronous file functions, and the three that start a child and wait for it. */
export const BLOCKING_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(fs).filter(name => /^[a-z][A-Za-z]*Sync$/u.test(name)),
  'spawnSync',
  'execSync',
  'execFileSync',
]);

export interface FileScan {
  readonly uses: readonly { readonly line: number; readonly name: string }[];
  readonly aliases: readonly { readonly line: number; readonly text: string }[];
  /** Set when the file would not parse: it is refused, never counted as clean. */
  readonly unparsable?: string;
}

/** A syntax-tree node as `oxc-parser` spells it: ESTree, with TypeScript's own node types beside. */
interface EstreeNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [field: string]: unknown;
}

const isNode = (value: unknown): value is EstreeNode =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';

/** Subtrees that only describe types: nothing in them runs. */
const TYPE_ONLY: ReadonlySet<string> = new Set([
  'TSTypeAnnotation',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSTypeQuery',
  'TSTypeReference',
  'TSTypeParameterDeclaration',
  'TSTypeParameterInstantiation',
  'TSDeclareFunction',
  'TSIndexSignature',
  'TSMethodSignature',
  'TSPropertySignature',
]);

/** Whether an identifier found under `parent.key` only NAMES something a declaration introduces. */
function declaresOnly(parent: EstreeNode | undefined, key: string): boolean {
  if (parent === undefined) return false;
  switch (parent.type) {
    case 'Property':
    case 'MethodDefinition':
    case 'PropertyDefinition':
    case 'AccessorProperty':
    case 'TSAbstractMethodDefinition':
    case 'TSAbstractPropertyDefinition':
      return key === 'key' && parent.computed !== true;
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return key === 'id' || key === 'params';
    case 'VariableDeclarator':
    case 'ClassDeclaration':
    case 'ClassExpression':
    case 'TSEnumMember':
    case 'TSModuleDeclaration':
      return key === 'id';
    case 'AssignmentPattern':
      return key === 'left';
    case 'RestElement':
      return key === 'argument';
    case 'CatchClause':
      return key === 'param';
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return key === 'label';
    default:
      return false;
  }
}

/** Every blocking use and every rebinding in one file's text. */
export function scanSource(fileName: string, text: string): FileScan {
  const parsed = parseSync(fileName, text, { lang: 'ts', sourceType: 'module' });
  if (parsed.errors.length > 0)
    return { uses: [], aliases: [], unparsable: parsed.errors[0]?.message ?? 'parse error' };
  const lineStarts = [0];
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) lineStarts.push(at + 1);
  const lineOf = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((lineStarts[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  const uses: { line: number; name: string }[] = [];
  const aliases: { line: number; text: string }[] = [];
  /** The name a key or member spells STATICALLY — an identifier, a string, a template with no holes — else none. */
  const staticName = (node: unknown): string | undefined => {
    if (!isNode(node)) return undefined;
    if (node.type === 'Identifier' && typeof node.name === 'string') return node.name;
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node.type === 'TemplateLiteral' && Array.isArray(node.expressions) && node.expressions.length === 0) {
      const quasi = (node.quasis as EstreeNode[] | undefined)?.[0]?.value as { cooked?: unknown } | undefined;
      return typeof quasi?.cooked === 'string' ? quasi.cooked : undefined;
    }
    return undefined;
  };
  const isBlocking = (name: string | undefined): name is string => name !== undefined && BLOCKING_NAMES.has(name);
  const blocking = (node: unknown): node is EstreeNode & { name: string } =>
    isNode(node) && node.type === 'Identifier' && typeof node.name === 'string' && BLOCKING_NAMES.has(node.name);
  const alias = (node: EstreeNode): void => {
    aliases.push({ line: lineOf(node.start), text: text.slice(node.start, node.end) });
  };
  const children = (node: EstreeNode, each: (child: EstreeNode, key: string) => void): void => {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) each(item, key);
      } else if (isNode(value)) each(value, key);
    }
  };
  /**
   * A binding pattern: its identifiers only NAME new bindings, but everything else in it runs — a default
   * value, a computed key, a member target — and a blocking name taken out under another name is a rebinding.
   */
  const visitPattern = (node: EstreeNode): void => {
    switch (node.type) {
      case 'Identifier':
        return;
      case 'ObjectPattern':
        for (const property of (node.properties as EstreeNode[] | undefined) ?? []) {
          if (property.type === 'RestElement') {
            if (isNode(property.argument)) visitPattern(property.argument);
            continue;
          }
          if (property.computed === true && isNode(property.key)) visit(property.key, property, 'key');
          const value = property.value as EstreeNode | undefined;
          const bound = value?.type === 'AssignmentPattern' ? (value.left as EstreeNode | undefined) : value;
          if (
            isBlocking(staticName(property.key)) &&
            !(bound?.type === 'Identifier' && bound.name === staticName(property.key))
          )
            alias(property);
          if (isNode(value)) visitPattern(value);
        }
        return;
      case 'ArrayPattern':
        for (const element of (node.elements as unknown[] | undefined) ?? [])
          if (isNode(element)) visitPattern(element);
        return;
      case 'AssignmentPattern':
        if (isNode(node.left)) visitPattern(node.left);
        if (isNode(node.right)) visit(node.right, node, 'right');
        return;
      case 'RestElement':
        if (isNode(node.argument)) visitPattern(node.argument);
        return;
      default:
        // A member or other expression used as a target (\`[a[readFileSync(p)]] = …\`) runs as written.
        visit(node, undefined, 'pattern');
    }
  };
  const visit = (node: EstreeNode, parent: EstreeNode | undefined, key: string): void => {
    if (TYPE_ONLY.has(node.type)) return;
    if (node.type === 'ImportSpecifier' || node.type === 'ExportSpecifier') {
      const imported = staticName(node.type === 'ImportSpecifier' ? node.imported : node.local);
      const local = staticName(node.type === 'ImportSpecifier' ? node.local : node.exported);
      if (isBlocking(imported) && local !== imported) alias(node);
      return;
    }
    if (
      node.type === 'ObjectPattern' ||
      node.type === 'ArrayPattern' ||
      node.type === 'AssignmentPattern' ||
      node.type === 'RestElement'
    ) {
      visitPattern(node);
      return;
    }
    if (node.type === 'MemberExpression' && node.computed === true) {
      const name = staticName(node.property);
      if (isBlocking(name) && (node.property as EstreeNode).type !== 'Identifier')
        uses.push({ line: lineOf(node.start), name });
    }
    if (node.type === 'Identifier') {
      if (blocking(node) && !declaresOnly(parent, key)) uses.push({ line: lineOf(node.start), name: node.name });
      return;
    }
    children(node, (child, childKey) => visit(child, node, childKey));
  };
  visit(parsed.program as unknown as EstreeNode, undefined, 'program');
  return { uses, aliases };
}

/** `<count> <path>  # …` lines, several per path summed. */
export function parseLedger(text: string): {
  readonly allowed: ReadonlyMap<string, number>;
  readonly malformed: readonly string[];
} {
  const allowed = new Map<string, number>();
  const malformed: string[] = [];
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(\d+)\s+(\S+)(?:\s+#.*)?$/u.exec(line);
    if (match === null) {
      malformed.push(`line ${String(index + 1)}: ${raw}`);
      continue;
    }
    allowed.set(match[2] ?? '', (allowed.get(match[2] ?? '') ?? 0) + Number(match[1]));
  }
  return { allowed, malformed };
}

function trackedFiles(root: string): readonly string[] {
  const listed = Bun.spawnSync(['git', 'ls-files', '--', ...SCOPES], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (listed.exitCode !== 0) {
    console.error(`❌ git ls-files failed: ${listed.stderr.toString()}`);
    process.exit(2);
  }
  return listed.stdout
    .toString()
    .split('\n')
    .filter(path => path.endsWith('.ts'));
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? '.');
  if (!BLOCKING_NAMES.has('existsSync')) {
    console.error('❌ could not read the synchronous function list from node:fs');
    process.exit(2);
  }
  let ledgerText: string;
  try {
    ledgerText = readFileSync(resolve(root, LEDGER), 'utf8');
  } catch {
    console.error(`❌ the synchronous-IO ledger is missing: ${LEDGER}`);
    process.exit(2);
  }
  const { allowed, malformed } = parseLedger(ledgerText);
  if (malformed.length > 0) {
    console.error(`❌ ${LEDGER} has malformed lines:\n${malformed.map(line => `  ${line}`).join('\n')}`);
    process.exit(2);
  }

  const found = new Map<string, FileScan>();
  for (const path of trackedFiles(root)) {
    let text: string;
    try {
      text = readFileSync(resolve(root, path), 'utf8');
    } catch {
      continue; // Deleted in the working tree but still in the index: nothing there to count.
    }
    const scan = scanSource(path, text);
    if (scan.unparsable !== undefined) {
      console.error(`❌ ${path} would not parse, so its blocking calls cannot be counted: ${scan.unparsable}`);
      process.exit(2);
    }
    if (scan.uses.length > 0 || scan.aliases.length > 0) found.set(path, scan);
  }

  const aliases = [...found].flatMap(([path, scan]) =>
    scan.aliases.map(alias => `  ${path}:${String(alias.line)}: ${alias.text}`),
  );
  if (aliases.length > 0) {
    console.error(
      `❌ a blocking file function is bound to another name, which this gate cannot follow:\n${aliases.join('\n')}`,
    );
    console.error('\nCall it by its own name, so every use is counted.');
    process.exit(1);
  }

  const drift: string[] = [];
  for (const path of [...new Set([...found.keys(), ...allowed.keys()])].sort()) {
    const uses = found.get(path)?.uses ?? [];
    const permitted = allowed.get(path) ?? 0;
    if (uses.length > permitted) {
      drift.push(`  ${path}: ${String(uses.length)} blocking use(s), the ledger allows ${String(permitted)}`);
      for (const use of uses) drift.push(`      ${path}:${String(use.line)}: ${use.name}`);
    } else if (uses.length < permitted) {
      drift.push(
        `  ${path}: ${String(uses.length)} blocking use(s) left, the ledger still says ${String(permitted)} — lower it`,
      );
    }
  }
  if (drift.length > 0) {
    console.error(`❌ synchronous IO in daemon code does not match ${LEDGER}:\n${drift.join('\n')}`);
    console.error(`
The daemon's main thread answers every client; a synchronous file call holds all of them while the disk is
slow. Use \`node:fs/promises\` (or the descriptor helpers in packages/fleet/src/adapters/descriptor-io.ts), or
run the work on a worker thread. If the call truly cannot yield — boot, a CLI subcommand's own process, a
worker thread, a descriptor bracket — add or adjust its ledger line with the reason.`);
    process.exit(1);
  }
  const total = [...found.values()].reduce((sum, scan) => sum + scan.uses.length, 0);
  console.log(`✅ daemon code holds exactly the synchronous IO its ledger declares (${String(total)} uses)`);
}
