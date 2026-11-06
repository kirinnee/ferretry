/**
 * Attributes every line of a `packages/daemon/bin/fyd.ts` to a proposed feature module
 * (`docs/design/daemon-plugins.md` §5). A HEURISTIC, stated so a reader can judge it:
 *
 *  1. Every name `fyd.ts` imports is mapped to the file that defines it under `src/lib` or `src/adapters`
 *     (barrel `export *` chains are resolved by finding the defining `export`), and that file to a module
 *     through `modules.ts`.
 *  2. The file is cut into pieces: each top-level declaration, then, inside any piece longer than
 *     `PIECE_LIMIT` lines, each statement or member at the shallowest inner indent, recursively, each with
 *     its leading comment.
 *  3. A piece goes to the module whose names it mentions most, each mention weighted by
 *     1 / (pieces that mention the name), so plumbing every piece touches does not decide the vote. A local
 *     a piece declares inherits the piece's module only when at most `sharedLimit` pieces use it.
 *  4. A piece that mentions no feature name is `kernel`.
 *
 * The result moves with `sharedLimit` — the plan publishes the range over 3, 6 and 12 rather than one number.
 *
 * Usage (repository root): bun scripts/local/daemon-modules-probe/attribute.ts [fyd.ts] [--limit N] [--json]
 */
import { moduleOfPath } from './modules.ts';

export const IMPORT_LINES = '(import lines)';
const PIECE_LIMIT = 120;

export interface Attribution {
  /** The module of every line, 0-based. */
  readonly perLine: readonly string[];
  /** The module each imported or propagated name was attributed to. */
  readonly nameModule: ReadonlyMap<string, string>;
}

interface Piece {
  readonly start: number;
  readonly end: number;
  readonly declares: readonly string[];
}

const isComment = (line: string): boolean => /^\s*(\/\*\*|\*|\*\/|\/\/)/.test(line);
const indentOf = (line: string): number => line.match(/^ */)?.[0].length ?? 0;

/** Every exported name under `<daemonRoot>/src/{lib,adapters}`, mapped to the repository path defining it. */
async function exportIndex(daemonRoot: string): Promise<Map<string, string>> {
  const definedIn = new Map<string, string>();
  const glob = new Bun.Glob('src/{lib,adapters}/**/*.ts');
  const exported =
    /export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for await (const file of glob.scan({ cwd: daemonRoot })) {
    if (file.endsWith('/index.ts')) continue;
    const source = await Bun.file(`${daemonRoot}/${file}`).text();
    for (const match of source.matchAll(exported)) {
      const name = match[1];
      if (name !== undefined && !definedIn.has(name)) definedIn.set(name, `packages/daemon/${file}`);
    }
  }
  return definedIn;
}

function importedModules(text: string, definedIn: ReadonlyMap<string, string>): Map<string, string> {
  const nameModule = new Map<string, string>();
  for (const match of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g)) {
    const from = match[2] ?? '';
    for (const raw of (match[1] ?? '').split(',')) {
      const spec = raw.trim().replace(/^type\s+/, '');
      if (spec === '') continue;
      const [original = '', alias] = spec.split(/\s+as\s+/);
      const local = (alias ?? original).trim();
      let module: string | undefined;
      if (from.startsWith('../src/')) {
        const direct = `packages/daemon/${from.slice(3)}`;
        const file = direct.endsWith('/index.ts') ? (definedIn.get(original.trim()) ?? direct) : direct;
        module = moduleOfPath(file);
      } else if (from.startsWith('@ferretry/relay')) module = 'reach';
      else if (from.startsWith('@ferretry/fleet')) module = 'fleet';
      if (module !== undefined && module !== 'kernel') nameModule.set(local, module);
    }
  }
  return nameModule;
}

function topLevelPieces(lines: readonly string[]): { pieces: Piece[]; importEnd: number } {
  const isTop = (line: string) => /^(export\s+)?(async\s+)?(function|const|let|class|interface|type)\s/.test(line);
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (isTop(line)) starts.push(index);
  });
  const importEnd = starts[0] ?? 0;
  const withComment = (index: number, floor: number) => {
    let start = index;
    while (start - 1 > floor && isComment(lines[start - 1] ?? '')) start--;
    return start;
  };
  const pieces: Piece[] = [];
  starts.forEach((declaration, k) => {
    const start = withComment(declaration, k === 0 ? importEnd - 1 : (starts[k - 1] ?? 0));
    const next = starts[k + 1];
    const end = (next === undefined ? lines.length : withComment(next, declaration)) - 1;
    const name = (lines[declaration] ?? '').match(
      /(?:function|const|let|class|interface|type)\s+([A-Za-z_$][\w$]*)/,
    )?.[1];
    pieces.push({ start, end, declares: name === undefined ? [] : [name] });
  });
  return { pieces, importEnd };
}

/** Cuts a piece longer than PIECE_LIMIT at the shallowest indent found inside it, recursively. */
function refine(piece: Piece, lines: readonly string[], depth: number, out: Piece[]): void {
  if (piece.end - piece.start + 1 <= PIECE_LIMIT || depth > 8) {
    out.push(piece);
    return;
  }
  const body: number[] = [];
  for (let index = piece.start + 1; index < piece.end; index++) {
    const line = lines[index] ?? '';
    if (line.trim() !== '' && !isComment(line)) body.push(index);
  }
  const outer = indentOf(lines[piece.start] ?? '');
  const inner = Math.min(...body.map(index => indentOf(lines[index] ?? '')).filter(indent => indent > outer));
  const cutsAt = body.filter(
    index => indentOf(lines[index] ?? '') === inner && /^\s*[A-Za-z_$'"[.]/.test(lines[index] ?? ''),
  );
  if (!Number.isFinite(inner) || cutsAt.length < 2) {
    out.push(piece);
    return;
  }
  const withComment = (index: number) => {
    let start = index;
    while (start - 1 > piece.start && isComment(lines[start - 1] ?? '')) start--;
    return start;
  };
  const cuts = [...new Set(cutsAt.map(withComment))].sort((a, b) => a - b);
  const first = cuts[0] ?? piece.start;
  const children: Piece[] =
    first > piece.start ? [{ start: piece.start, end: first - 1, declares: piece.declares }] : [];
  cuts.forEach((cut, k) => {
    const end = (cuts[k + 1] ?? piece.end + 1) - 1;
    const head = lines.slice(cut, end + 1).find(line => line.trim() !== '' && !isComment(line)) ?? '';
    const declared =
      head.match(/^\s*(?:const|let|function|async function)\s+([A-Za-z_$][\w$]*)/)?.[1] ??
      head.match(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*[:(,]/)?.[1];
    children.push({ start: cut, end, declares: declared === undefined ? [] : [declared] });
  });
  for (const child of children) refine(child, lines, depth + 1, out);
}

const NAME_HINTS: readonly (readonly [RegExp, string])[] = [
  [/warden/i, 'warden'],
  [/agenda|notification/i, 'agenda'],
  [/board/i, 'board'],
  [/pack/i, 'pack'],
  [/browser/i, 'browser'],
  [/terminal|tmux/i, 'terminal'],
  [/analytics/i, 'analytics'],
  [/learning/i, 'learning'],
  [/migrat|conversion/i, 'session-migrate'],
  [/handover/i, 'session-handover'],
  [/fork/i, 'session-fork'],
  [/resume|revive|relaunch/i, 'session-resume'],
  [/send|answer|signal|queue/i, 'session-messaging'],
  [/callsign|name/i, 'names'],
  [/relay|carrier|webrtc|tunnel/i, 'reach'],
  [/pairing/i, 'pairing'],
  [/secret|vault|login/i, 'secrets'],
  [/catalog|skill/i, 'catalogs'],
  [/mcp/i, 'mcp'],
  [/fleet|harness|account/i, 'fleet'],
];

export async function attribute(text: string, daemonRoot: string, sharedLimit = 6): Promise<Attribution> {
  const lines = text.split('\n');
  const nameModule = importedModules(text, await exportIndex(daemonRoot));
  const imported = new Set(nameModule.keys());
  const { pieces: top, importEnd } = topLevelPieces(lines);
  const pieces: Piece[] = [];
  for (const piece of top) refine(piece, lines, 0, pieces);
  const tokens = pieces.map(
    piece =>
      lines
        .slice(piece.start, piece.end + 1)
        .join('\n')
        .match(/[A-Za-z_$][\w$]*/g) ?? [],
  );
  const references = new Map<string, number>();
  for (const list of tokens) for (const token of new Set(list)) references.set(token, (references.get(token) ?? 0) + 1);
  const modules: string[] = pieces.map(() => 'kernel');
  for (let pass = 0; pass < 6; pass++) {
    pieces.forEach((piece, index) => {
      const tally = new Map<string, number>();
      for (const token of tokens[index] ?? []) {
        const module = nameModule.get(token);
        if (module !== undefined && !piece.declares.includes(token))
          tally.set(module, (tally.get(module) ?? 0) + 1 / (references.get(token) ?? 1));
      }
      let best: string | undefined;
      let weight = 0;
      for (const [module, score] of tally)
        if (score > weight) {
          best = module;
          weight = score;
        }
      if (best === undefined)
        for (const name of piece.declares) best ??= NAME_HINTS.find(([pattern]) => pattern.test(name))?.[1];
      const chosen = best ?? 'kernel';
      modules[index] = chosen;
      for (const name of piece.declares)
        if (chosen !== 'kernel' && !imported.has(name) && (references.get(name) ?? 0) <= sharedLimit)
          nameModule.set(name, chosen);
    });
  }
  const perLine: string[] = lines.map(() => 'kernel');
  for (let index = 0; index < importEnd; index++) perLine[index] = IMPORT_LINES;
  pieces.forEach((piece, index) => {
    for (let line = piece.start; line <= piece.end; line++) perLine[line] = modules[index] ?? 'kernel';
  });
  return { perLine, nameModule };
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const limitAt = argv.indexOf('--limit');
  const limit = limitAt === -1 ? 6 : Number(argv[limitAt + 1]);
  const path =
    argv.find((value, index) => !value.startsWith('--') && index !== limitAt + 1) ?? 'packages/daemon/bin/fyd.ts';
  const daemonRoot = path.replace(/\/bin\/fyd\.ts$/, '');
  const { perLine, nameModule } = await attribute(await Bun.file(path).text(), daemonRoot, limit);
  if (argv.includes('--json')) console.log(JSON.stringify({ perLine, nameModule: Object.fromEntries(nameModule) }));
  else {
    const counts = new Map<string, number>();
    for (const module of perLine) counts.set(module, (counts.get(module) ?? 0) + 1);
    for (const [module, count] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`${module}\t${count}`);
    console.log(`total\t${perLine.length}`);
  }
}
