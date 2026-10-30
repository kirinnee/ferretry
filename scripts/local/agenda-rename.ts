#!/usr/bin/env bun
// One-shot codemod: the "attention" feature is the "agenda" feature (Phase 3b).
//
//   bun scripts/local/agenda-rename.ts --dry-run [--report <file>]   print the plan, write nothing
//   bun scripts/local/agenda-rename.ts --apply   [--report <file>]   git mv + rewrite files
//
// Explicit tables, not a blind regex: every file is tokenised, and each token that holds
// "attention" is either RENAMED (identifier / path / CSS / prose) or KEPT for a named reason
// (wire and disk compatibility, English prose, history, ambiguity). A collision stops --apply.
// Idempotent: a second --apply changes nothing, and it runs on a branch that is already partly renamed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { API, SymbolFlags } from 'typescript/unstable/async';
import { SyntaxKind } from 'typescript/unstable/ast';

// ───────────────────────────── tables ─────────────────────────────

/** Files and trees the codemod never touches (history, the moved-page stub, generated or binary data). */
export const EXCLUDED_PATHS: readonly RegExp[] = [
  /^docs\/migration\//,
  /^docs\/design\//,
  /(^|\/)Changelog[^/]*$/i,
  /^docs\/attention\.md$/, // the "This page moved" stub stays so old links resolve
  /^scripts\/local\/agenda-rename\.ts$/,
  /^handover\.md$/, // the owner's backlog: edited by hand, never mechanically
  /(^|\/)bun\.lock$/,
  /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|zip|gz|wasm|pdf|node)$/i,
];

const TEXT_EXTENSIONS = /\.(ts|tsx|mts|cts|js|mjs|cjs|json|jsonc|css|md|yaml|yml|txt|sh|html|toml|nix)$/i;

/** Compound tokens that are English or a persisted/wire name: kept, whatever else matches. */
export const KEEP_TOKENS: readonly { re: RegExp; reason: string }[] = [
  { re: /^attentionNudge$/, reason: 'config key attentionNudge (fleet account schema, read on disk)' },
  { re: /^needs-attention$/, reason: "wait outcome kind: 'needs-attention' (CLI exit contract)" },
  { re: /^human-attention$/, reason: 'English prose' },
  { re: /^attention-(grabbing|seeking|span|deficit|getting|worthy)$/i, reason: 'English prose' },
  { re: /^in-?attention/i, reason: 'English prose' },
  {
    re: /^(?:[Ll]egacy[-_A-Z]|LEGACY_)/,
    reason: 'named legacy-spelling constant (kept so the old wire/disk name stays greppable)',
  },
  { re: /^attention-nudge-\$?$/, reason: 'send-id prefix attention-nudge- (send ledger reads old ids)' },
  { re: /^attention-\$?$/, reason: 'send-id / tag prefix attention- (send ledger, push tag)' },
];

/** Spans (matched against the file text) whose "attention" is a wire or disk name. First match wins. */
export const KEEP_SPANS: readonly { re: RegExp; reason: string }[] = [
  {
    re: /(?<=['"`])attention-(?:nudge-)?(?:session|s|x)-[\w~.-]*/g,
    reason: 'send-id / push-tag literal on the old prefix (the send ledger and older apps read it)',
  },
  {
    re: /\battention-(?:deadline|stopped):/g,
    reason: 'push eventKey prefix attention-deadline: / attention-stopped: (dedupes pushes in flight)',
  },
  {
    re: /\bdestination-attention\b/g,
    reason: "app-bar destination id 'attention' (palette entry id destination-<id>)",
  },
  { re: /[?&]attention=/g, reason: 'link parameter ?attention= (ATTENTION_LINK_PARAMETER value)' },
  {
    re: /\battention(?:-replies)?\.json(?:\.migrated)?/g,
    reason: 'on-disk file name attention.json / attention-replies.json',
  },
  { re: /\.attention-[^\s'"`]*\.tmp/g, reason: 'on-disk tmp name .attention-<id>.tmp' },
  { re: /\battention\.(?:changed|nudged|harness_answer_failed)\b/g, reason: 'journal alias attention.*' },
  { re: /['"`]attention:/g, reason: "notification key 'attention:'" },
  { re: /\battention:\$\{/g, reason: 'notification key attention:${…}' },
  { re: /\battention-replies:\$\{/g, reason: 'reply batch key attention-replies:${…}' },
  { re: /\bfy attention\b/g, reason: 'fy attention CLI alias' },
  { re: /!attention\b/g, reason: '!attention reference kind (wire spelling)' },
];

/** Whole sections of a file that document the old names and must read as they are. */
export const KEEP_REGIONS: readonly { file: string; start: RegExp; reason: string }[] = [
  {
    file: 'docs/agenda.md',
    start: /^## Compatibility\b/m,
    reason: 'docs/agenda.md § Compatibility documents the old spellings',
  },
  {
    file: 'docs/notifications.md',
    start: /^#+ .*[Mm]igration/m,
    reason: 'docs/notifications.md § Migration documents the old keys',
  },
];

/** English use: the word before makes it "attention" the noun, not the feature. */
const ENGLISH_PREV = new Set([
  'needs',
  'need',
  'needed',
  'require',
  'requires',
  'requiring',
  'your',
  'their',
  'human',
  'pay',
  'paid',
  'paying',
  'draw',
  'draws',
  'drawing',
  'grab',
  'grabs',
  'catch',
  'catches',
  'get',
  'gets',
  'getting',
  'its',
  'his',
  'her',
  'our',
  'my',
  'user',
  "user's",
  "owner's",
  'demand',
  'demands',
  'deserve',
  'deserves',
  'for',
  'full',
  'undivided',
  'little',
  'more',
  'less',
  'without',
  'no',
  'any',
  'call',
  'calls',
  'calling',
  'bring',
  'brings',
  'wants',
  'want',
  'wanting',
  'seek',
  'seeks',
]);
const ENGLISH_NEXT = new Set(['to', 'span', 'is', 'as', 'from', 'when', 'of', 'this', 'at', 'on', 'before', 'while']);
/** Domain nouns: "attention <noun>" names the feature. */
const DOMAIN_NOUNS = new Set([
  'item',
  'items',
  'card',
  'cards',
  'inbox',
  'board',
  'ledger',
  'outbox',
  'queue',
  'row',
  'rows',
  'reply',
  'replies',
  'record',
  'records',
  'nudge',
  'nudges',
  'mode',
  'model',
  'feature',
  'surface',
  'id',
  'ids',
  'kind',
  'kinds',
  'summary',
  'engine',
  'file',
  'files',
  'state',
  'page',
  'chip',
  'chips',
  'count',
  'counts',
  'route',
  'routes',
  'wire',
  'store',
  'brief',
  'delivery',
  'answer',
  'answers',
  'ask',
  'asks',
  'snapshot',
  'snapshots',
  'mutation',
  'mutations',
  'revision',
  'revisions',
  'controller',
  'service',
  'resurface',
  'list',
  'section',
  'sections',
  'view',
  'tab',
  'badge',
  'buzz',
  'push',
  'notification',
  'notifications',
  'dot',
  'deck',
  'detail',
  'panel',
  'config',
  'turn',
  'title',
  'reference',
  'references',
  'repository',
  'command',
  'commands',
  'actor',
  'decision',
  'request',
  'requests',
  'rule',
  'rules',
  'event',
  'events',
  'ledgers',
  'bar',
  'pill',
  'toast',
  'chat',
  'client',
  'api',
  'hook',
  'hooks',
  'module',
  'code',
  'type',
  'types',
  'schema',
  'handler',
  'sheet',
  'tray',
  'drawer',
  'sidebar',
  'link',
  'links',
  'surfaces',
  'feed',
  'stream',
  'subsystem',
  'domain',
  'layer',
  'port',
  'adapter',
  'format',
  'shape',
  'body',
  'text',
  'label',
  'flow',
  'flows',
  'step',
  'steps',
  'order',
]);

/** Explicit collision resolutions. key: `path:<old>` | `ident:<old>`; value: the chosen new path / name. */
export const PATH_OVERRIDES: Readonly<Record<string, string>> = {};
/** key `ident:<name>` (the tokenizer, everywhere) or `ident:<file>:<bare name>` (the checker pass: one file's local, never a path); value: the new name. */
export const IDENT_OVERRIDES: Readonly<Record<string, string>> = {
  // the legacy-spelling twin of a name the agenda already owns keeps its old spelling, marked as legacy
  'ident:attentionBoardPath': 'legacyAttentionBoardPath',
  'ident:attentionBatchMessage': 'legacyAttentionBatchMessage',
  'ident:DaemonAttentionConfigSchema': 'LegacyDaemonAttentionConfigSchema',
  'ident:ATTENTION_LINK_PARAMETER': 'LEGACY_ATTENTION_LINK_PARAMETER',
  'ident:WARDEN_ATTENTION_PATH': 'LEGACY_WARDEN_ATTENTION_PATH',
  'ident:packages/daemon/src/lib/attention/harness-prompt.ts:attention': 'legacyAttention',
  'ident:packages/cli/tests/unit/agenda-wire/released-daemon-404.test.ts:ATTENTION': 'LEGACY_ATTENTION',
  'ident:packages/pwa/src/lib/pages/session-chat-page.tsx:attention': 'agendaModel',
  'ident:packages/daemon/src/lib/runtime/config.ts:attention': 'legacyAttention',
};

/** Source edits made BEFORE tokenising, to free a name the rename needs. Each is skipped once its `when` no longer matches. */
export const PRE_RENAMES: readonly { file: string; when: RegExp; from: RegExp; to: string; why: string }[] = [
  {
    file: 'packages/pwa/src/components/agenda-message.tsx',
    when: /\bAttentionItem\b/,
    from: /\bAgendaItem\b/g,
    to: 'AgendaItemOrResolved',
    why: 'the local alias AgendaItem = AttentionItem | ResolvedAttentionItem would become self-referential',
  },
];
/** Collisions reviewed and accepted as an intentional merge (key as printed, value: why it is fine). */
export const ACCEPTED_COLLISIONS: Readonly<Record<string, string>> = {
  'ident:packages/pwa/src/components/agenda-message.tsx:AttentionItem':
    'freed by the PRE_RENAMES entry for this file (the old local AgendaItem alias becomes AgendaItemOrResolved)',
};

// ───────────────────────────── pure helpers ─────────────────────────────

const ATTENTION_ANY = /attention/gi;
const TOKEN = /[A-Za-z0-9_$-]*[Aa][Tt][Tt][Ee][Nn][Tt][Ii][Oo][Nn][A-Za-z0-9_$-]*/g;

const caseOf = (m: string): string => (m === m.toUpperCase() ? 'AGENDA' : m[0] === 'A' ? 'Agenda' : 'agenda');

/** attention→agenda keeping the case shape, collapsing an adjacent "agenda attention" / "attention agenda". */
export function renameToken(tok: string): string {
  const collapsed = tok
    .replace(/(attention)([-_]?)(agenda)/gi, (_m, a: string) => caseOf(a))
    .replace(/(agenda)([-_]?)(attention)/gi, (_m, a: string) => a);
  return collapsed.replace(ATTENTION_ANY, caseOf);
}

export function renamePath(path: string): string {
  const override = PATH_OVERRIDES[`path:${path}`];
  if (override) return override;
  return path
    .split('/')
    .map(segment => renameToken(segment))
    .join('/');
}

export const isExcluded = (path: string): boolean => EXCLUDED_PATHS.some(re => re.test(path));

const slug = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .trim()
    .replace(/ /g, '-');

export function markdownAnchors(md: string): Set<string> {
  const out = new Set<string>();
  for (const line of md.split('\n')) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (m) out.add(slug(m[1]!.replace(/`/g, '')));
  }
  return out;
}

// ───────────────────────────── decisions ─────────────────────────────

type Decision = { rename: string } | { keep: string };

interface FileCtx {
  path: string;
  text: string;
  isDoc: boolean;
  codeFile: boolean;
  skip: ReadonlySet<number>;
  spans: { start: number; end: number; reason: string }[];
  agendaAnchors: Set<string>;
}

const REPO_PATH_MARKER = /(^|\/)(packages|tests|docs|scripts|src|bin|features|adapters|lib|config|harness|\.\.?)(\/|$)/;
// a module specifier, not any string on a line that starts with export (`export const PATH = '/v1/x/attention'` is a route)
const IMPORT_LINE = /\bfrom\s*['"`]|(^|\s)import\s*['"`]|\b(import|require|mock\.module|vi\.mock|jest\.mock)\s*\(/;

function lineAround(text: string, at: number): { line: string; col: number; start: number } {
  const start = text.lastIndexOf('\n', at - 1) + 1;
  let end = text.indexOf('\n', at);
  if (end < 0) end = text.length;
  return { line: text.slice(start, end), col: at - start, start };
}

function isCommentLine(line: string, col: number): boolean {
  const trimmed = line.trimStart();
  if (/^(\/\/|\/\*|\*|#|<!--)/.test(trimmed)) return true;
  const slash = line.indexOf('//');
  return slash >= 0 && slash < col && !/['"`][^'"`]*\/\/[^'"`]*['"`]/.test(line.slice(0, col));
}

function wordAfter(text: string, end: number): string {
  const m = /^[ \t]*(?:\r?\n[ \t]*(?:\/\/|\*|#)?[ \t]*)?[`'"*_]*([A-Za-z][A-Za-z'-]*)/.exec(text.slice(end, end + 120));
  return m ? m[1]!.toLowerCase() : '';
}
function wordBefore(text: string, start: number): string {
  const m = /([A-Za-z][A-Za-z'-]*)[`'"*_]*[ \t]+$/.exec(text.slice(Math.max(0, start - 60), start));
  return m ? m[1]!.toLowerCase() : '';
}

/** The maximal path-like run around a token ("../lib/attention/x.ts#y"). */
function pathRun(text: string, s: number, e: number): { run: string; from: number } {
  const ok = /[A-Za-z0-9_$@./:#{}*~-]/;
  let a = s;
  let b = e;
  while (a > 0 && ok.test(text[a - 1]!)) a--;
  while (b < text.length && ok.test(text[b]!)) b++;
  // JSX: "</Name" closes a tag and "Name/>" self-closes one; neither slash is a path separator
  if (text[a] === '/' && text[a - 1] === '<') a++;
  if (text[b - 1] === '/' && text[b] === '>') b--;
  return { run: text.slice(a, b), from: a };
}

export function decide(ctx: FileCtx, s: number, e: number): Decision {
  const { text } = ctx;
  const tok = text.slice(s, e);
  for (const sp of ctx.spans) if (s < sp.end && e > sp.start) return { keep: sp.reason };
  for (const k of KEEP_TOKENS) if (k.re.test(tok)) return { keep: k.reason };

  const { line, col } = lineAround(text, s);
  const bare = /^attention$/i.test(tok);
  const before = text[s - 1] ?? '';
  const after = text[e] ?? '';

  // path-like context: import specifiers, repo paths, doc links, routes
  const { run } = pathRun(text, s, e);
  if (run.includes('/') || /\battention\.md\b/.test(run)) {
    const anchor = /#([A-Za-z0-9_-]+)$/.exec(run)?.[1];
    if (/attention\.md/.test(run) && anchor && !ctx.agendaAnchors.has(anchor)) {
      return { keep: `doc link anchor #${anchor} is not a heading of docs/agenda.md` };
    }
    const importish = IMPORT_LINE.test(line);
    if (importish || REPO_PATH_MARKER.test(run.replace(/^[^A-Za-z.]+/, '')) || /attention\.md/.test(run)) {
      return { rename: renameToken(tok) };
    }
    return { keep: 'route / URL path segment (wire and PWA route)' };
  }

  if (!bare) return { rename: renameToken(tok) };

  // bare word: prose, quoted literal, or a bare identifier
  if (/['"`]/.test(before) && before === after)
    return { keep: `quoted literal ${before}attention${after} (wire, persisted or ambiguous value)` };
  if (before === '.' && !text.slice(0, s).endsWith('..'))
    return { keep: 'bare property access .attention (field name on the wire)' };
  if (
    !ctx.isDoc &&
    !isCommentLine(line, col) &&
    ctx.codeFile &&
    !/[ \t]/.test(before + after) &&
    !/['"`]/.test(before + after)
  ) {
    return { keep: 'bare attention in non-code context (CSS / JSON / config key)' };
  }
  const prev = wordBefore(text, s);
  const next = wordAfter(text, e);
  if (ENGLISH_PREV.has(prev) || ENGLISH_NEXT.has(next)) return { keep: 'English prose (the noun "attention")' };
  if (
    DOMAIN_NOUNS.has(next) &&
    (before === ' ' ||
      before === '\t' ||
      before === '' ||
      before === '\n' ||
      before === '(' ||
      before === '*' ||
      (/['"`]/.test(before) && /\s/.test(after)))
  ) {
    return { rename: renameToken(tok) };
  }
  return { keep: `ambiguous bare word (next: "${next || '·'}", prev: "${prev || '·'}")` };
}

// ───────────────────────────── scan ─────────────────────────────

interface Hit {
  file: string;
  line: number;
  from: string;
  to: string;
}
interface KeepHit {
  file: string;
  line: number;
  reason: string;
  token: string;
  context: string;
}
interface FileResult {
  oldPath: string;
  newPath: string;
  newText: string;
  changed: boolean;
}

function makeCtx(path: string, text: string, agendaAnchors: Set<string>, skip: ReadonlySet<number>): FileCtx {
  const spans: FileCtx['spans'] = [];
  for (const k of KEEP_SPANS) {
    k.re.lastIndex = 0;
    for (const m of text.matchAll(k.re)) spans.push({ start: m.index!, end: m.index! + m[0].length, reason: k.reason });
  }
  for (const r of KEEP_REGIONS) {
    if (r.file !== path) continue;
    const m = r.start.exec(text);
    if (!m) continue;
    const level = /^#+/.exec(m[0])![0].length;
    const rest = text.slice(m.index + m[0].length);
    const next = new RegExp(`^#{1,${level}} `, 'm').exec(rest);
    const endAt = next ? m.index + m[0].length + next.index : text.length;
    // a region ends at the next heading of the same or higher level
    spans.push({ start: m.index, end: endAt, reason: r.reason });
  }
  return {
    path,
    text,
    isDoc: /\.(md|txt)$/.test(path),
    codeFile: !/\.(md|txt)$/.test(path),
    spans,
    skip,
    agendaAnchors,
  };
}

export interface Edit {
  start: number;
  end: number;
  text: string;
}

export function applyEdits(text: string, edits: readonly Edit[]): string {
  let out = '';
  let last = 0;
  for (const e of [...edits].sort((a, b) => a.start - b.start)) {
    out += text.slice(last, e.start) + e.text;
    last = e.end;
  }
  return out + text.slice(last);
}

export function transformFile(
  path: string,
  text: string,
  agendaAnchors: Set<string>,
  skip: ReadonlySet<number> = new Set(),
): { edits: Edit[]; hits: Hit[]; keeps: KeepHit[] } {
  const ctx = makeCtx(path, text, agendaAnchors, skip);
  const hits: Hit[] = [];
  const keeps: KeepHit[] = [];
  const edits: Edit[] = [];
  let lineNo = 1;
  let lineAt = 0;
  for (const m of text.matchAll(TOKEN)) {
    // `\nattentionNudge` inside a string: the `n` is the escape, not part of the name
    const lead = text[m.index! - 1] === '\\' && /^[nrtbfv]attention/i.test(m[0]) ? 1 : 0;
    const tok = m[0].slice(lead);
    const s = m.index! + lead;
    const e = s + tok.length;
    while (true) {
      const nl = text.indexOf('\n', lineAt);
      if (nl >= 0 && nl < s) {
        lineNo++;
        lineAt = nl + 1;
      } else break;
    }
    if (skip.has(s) && /^attention$/i.test(tok)) continue;
    const d = decide(ctx, s, e);
    if ('rename' in d) {
      const to = IDENT_OVERRIDES[`ident:${tok}`] ?? d.rename;
      hits.push({ file: path, line: lineNo, from: tok, to });
      edits.push({ start: s, end: e, text: to });
    } else {
      const { line } = lineAround(text, s);
      keeps.push({ file: path, line: lineNo, reason: d.keep, token: tok, context: line.trim().slice(0, 140) });
    }
  }
  return { edits, hits, keeps };
}

// ───────────────────────────── collisions ─────────────────────────────

const DECL =
  /\b(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|function\*?|class|type|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_DECL =
  /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|function\*?|class|type|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/g;
const IMPORT_BRACES = /\bimport\s*(?:type\s*)?\{([^}]*)\}/g;

const names = (re: RegExp, text: string): Set<string> => new Set([...text.matchAll(re)].map(m => m[1]!));
function importedNames(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(IMPORT_BRACES)) {
    for (const part of m[1]!.split(',')) {
      const p = part.trim().replace(/^type\s+/, '');
      if (!p) continue;
      const as = /\bas\s+([\w$]+)$/.exec(p);
      out.add(as ? as[1]! : p);
    }
  }
  return out;
}
const pkgOf = (path: string): string => /^(packages\/[^/]+|tests\/[^/]+|scripts)/.exec(path)?.[1] ?? '·';

// ───────────────────────────── main ─────────────────────────────

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
}

export interface Plan {
  moves: { from: string; to: string }[];
  results: FileResult[];
  hits: Hit[];
  keeps: KeepHit[];
  collisions: string[];
  resolved: string[];
}

const lineOf = (text: string, at: number): number => {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < at; i = text.indexOf('\n', i + 1)) n++;
  return n;
};

/** Declarations whose every reference is renamed together (locals, parameters, imports, class members). */
const RENAMED_DECLARATION_KINDS = new Set<number>([
  SyntaxKind.VariableDeclaration,
  SyntaxKind.Parameter,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.ImportSpecifier,
  SyntaxKind.NamespaceImport,
  SyntaxKind.ImportClause,
  SyntaxKind.BindingElement,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.ClassDeclaration,
]);

interface CheckerResult {
  skip: Map<string, Set<number>>;
  edits: Map<string, Edit[]>;
  hits: Hit[];
  keeps: KeepHit[];
  collisions: { key: string; message: string }[];
}

/** The declaring name of a class member (or parameter property) whose owner implements/extends something, or of an object-literal member. */
function isTypedMember(node: any): boolean {
  const parent = node.parent;
  if (!parent || parent.name !== node) return false;
  let owner: any;
  if (
    parent.kind === SyntaxKind.MethodDeclaration ||
    parent.kind === SyntaxKind.PropertyDeclaration ||
    parent.kind === SyntaxKind.GetAccessor ||
    parent.kind === SyntaxKind.SetAccessor
  )
    owner = parent.parent;
  else if (
    parent.kind === SyntaxKind.Parameter &&
    parent.parent?.kind === SyntaxKind.Constructor &&
    parent.modifiers?.length
  )
    owner = parent.parent.parent;
  else return false;
  if (owner?.kind === SyntaxKind.ObjectLiteralExpression) return true;
  return Boolean(owner?.heritageClauses?.length);
}

/** Bare lowercase `attention` identifiers are decided by what they RESOLVE to, never by their spelling. */
async function checkerPass(root: string, files: Map<string, string>): Promise<CheckerResult> {
  const result: CheckerResult = { skip: new Map(), edits: new Map(), hits: [], keeps: [], collisions: [] };
  const configs = [
    join(root, 'tsconfig.json'),
    join(root, 'packages/pwa/tsconfig.json'),
    join(root, 'tests/e2e/tsconfig.json'),
  ].filter(existsSync);
  const api = new API({ cwd: root });
  try {
    const snap = await api.updateSnapshot({ openProjects: configs } as never);
    const projects = snap.getProjects();
    const pick = (path: string): (typeof projects)[number][] => {
      const want = path.startsWith('packages/pwa/')
        ? 'packages/pwa/tsconfig.json'
        : path.startsWith('tests/e2e/')
          ? 'tests/e2e/tsconfig.json'
          : 'tsconfig.json';
      return [...projects].sort(
        (a, b) => Number(b.configFileName.endsWith(want)) - Number(a.configFileName.endsWith(want)),
      );
    };
    type Occurrence = {
      file: string;
      start: number;
      end: number;
      node: any;
      project: any;
      symKey: string;
      kind: number;
      declFile: string;
      typedMember: boolean;
    };
    const occurrences: Occurrence[] = [];
    for (const [path, text] of files) {
      if (!/\.(tsx?|mts|cts)$/.test(path) || !/\battention\b/i.test(text)) continue;
      let located: { sf: any; project: any } | undefined;
      for (const project of pick(path)) {
        const sf: any = await project.program.getSourceFile(join(root, path));
        if (sf) {
          located = { sf, project };
          break;
        }
      }
      if (!located) {
        for (const m of text.matchAll(/\battention\b/gi))
          result.keeps.push({
            file: path,
            line: lineOf(text, m.index!),
            reason: 'file is in no tsconfig project (not checked)',
            token: m[0],
            context: '',
          });
        continue;
      }
      const nodes: any[] = [];
      const walk = (node: any): void => {
        if (node.kind === SyntaxKind.Identifier && /^attention$/i.test(node.text)) nodes.push(node);
        node.forEachChild(walk);
      };
      walk(located.sf);
      if (!nodes.length) continue;
      const skip = new Set<number>();
      const positions = nodes.map(n => n.end - n.text.length);
      for (const p of positions) skip.add(p);
      result.skip.set(path, skip);
      const symbols = await located.project.checker.getSymbolAtPosition(join(root, path), positions);
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        let sym = symbols[i];
        if (node.parent?.kind === SyntaxKind.ShorthandPropertyAssignment)
          sym = (await located.project.checker.getShorthandAssignmentValueSymbol(node.parent)) ?? sym;
        const decl = sym?.declarations?.[0];
        occurrences.push({
          file: path,
          start: positions[i]!,
          end: node.end,
          node,
          project: located.project,
          symKey: decl ? `${decl.path}#${decl.index}` : `unresolved:${path}:${positions[i]}`,
          kind: decl?.kind ?? -1,
          declFile: decl ? String(decl.path) : '',
          typedMember: isTypedMember(node),
        });
      }
    }
    // a parameter property (constructor(private readonly attention)) is a class member, a plain parameter is a local
    // a member that implements an interface or fills an object literal is shaped by that type, so it keeps its name
    const typedGroups = new Set(occurrences.filter(o => o.typedMember).map(o => o.symKey));
    const renamedGroups = new Map<string, boolean>();
    for (const o of occurrences) {
      if (renamedGroups.has(o.symKey)) continue;
      let rename = RENAMED_DECLARATION_KINDS.has(o.kind);
      if (o.kind === SyntaxKind.BindingElement || o.kind === SyntaxKind.Parameter) rename = true;
      if (typedGroups.has(o.symKey)) rename = false;
      renamedGroups.set(o.symKey, rename);
    }
    const typedGroupsHas = (key: string): boolean => typedGroups.has(key);
    const reasonFor = (o: Occurrence): string =>
      o.kind === -1
        ? 'bare identifier attention that resolves to nothing (any/unknown receiver)'
        : typedGroupsHas(o.symKey)
          ? 'bare identifier attention: a member shaped by an interface or an object literal (kept, the interface name is a field)'
          : `bare identifier attention declared as ${SyntaxKind[o.kind]} (a field: wire, config, persisted or test shape — kept)`;
    const checked = new Map<string, boolean>();
    for (const o of occurrences) {
      const text = files.get(o.file)!;
      const line = lineOf(text, o.start);
      if (!renamedGroups.get(o.symKey)) {
        result.keeps.push({
          file: o.file,
          line,
          reason: reasonFor(o),
          token: o.node.text,
          context: `${lineAround(text, o.start).line.trim().slice(0, 100)}   ← ${o.declFile.replace(root + '/', '')}`,
        });
        continue;
      }
      const word: string = o.node.text;
      const target = IDENT_OVERRIDES[`ident:${o.file}:${word}`] ?? caseOf(word);
      const key = `ident:${o.file}:${word}`;
      // checked at EVERY occurrence: a body-scope declaration is invisible from the parameter list but not from its uses
      {
        const clash = await o.project.checker.resolveName(
          target,
          SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace,
          { document: join(root, o.file), position: o.start },
          false,
        );
        if (clash) {
          const d = clash.declarations?.[0];
          if ((!d || `${d.path}#${d.index}` !== o.symKey) && !checked.has(key)) {
            checked.set(key, true);
            result.collisions.push({
              key,
              message: `${o.file}:${line}: local ${word} -> ${target}, but ${target} already resolves here (${d ? String(d.path).replace(root + '/', '') : 'global'})`,
            });
          }
        }
      }
      const parentKind = o.node.parent?.kind;
      const shorthand =
        parentKind === SyntaxKind.ShorthandPropertyAssignment ||
        (parentKind === SyntaxKind.BindingElement && !o.node.parent.propertyName && o.node.parent.name === o.node);
      const replacement = shorthand ? `${word}: ${target}` : target;
      if (!result.edits.has(o.file)) result.edits.set(o.file, []);
      result.edits.get(o.file)!.push({ start: o.start, end: o.end, text: replacement });
      result.hits.push({ file: o.file, line, from: word, to: replacement });
    }
  } finally {
    await api.close();
  }
  return result;
}

export async function buildPlan(root: string): Promise<Plan> {
  const tracked = git(root, 'ls-files', '-z').split('\0').filter(Boolean);
  const agendaMd = existsSync(join(root, 'docs/agenda.md')) ? readFileSync(join(root, 'docs/agenda.md'), 'utf8') : '';
  const anchors = markdownAnchors(agendaMd);
  const trackedSet = new Set(tracked);

  const collisions: string[] = [];
  const resolved: string[] = [];
  const flag = (key: string, message: string): void => {
    const why = ACCEPTED_COLLISIONS[key];
    if (why) resolved.push(`${message}  [accepted: ${why}]`);
    else collisions.push(`${message}  [key: ${key}]`);
  };

  // path moves
  const moves: { from: string; to: string }[] = [];
  const targets = new Map<string, string>();
  for (const p of tracked) {
    if (isExcluded(p) || !/attention/i.test(p)) continue;
    const to = renamePath(p);
    if (to === p) continue;
    moves.push({ from: p, to });
    const other = targets.get(to);
    if (other) flag(`path:${p}`, `two files map to ${to}: ${other} and ${p}`);
    targets.set(to, p);
    if (trackedSet.has(to) && !moves.some(m => m.from === to))
      flag(`path:${p}`, `file target already exists: ${p} -> ${to}`);
  }
  if (PATH_OVERRIDES)
    for (const [k, v] of Object.entries(PATH_OVERRIDES)) resolved.push(`path override ${k.slice(5)} -> ${v}`);

  // contents
  const results: FileResult[] = [];
  const hits: Hit[] = [];
  const keeps: KeepHit[] = [];
  const originals = new Map<string, string>();
  for (const p of tracked) {
    if (isExcluded(p) || !TEXT_EXTENSIONS.test(p)) continue;
    const text = readFileSync(join(root, p), 'utf8');
    if (!/attention/i.test(text) && !/attention/i.test(p)) continue;
    originals.set(p, text);
  }
  const checker = await checkerPass(root, originals);
  for (const c of checker.collisions) flag(c.key, c.message);
  hits.push(...checker.hits);
  keeps.push(...checker.keeps);
  for (const [p, text] of originals) {
    const t = /attention/i.test(text)
      ? transformFile(p, text, anchors, checker.skip.get(p))
      : { edits: [], hits: [], keeps: [] };
    hits.push(...t.hits);
    keeps.push(...t.keeps);
    const pre: Edit[] = [];
    for (const r of PRE_RENAMES) {
      if (r.file !== p || !r.when.test(text)) continue;
      for (const m of text.matchAll(r.from)) pre.push({ start: m.index!, end: m.index! + m[0].length, text: r.to });
      resolved.push(`pre-rename ${p}: ${r.from} -> ${r.to} (${r.why})`);
    }
    const newText = applyEdits(text, [...t.edits, ...pre, ...(checker.edits.get(p) ?? [])]);
    const np = renamePath(p);
    results.push({ oldPath: p, newPath: np, newText, changed: newText !== text || np !== p });
  }

  // identifier collisions: the new name already declared / imported beside the old, or exported by another module
  const byFile = new Map<string, Set<string>>();
  for (const h of hits) {
    if (!/^[A-Za-z_$][\w$]*$/.test(h.from) || h.from.toLowerCase() === 'attention' || !/\.(tsx?|mts|cts)$/.test(h.file))
      continue;
    if (!byFile.has(h.file)) byFile.set(h.file, new Set());
    byFile.get(h.file)!.add(`${h.from}\0${h.to}`);
  }
  const exportsIndex = new Map<string, Map<string, string>>(); // pkg -> name -> first file
  for (const p of tracked) {
    if (!/\.(tsx?|mts|cts)$/.test(p) || isExcluded(p)) continue;
    const text = originals.get(p) ?? readFileSync(join(root, p), 'utf8');
    const pkg = pkgOf(p);
    if (!exportsIndex.has(pkg)) exportsIndex.set(pkg, new Map());
    for (const n of names(EXPORT_DECL, text)) if (!exportsIndex.get(pkg)!.has(n)) exportsIndex.get(pkg)!.set(n, p);
  }
  const seenKeys = new Set<string>();
  for (const [file, pairs] of byFile) {
    const text = originals.get(file)!;
    const declared = names(DECL, text);
    const imported = importedNames(text);
    const present = new Set([...declared, ...imported]);
    for (const pair of pairs) {
      const [from, to] = pair.split('\0') as [string, string];
      if (from === to) continue;
      if (present.has(to)) {
        const key = `ident:${file}:${from}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          flag(
            key,
            `${file}: ${from} -> ${to}, but ${to} is already ${declared.has(to) ? 'declared' : 'imported'} there`,
          );
        }
      }
      const fromFile = exportsIndex.get(pkgOf(file))?.get(from);
      const toFile = exportsIndex.get(pkgOf(file))?.get(to);
      if (fromFile && toFile && fromFile !== toFile) {
        const key = `ident:${from}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          flag(key, `export clash in ${pkgOf(file)}: ${from} (${fromFile}) -> ${to}, already exported by ${toFile}`);
        }
      }
    }
  }
  // moved-file clash with a module that stays: a renamed export colliding is caught above; a path one is caught in moves.

  return { moves, results, hits, keeps, collisions, resolved };
}

function group<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of items) {
    const k = key(i);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(i);
  }
  return m;
}

export function report(plan: Plan, full: boolean): string {
  const out: string[] = [];
  const total = (n: number): string => n.toLocaleString('en');
  out.push(
    `PLAN  moves=${plan.moves.length}  files-rewritten=${plan.results.filter(r => r.newText !== readOriginal(r)).length}  token-renames=${total(plan.hits.length)}  kept=${total(plan.keeps.length)}  collisions=${plan.collisions.length}`,
  );
  out.push('', `== COLLISIONS (${plan.collisions.length}) — apply is refused until each has a table entry ==`);
  for (const c of plan.collisions) out.push(`  ! ${c}`);
  if (plan.resolved.length)
    out.push('', `== RESOLVED COLLISIONS (${plan.resolved.length}) ==`, ...plan.resolved.map(r => `  ✓ ${r}`));
  out.push('', `== PATH MOVES (${plan.moves.length}) ==`);
  for (const m of plan.moves) out.push(`  git mv ${m.from} -> ${m.to}`);
  const renames = group(plan.hits, h => `${h.from} -> ${h.to}`);
  out.push('', `== TOKEN RENAMES (${renames.size} distinct, ${plan.hits.length} total) ==`);
  const sorted = [...renames].sort((a, b) => b[1].length - a[1].length);
  for (const [k, v] of full ? sorted : sorted.slice(0, 40)) out.push(`  ${String(v.length).padStart(5)}  ${k}`);
  if (!full && sorted.length > 40) out.push(`  … ${sorted.length - 40} more (use --report <file>)`);
  const keepGroups = group(plan.keeps, k => k.reason.replace(/\(next: .*$/, '(…)'));
  out.push('', `== KEEP HITS by reason (${plan.keeps.length}) ==`);
  for (const [reason, v] of [...keepGroups].sort((a, b) => b[1].length - a[1].length)) {
    out.push(`  ${String(v.length).padStart(5)}  ${reason}  [${new Set(v.map(x => x.file)).size} files]`);
    if (full) for (const k of v) out.push(`           ${k.file}:${k.line}  ${k.token}   ${k.context}`);
  }
  return out.join('\n');
}

let originalCache: Map<string, string> | undefined;
function readOriginal(r: FileResult): string {
  return originalCache?.get(r.oldPath) ?? '';
}

function apply(root: string, plan: Plan): void {
  if (plan.collisions.length) {
    console.error(
      `REFUSED: ${plan.collisions.length} collision(s). Add a PATH_OVERRIDES / IDENT_OVERRIDES / ACCEPTED_COLLISIONS entry for each.`,
    );
    process.exit(2);
  }
  for (const m of plan.moves) {
    mkdirSync(dirname(join(root, m.to)), { recursive: true });
    git(root, 'mv', '--', m.from, m.to);
  }
  for (const r of plan.results) {
    if (r.newText === originalCache!.get(r.oldPath)) continue;
    writeFileSync(join(root, r.newPath), r.newText);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const mode = args.includes('--apply') ? 'apply' : args.includes('--dry-run') ? 'dry-run' : '';
  if (!mode) {
    console.error('usage: bun scripts/local/agenda-rename.ts --dry-run|--apply [--report <file>] [--root <dir>]');
    process.exit(64);
  }
  const arg = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const root = arg('--root') ?? git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
  const started = performance.now();
  const plan = await buildPlan(root);
  originalCache = new Map(plan.results.map(r => [r.oldPath, readFileSync(join(root, r.oldPath), 'utf8')]));
  const reportFile = arg('--report');
  if (reportFile) writeFileSync(reportFile, report(plan, true) + '\n');
  console.log(report(plan, false));
  if (mode === 'apply') {
    apply(root, plan);
    console.log(
      `\nAPPLIED in ${((performance.now() - started) / 1000).toFixed(1)}s. Next: format the changed files, then typecheck.`,
    );
  } else {
    console.log(`\n(dry-run: nothing written; planned in ${((performance.now() - started) / 1000).toFixed(1)}s)`);
  }
}
