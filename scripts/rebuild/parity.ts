#!/usr/bin/env bun
/**
 * Inventory the 4.x reference, never a running daemon or a person's FY_HOME.
 *
 * bun scripts/rebuild/parity.ts --source ../rebuild-ref
 * bun scripts/rebuild/parity.ts --source ../rebuild-ref --check
 *
 * Source is parsed, not imported. In particular the Commander walker interprets only syntax and
 * records command builders; action handlers, constructors and host APIs are never executed.
 * Keep the previous TSV: it is the ID/status registry. Existing rows retain both across regeneration.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

type Kind = 'R' | 'V' | 'T' | 'S' | 'J' | 'F';
interface Row {
  id: string;
  kind: Kind;
  what: string;
  source: string;
  todayOwner: string;
  owner: string;
  name5: string;
  descriptor: string;
  check: string;
  status: string;
}
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : (args[index + 1] ?? fallback);
};
const root = resolve(import.meta.dir, '../..');
const sourceRoot = resolve(option('--source', join(root, '../rebuild-ref')));
if (sourceRoot === root) throw new Error('--source must be the read-only 4.x reference, not this branch');
const outputDirectory = resolve(option('--out-dir', join(root, 'docs/design')));
const markdownPath = join(outputDirectory, 'rebuild-parity.md');
const tsvPath = join(outputDirectory, 'rebuild-parity.tsv');
const sourceHead = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const files = execFileSync('git', ['-C', sourceRoot, 'ls-files', 'packages'], { encoding: 'utf8' })
  .split('\n')
  .filter(file => /\.[cm]?tsx?$/.test(file) && !/(\/tests?\/|\.test\.|\.spec\.|\.d\.ts$|\/vendor\/)/.test(file))
  .sort();
const digest = createHash('sha256');
const rows: Row[] = [];
const warnings = new Set<string>();
const kindNames: Record<Kind, string> = {
  R: 'HTTP and socket endpoints',
  V: 'fy commands (aliases are separate rows)',
  T: 'MCP and agent tools',
  S: 'App routes, features, panels, settings and sheets',
  J: 'Daemon job, timer and watcher sites',
  F: 'Stored file/path declarations',
};
const owners = [
  'kernel',
  'gate',
  'vault',
  'ferrets',
  'asks',
  'access',
  'connections',
  'updates',
  'terminals',
  'browsers',
  'claude-code',
  'codex',
  'logins',
  'runtimes',
  'accounts',
  'conversation',
  'agenda',
  'projects',
  'board',
  'packs',
  'warden',
  'usage',
  'lessons',
  'voice',
  'catalogs',
  'mcp',
  'skills',
  'shells',
  'layouts',
  'onboarding',
  'tidy',
  'cli',
  'app',
];
const core = new Set(['kernel', 'gate', 'vault', 'ferrets', 'asks']);
const packagePath = (owner: string) =>
  owner === 'app' || owner === 'cli'
    ? `packages/${owner}`
    : `packages/${core.has(owner) ? 'core' : 'plugins'}/${owner}`;
const compact = (value: string) => value.replace(/\s+/g, ' ').trim();
const stripLine = (source: string) => source.replace(/:\d+$/, '');
const rowKey = (row: Pick<Row, 'kind' | 'what' | 'source'>) => `${row.kind}\t${row.what}\t${stripLine(row.source)}`;
const moduleName = (file: string) =>
  file.match(/\/runtime\/mounts\/([^/.]+)/)?.[1] ??
  file.match(/\/(?:lib|adapters|modules|features)\/([^/]+)/)?.[1]?.replace(/\.tsx?$/, '') ??
  'host';

/** Ordered source/semantic ownership rules, transcribed from redesign §8 and split responsibilities in §2.3. */
function ownerOf(file: string, what = ''): string {
  const text = `${what} ${file}`.toLowerCase();
  const semantic = what
    .toLowerCase()
    .replace(/^(?:component|feature|screen|route|settings\/navigation|timer\/watcher|job\/lifecycle arm) /, '')
    .replace(/<[^>]+>|\[[^\]]+\]/g, '');
  const source = file.replace('/runtime/mounts/', '/mounts/');
  const rules: [RegExp, string][] = [
    [
      /account[._-](hint|propose)|sign-in|signin-rule|copy-plan|secure[_-](copy|paste|discard)|task_plan|task-plans|\/accounts(?:\/|\b)|\/secrets\/account/,
      'accounts',
    ],
    [/terminal[_.:/ -]|\/terminals|console\/input|tmux|cgroups|processes/, 'terminals'],
    [/browser[_.:/ -]|\/browsers|firewall/, 'browsers'],
    [
      /input[_.-](wait|cancel)|request[_-]input|input-requests|quarantine|\/secret(?:s|\b)|secret[_ -](set|list|rm)|secrets\.(json|key)|redactor/,
      'vault',
    ],
    [/task[_. -]|\/board|board-|merge-gate|workflow|lane[-/ ]|tasks\.json/, 'board'],
    [
      /\/v1\/shared\/|\/catalog|catalog[_ -]|shared-catalog|catalog-members|catalog-links|catalog-install|catalog-share/,
      'catalogs',
    ],
    [/\bmcp\b|mcp[_-]/, 'mcp'],
    [/lesson|learning/, 'lessons'],
    [/warden|\bmonitor\b/, 'warden'],
    [/(?:^|[\/ ._-])packs?(?:[\/ ._-]|$)|subtree|sub-ferret|jev-spend|clean-up-guide/, 'packs'],
    [/onboard|setup-journey|machine-setup/, 'onboarding'],
    [/pricing|quota|usage|analytics|budget|performance|compaction-history/, 'usage'],
    [/stt|voice|dictation|speech|transcription-log|speedup/, 'voice'],
    [
      /passkey|pairing|\bfy pair|\bfy device|\bfy grant|\/devices|\/grants|step-up|unlock|(?:^|\/)push(?:\/|\.)|push-subscription|push-keys/,
      'access',
    ],
    [/tunnel|webrtc|carrier|\/relay|connection-preference|connection-drops/, 'connections'],
    [/update|whats-new|release-notice/, 'updates'],
    [/credential|fleet-login|provider-probe|local-model|models[./ -]|\/logins|codex-login|claude-login/, 'logins'],
    [/instruction/, 'ferrets'],
    [/runtimes?|profiles?|presets?|components?|fleet-catalog|\/fleet|routing/, 'runtimes'],
    [/project/, 'projects'],
    [/agenda|attention|notification|\bfy notify|buzz/, 'agenda'],
    [/audit|security|api-token|warden-token|capabilit|socket-ticket|\/api\//, 'gate'],
    [/skill/, 'skills'],
    [/shells\//, 'shells'],
    [/housekeeping|\btidy\b|scratch/, 'tidy'],
    [
      /transcript|attachments?|renders?|shared-draft|work-search|search_work|message|queue|turns|question|\/imports|imported-history|\bfy import|\bfy link|\bfy send|\bfy answer|\bfy history|\bfy render/,
      'conversation',
    ],
  ];
  // Distinguish the two harness halves before their shared source-directory fallback.
  if (/\/v1\/health|\/healthz|\/v1\/config\/|^fy config\b/.test(semantic)) return 'kernel';
  if (/^(?:ws )?get \/v1\/events\b/.test(semantic)) return 'kernel';
  if (/\/fleet\/login(?:\/|\b)|\/fleet\/presets/.test(semantic)) return 'logins';
  if (/\/fleet\/setup/.test(semantic)) return 'onboarding';
  if (/\/diagnostics\/profile/.test(semantic)) return 'usage';
  if (/\/skill-installs/.test(semantic)) return 'skills';
  if (/agent-pins\.json/.test(semantic)) return 'ferrets';
  if (/\bboard(?:[ ._-]|$)|boardimporter|cardstarts|unfiledrefiler/.test(semantic)) return 'board';
  if (/sweepdeadlines/.test(semantic)) return 'asks';
  if (/sendtracking|sendreproof|subsystems\.observer/.test(semantic)) return 'conversation';
  if (/\/secrets\/logins/.test(semantic)) return 'accounts';
  if (
    /accounts?|sign.?ins?|secure-copy|copyplans|signinrule/.test(semantic) &&
    !/credential|login-secrets/.test(semantic)
  )
    return 'accounts';
  if (/secrets?(?:[./ _-]|$)/.test(semantic)) return 'vault';
  if (/terminal|tmux/.test(semantic)) return 'terminals';
  if (/browser/.test(semantic)) return 'browsers';
  if (/devices|passkey/.test(semantic)) return 'access';
  if (/settings panel (?:grants|security-log)|fy daemon config/.test(semantic)) return 'gate';
  if (/resource-limits|limits\.yaml|lineage/.test(semantic)) return 'ferrets';
  if (/settings panel (?:files|doctor|host-checks)/.test(semantic)) return 'kernel';
  if (/settings panel about/.test(semantic)) return 'updates';
  if (/agent-clis/.test(semantic)) return 'claude-code';
  if (
    /\bfy (?:new|start|stop|ps|status|rename|resume|restart|wait|interrupt|migrate|session)\b/.test(semantic) &&
    !/subtree/.test(semantic)
  )
    return 'ferrets';
  if (/\/v1\/recommend|\bfy recommend|\bfy fleet\b|\bfy guide\b/.test(semantic)) return 'packs';
  if (/agenda-mode|agenda\/mode/.test(semantic)) return 'agenda';
  if (/\.toml|codex.*(?:settings|instructions)|(?:^|\/)codex\//.test(semantic)) return 'codex';
  if (/login-entries|account-defaults|login-secrets/.test(semantic))
    return /secrets/.test(semantic) ? 'vault' : 'accounts';
  if (/agenda-seen/.test(semantic)) return 'agenda';
  if (/agenda|attention/.test(semantic) && !/\bfy agenda|\bfy attention|notification|nudge/.test(semantic))
    return 'asks';
  if (/\bfy (?:copy|plan|rules|account)(?:\s|$)|\bsecure_list\b/.test(semantic)) return 'accounts';
  if (/revoke-credential/.test(semantic)) return 'ferrets';
  if (/\bfy daemon profile\b/.test(semantic)) return 'usage';
  if (/daemon-identity\.json/.test(semantic)) return 'kernel';
  if (/archived-sessions|callsigns|auto-resume|\/sessions\/(?:\{[^}]+\}\/)?(?:config|state)\.json/.test(semantic))
    return 'ferrets';
  if (/session-version/.test(semantic)) return 'ferrets';
  if (/push\.json|push-vapid/.test(semantic)) return 'access';
  if (/fy input\b/.test(semantic)) return 'vault';
  if (/fy (?:fs|files|pin)\b|pins\.json/.test(semantic)) return 'conversation';
  if (/fy harness\b|statusline/.test(semantic)) return /codex/.test(semantic) ? 'codex' : 'claude-code';
  if (/config_(?:read|write|validate)/.test(semantic)) return 'kernel';
  if (/harness.*codex|codex.*harness/.test(semantic)) return 'codex';
  if (/harness.*claude/.test(semantic)) return 'claude-code';
  for (const [pattern, owner] of rules) if (pattern.test(semantic)) return owner;
  if (/\/agenda\//.test(source) || /\/mounts\/agenda/.test(source)) return 'asks';
  if (/\/features\/fleet\/shell\//.test(source)) return 'app';
  for (const [pattern, owner] of rules) if (pattern.test(source)) return owner;
  if (/agent-files|harness-update/.test(text)) return /codex/.test(text) ? 'codex' : 'claude-code';
  if (/session|ferret|auto-resume|worktree|fork|handover|\bname/.test(text.replace(/packages\//g, '')))
    return 'ferrets';
  if (/config|paths|storage|journal|state-home|layout-version|daemon|runtime\/|fyd\.ts/.test(text)) return 'kernel';
  if (file.startsWith('packages/pwa/')) return /appearance|theme|layout/.test(text) ? 'layouts' : 'app';
  if (file.startsWith('packages/cli/')) return 'cli';
  return 'UNPLACED';
}

function renamed(what: string): string {
  return what
    .replace(/\/v1\/sessions(?=\/|\b)/g, '/v1/ferrets')
    .replace(/^fy task\b/, 'fy card')
    .replace(/^fy card status\b/, 'fy card progress')
    .replace(/^fy (?:credentials?|login)\b/, 'fy login')
    .replace(/^fy learning\b/, 'fy lesson')
    .replace(/^fy harness update(?: \[harness\])?$/, 'fy harness {claude-code|codex} update')
    .replace(/^fy migrate\b/, 'fy ferret move')
    .replace(/^fy import conversations\b/, 'fy link')
    .replace(/--ping\b/g, '--buzz')
    .replace(/\btask_plan\b/g, 'card_plan');
}
function removal(kind: Kind, what: string, file: string, detail: string): string | undefined {
  if (/\balias of\b/.test(detail)) return 'removed by design (§1.4: no aliases)';
  if (
    kind === 'F' &&
    /layout-version|carriers-migration\.json|board-import\.json|legacy-wire-use\.json|operator-password\.json|\.migrated\b|\.v[12]\.json|\.before-[^/]+\.json|(?:^|\/)tasks\.json|attention[^/]*\.json|fleet\/config\.yaml|\.migration-journal|pack-routing-migration-|(?:^|\/)daemon\.json|(?:^|\/)routing\.json|migration[^/]*\.json/.test(
      what,
    )
  )
    return 'removed by design (§9.2: old files/markers; feature moves to its owner)';
  if (/legacy|migration/.test(file) && !/session-migrate|session\/migrat|lib\/migration\/commands/.test(file)) {
    if (kind === 'J') return 'removed by design (§9.1, §9.2: one-shot conversion/old-format work)';
  }
  if (kind === 'S' && /legacy-tasks-redirect|version-skew|feature-unavailable|daemon-features/.test(what + file))
    return 'removed by design (§9.6: old routes/probes/fallback UI)';
  if (kind === 'V' && /fy daemon adopt\b/.test(what)) return 'removed by design (§9.1, §9.2: old home adoption)';
  if (kind === 'R' && /legacy-tasks/.test(file)) return 'removed by design (§9.1, §9.2: per-ferret tasks/old readers)';
  if (kind === 'F' && (/\/cgroups\//.test(what) || /\/cgroups\/legacy-documents/.test(file)))
    return 'removed by design (§9.2: old cgroups directory)';
  if (kind === 'F' && /fleet\/config\.yaml|account\/document\.ts/.test(what + file))
    return 'removed by design (§9.2: fleet/config.yaml)';
  return undefined;
}
function add(kind: Kind, what: string, file: string, line: number, descriptor = '', owner?: string) {
  let actualOwner = owner ?? ownerOf(file, what);
  if (kind === 'S' && actualOwner === 'asks') actualOwner = 'agenda';
  if (kind === 'F' && /\/channel\/|inbox\.jsonl|outbox\.jsonl|sends\.jsonl|answers\.jsonl/.test(what))
    actualOwner = 'conversation';
  const name5 = /^fy component\b/.test(what)
    ? renamed(what).replace(
        /^fy component/,
        'per-kind command: mcp/skill/shell/instruction/profile/runtime/model-set/harness settings/hooks (§1.4)',
      )
    : renamed(what);
  const check =
    kind === 'R'
      ? 'descriptor-parity'
      : `${packagePath(actualOwner)}/tests/parity/${{ V: 'commands', T: 'agent-tools', S: 'app', J: 'jobs', F: 'storage' }[kind]}.test.${kind === 'S' ? 'tsx' : 'ts'}`;
  rows.push({
    id: '',
    kind,
    what: compact(what),
    source: `${file}:${line}`,
    todayOwner: moduleName(file),
    owner: actualOwner,
    name5,
    descriptor: compact(descriptor),
    check,
    status: removal(kind, what, file, descriptor) ?? '[ ]',
  });
}

interface Module {
  file: string;
  ast: ts.SourceFile;
  declarations: Map<string, ts.Node[]>;
  imports: Map<string, [string, string]>;
}
const modules = new Map<string, Module>();
function parse(file: string): Module {
  const cached = modules.get(file);
  if (cached) return cached;
  const content = readFileSync(join(sourceRoot, file), 'utf8');
  const ast = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const mod: Module = { file, ast, declarations: new Map(), imports: new Map() };
  modules.set(file, mod);
  walk(ast, node => {
    if (
      (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isParameter(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      const list = mod.declarations.get(node.name.text) ?? [];
      list.push(node);
      mod.declarations.set(node.name.text, list);
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const path = node.moduleSpecifier.text;
      if (node.importClause?.name) mod.imports.set(node.importClause.name.text, [path, 'default']);
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const binding of bindings.elements)
          mod.imports.set(binding.name.text, [path, binding.propertyName?.text ?? binding.name.text]);
    }
  });
  return mod;
}
function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
}
const lineOf = (node: ts.Node) => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
const textOf = (node: ts.Node | undefined) => (node ? compact(node.getText()) : '');
function unwrap(node: ts.Node): ts.Node {
  return ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node)
    ? unwrap(node.expression)
    : node;
}
function propName(node: ts.PropertyName | ts.BindingName | undefined): string {
  return node && (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) ? node.text : '';
}
function enclosingScope(node: ts.Node): ts.Node {
  let current = node.parent;
  while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) current = current.parent;
  return current;
}
function declaration(mod: Module, name: string, from: ts.Node): ts.Node | undefined {
  const candidates = mod.declarations.get(name) ?? [];
  const scopes: ts.Node[] = [];
  let current: ts.Node | undefined = from;
  while (current) {
    if (ts.isFunctionLike(current) || ts.isSourceFile(current)) scopes.push(current);
    current = current.parent;
  }
  return candidates
    .filter(candidate => scopes.includes(enclosingScope(candidate)))
    .sort((a, b) => scopes.indexOf(enclosingScope(a)) - scopes.indexOf(enclosingScope(b)) || b.pos - a.pos)[0];
}
function importedFile(mod: Module, path: string): string | undefined {
  let base: string;
  if (path.startsWith('.')) base = relative(sourceRoot, resolve(sourceRoot, dirname(mod.file), path));
  else if (path.startsWith('@ferretry/protocol'))
    base = `packages/protocol/src/${path === '@ferretry/protocol' ? 'lib/index.ts' : path.replace('@ferretry/protocol/', 'lib/')}`;
  else if (path.startsWith('@ferretry/fleet'))
    base = `packages/fleet/src/${path === '@ferretry/fleet' ? 'lib/index.ts' : path.replace('@ferretry/fleet/', 'lib/')}`;
  else return;
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(
    file => existsSync(join(sourceRoot, file)) && statSync(join(sourceRoot, file)).isFile(),
  );
}

/** Small static expression reader for route descriptors and declaration constants. Unknowns remain source text. */
function literal(node: ts.Node | undefined, mod: Module, seen = new Set<ts.Node>()): unknown {
  if (!node || seen.has(node)) return undefined;
  node = unwrap(node);
  seen = new Set(seen).add(node);
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))
    return ts.isNumericLiteral(node) ? Number(node.text) : node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isIdentifier(node)) {
    const decl = declaration(mod, node.text, node);
    if (decl && ts.isVariableDeclaration(decl)) return literal(decl.initializer, mod, seen);
    const imported = mod.imports.get(node.text);
    const file = imported && importedFile(mod, imported[0]);
    if (file) {
      const target = parse(file);
      const decl = target.declarations.get(imported![1])?.[0];
      if (decl && ts.isVariableDeclaration(decl)) return literal(decl.initializer, target, seen);
      // Public contracts often re-export the constant through an index barrel.
      const exported = lookup(imported![1], target, moduleEnv(target));
      if (
        exported !== undefined &&
        !(exported instanceof Cmd) &&
        !(typeof exported === 'object' && exported !== null && 'fn' in exported)
      )
        return exported;
    }
    return undefined;
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(element => literal(element, mod, seen));
  if (ts.isObjectLiteralExpression(node)) {
    const result: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property))
        result[propName(property.name)] = literal(property.initializer, mod, seen) ?? textOf(property.initializer);
      else if (ts.isShorthandPropertyAssignment(property))
        result[property.name.text] = literal(property.name, mod, seen) ?? property.name.text;
      else if (ts.isSpreadAssignment(property)) Object.assign(result, literal(property.expression, mod, seen));
      else if (ts.isMethodDeclaration(property)) result[propName(property.name)] = '<handler>';
    }
    return result;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const target = literal(node.expression, mod, seen);
    if (target && typeof target === 'object') return (target as Record<string, unknown>)[node.name.text];
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literal(node.left, mod, seen);
    const right = literal(node.right, mod, seen);
    if (left !== undefined && right !== undefined) return `${left}${right}`;
  }
  return undefined;
}
function valueText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

// Routes: declarations only. Audit fragments deliberately do not count as duplicate live routes.
function routes(mod: Module) {
  walk(mod.ast, node => {
    if (!ts.isObjectLiteralExpression(node)) return;
    const keys = new Set(node.properties.map(property => ('name' in property ? propName(property.name) : '')));
    if (!keys.has('path') || (!keys.has('handle') && !keys.has('accept'))) return;
    const data = literal(node, mod) as Record<string, unknown>;
    if (!data.method || !data.path) return;
    const socket = keys.has('accept');
    const descriptor = ['minimum', 'caller', 'capability', 'privilegedOnly', 'unlockExempt', 'wardenRemedy'].map(
      key =>
        `${key}=${valueText(data[key] ?? (key === 'privilegedOnly' || key === 'unlockExempt' ? false : key === 'capability' || key === 'wardenRemedy' ? 'none' : 'not declared'))}`,
    );
    if (keys.has('needs')) descriptor.push(`member.needs=${valueText(data.needs)} (separate member admission table)`);
    for (const key of ['consultsGrants', 'freshStepUp', 'stepUp', 'available'])
      if (data[key] !== undefined) descriptor.push(`${key}=${valueText(data[key])}`);
    add('R', `${socket ? 'WS ' : ''}${data.method} ${data.path}`, mod.file, lineOf(node), descriptor.join('; '));
  });
}

// Commander syntax interpreter. None of these objects is a real Command or a production dependency.
class Cmd {
  flags = new Set<string>(['-h, --help']);
  args: string[] = [];
  aliases: string[] = [];
  children: Cmd[] = [];
  description = '';
  source = '';
  parent?: Cmd;
  constructor(readonly name: string) {}
  get path(): string {
    return this.parent ? `${this.parent.path} ${this.name}` : 'fy';
  }
}
interface Fn {
  fn: ts.FunctionLikeDeclaration;
  mod: Module;
  env: Env;
}
type Env = Map<string, unknown>;
const rootCommand = new Cmd('fy');
const visitedCommandCalls = new Set<string>();
const moduleEnvs = new Map<string, Env>();
let callDepth = 0;
function bind(name: ts.BindingName, value: unknown, env: Env) {
  if (ts.isIdentifier(name)) env.set(name.text, value);
  else if (ts.isObjectBindingPattern(name))
    for (const element of name.elements)
      bind(
        element.name,
        value && typeof value === 'object'
          ? (value as Record<string, unknown>)[propName(element.propertyName ?? element.name)]
          : undefined,
        env,
      );
  else if (ts.isArrayBindingPattern(name))
    name.elements.forEach((element, index) => {
      if (ts.isBindingElement(element)) bind(element.name, Array.isArray(value) ? value[index] : undefined, env);
    });
}
function moduleEnv(mod: Module): Env {
  let env = moduleEnvs.get(mod.file);
  if (env) return env;
  env = new Map();
  moduleEnvs.set(mod.file, env);
  for (const statement of mod.ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name)
      env.set(statement.name.text, { fn: statement, mod, env });
  }
  return env;
}
function lookup(name: string, mod: Module, env: Env): unknown {
  if (env.has(name)) return env.get(name);
  if (name === 'BINARY_NAME') return 'fy';
  const global = moduleEnv(mod);
  if (global.has(name)) return global.get(name);
  const decl = mod.declarations.get(name)?.find(candidate => enclosingScope(candidate) === mod.ast);
  if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
    global.set(name, undefined);
    const value = evaluate(decl.initializer, mod, global);
    global.set(name, value);
    return value;
  }
  const imported = mod.imports.get(name);
  const file = imported && importedFile(mod, imported[0]);
  if (file) return lookup(imported![1], parse(file), moduleEnv(parse(file)));
  // Resolve barrel re-exports without loading or running a module.
  for (const statement of mod.ast.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    const names =
      statement.exportClause && ts.isNamedExports(statement.exportClause) ? statement.exportClause.elements : undefined;
    if (names && !names.some(element => element.name.text === name)) continue;
    const target = importedFile(mod, statement.moduleSpecifier.text);
    if (!target || target === mod.file) continue;
    const targetMod = parse(target);
    if (targetMod.declarations.has(name) || targetMod.ast.text.includes(` ${name}`)) {
      const value = lookup(
        names?.find(element => element.name.text === name)?.propertyName?.text ?? name,
        targetMod,
        moduleEnv(targetMod),
      );
      if (value !== undefined) return value;
    }
  }
  return undefined;
}
function invoke(fn: unknown, values: unknown[]): unknown {
  if (!fn || typeof fn !== 'object' || !('fn' in fn)) return undefined;
  const { fn: node, mod, env } = fn as Fn;
  // Only registration code and pure flag wrappers. Never evaluate an action/controller/helper body.
  if (
    !/\.command\s*\(|\.option\s*\(|\.requiredOption\s*\(|\.addOption\s*\(|register[A-Z]|\bverb\s*\(|writeFlags\s*\(|\.name\(\)\s*===/.test(
      node.getText(),
    )
  )
    return undefined;
  if (++callDepth > 45) throw new Error(`Commander recursion: ${mod.file}:${lineOf(node)}`);
  const local = new Map(env);
  node.parameters.forEach((parameter, index) =>
    bind(
      parameter.name,
      values[index] ?? (parameter.initializer ? evaluate(parameter.initializer, mod, local) : undefined),
      local,
    ),
  );
  const result =
    node.body &&
    (ts.isBlock(node.body) ? statements(node.body.statements, mod, local) : { value: evaluate(node.body, mod, local) });
  callDepth--;
  return result?.value;
}
function evaluate(input: ts.Node | undefined, mod: Module, env: Env): unknown {
  if (!input) return undefined;
  const node = unwrap(input);
  if (ts.isIdentifier(node)) return lookup(node.text, mod, env);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return { fn: node, mod, env } satisfies Fn;
  if (ts.isArrayLiteralExpression(node))
    return node.elements.flatMap(element =>
      ts.isSpreadElement(element)
        ? ((evaluate(element.expression, mod, env) as unknown[]) ?? [])
        : [evaluate(element, mod, env)],
    );
  if (ts.isObjectLiteralExpression(node)) {
    const result: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) result[propName(property.name)] = evaluate(property.initializer, mod, env);
      if (ts.isShorthandPropertyAssignment(property)) result[property.name.text] = lookup(property.name.text, mod, env);
      if (ts.isSpreadAssignment(property)) Object.assign(result, evaluate(property.expression, mod, env));
    }
    return result;
  }
  if (ts.isTemplateExpression(node))
    return (
      node.head.text +
      node.templateSpans
        .map(span => `${evaluate(span.expression, mod, env) ?? '{dynamic}'}${span.literal.text}`)
        .join('')
    );
  if (ts.isPropertyAccessExpression(node)) {
    const value = evaluate(node.expression, mod, env);
    if (value instanceof Cmd && node.name.text === 'commands') return value.children;
    return value && typeof value === 'object' ? (value as Record<string, unknown>)[node.name.text] : undefined;
  }
  if (ts.isElementAccessExpression(node)) {
    const value = evaluate(node.expression, mod, env);
    const key = evaluate(node.argumentExpression, mod, env);
    return value && key !== undefined ? (value as Record<string, unknown>)[String(key)] : undefined;
  }
  if (ts.isBinaryExpression(node)) {
    const left = evaluate(node.left, mod, env);
    const right = evaluate(node.right, mod, env);
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
        return left === right;
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        return left !== right;
      case ts.SyntaxKind.QuestionQuestionToken:
        return left ?? right;
      case ts.SyntaxKind.BarBarToken:
        return left || right;
      case ts.SyntaxKind.PlusToken:
        return typeof left === 'string' || typeof right === 'string' ? `${left ?? ''}${right ?? ''}` : undefined;
    }
  }
  if (ts.isConditionalExpression(node))
    return evaluate(evaluate(node.condition, mod, env) ? node.whenTrue : node.whenFalse, mod, env);
  if (ts.isNewExpression(node))
    return node.expression.getText() === 'Command'
      ? new Cmd(String(evaluate(node.arguments?.[0], mod, env) ?? 'fy'))
      : undefined;
  if (ts.isCallExpression(node)) {
    if (ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      const receiver = evaluate(node.expression.expression, mod, env);
      if (receiver instanceof Cmd) {
        // Arguments to action/hooks may contain arbitrary product code: deliberately do not traverse them.
        if (
          [
            'action',
            'hook',
            'addHelpText',
            'configureHelp',
            'configureOutput',
            'showHelpAfterError',
            'showSuggestionAfterError',
            'allowUnknownOption',
            'enablePositionalOptions',
            'passThroughOptions',
            'helpOption',
          ].includes(name)
        )
          return receiver;
        const values = node.arguments.map(argument => evaluate(argument, mod, env));
        if (name === 'command') {
          visitedCommandCalls.add(`${mod.file}:${node.pos}`);
          if (typeof values[0] !== 'string') {
            warnings.add(`Commander name unresolved: ${mod.file}:${lineOf(node)} ${textOf(node)}`);
            return undefined;
          }
          const [verb, ...commandArgs] = values[0].split(/\s+/);
          let child = receiver.children.find(candidate => candidate.name === verb);
          if (!child) {
            child = new Cmd(verb!);
            child.parent = receiver;
            receiver.children.push(child);
          }
          child.source ||= `${mod.file}:${lineOf(node)}`;
          child.args.push(...commandArgs);
          return child;
        }
        if (['option', 'requiredOption'].includes(name) && typeof values[0] === 'string') receiver.flags.add(values[0]);
        if (['argument', 'arguments'].includes(name) && typeof values[0] === 'string') receiver.args.push(values[0]);
        if (name === 'description' && typeof values[0] === 'string') receiver.description = values[0];
        if (name === 'alias' && typeof values[0] === 'string') receiver.aliases.push(values[0]);
        if (name === 'aliases' && Array.isArray(values[0])) receiver.aliases.push(...values[0]);
        if (name === 'name' && values.length === 0) return receiver.name;
        if (name === 'version') receiver.flags.add(typeof values[1] === 'string' ? values[1] : '-V, --version');
        return receiver;
      }
      const values = node.arguments.map(argument => evaluate(argument, mod, env));
      if (Array.isArray(receiver)) {
        if (name === 'find') return receiver.find(value => invokePredicate(values[0], value));
        if (name === 'forEach') {
          receiver.forEach(value => invoke(values[0], [value]));
          return undefined;
        }
        if (name === 'join') return receiver.join(String(values[0] ?? ','));
        if (name === 'includes') return receiver.includes(values[0]);
      }
      if (receiver && typeof receiver === 'object') return invoke((receiver as Record<string, unknown>)[name], values);
      return undefined;
    }
    return invoke(
      evaluate(node.expression, mod, env),
      node.arguments.map(argument => evaluate(argument, mod, env)),
    );
  }
  return undefined;
}
function invokePredicate(value: unknown, argument: unknown): boolean {
  if (!value || typeof value !== 'object' || !('fn' in value)) return false;
  const fn = value as Fn;
  const local = new Map(fn.env);
  if (fn.fn.parameters[0]) bind(fn.fn.parameters[0].name, argument, local);
  return fn.fn.body ? Boolean(evaluate(fn.fn.body, fn.mod, local)) : false;
}
function statements(nodes: ts.NodeArray<ts.Statement>, mod: Module, env: Env): { value: unknown } | undefined {
  for (const node of nodes) {
    if (ts.isFunctionDeclaration(node) && node.name) env.set(node.name.text, { fn: node, mod, env });
    else if (ts.isVariableStatement(node))
      for (const decl of node.declarationList.declarations) bind(decl.name, evaluate(decl.initializer, mod, env), env);
    else if (ts.isExpressionStatement(node)) evaluate(node.expression, mod, env);
    else if (ts.isReturnStatement(node)) return { value: evaluate(node.expression, mod, env) };
    else if (ts.isForOfStatement(node)) {
      const iterable = evaluate(node.expression, mod, env);
      if (Array.isArray(iterable) && ts.isVariableDeclarationList(node.initializer))
        for (const value of iterable) {
          const local = new Map(env);
          bind(node.initializer.declarations[0]!.name, value, local);
          if (ts.isBlock(node.statement)) statements(node.statement.statements, mod, local);
          else if (ts.isExpressionStatement(node.statement)) evaluate(node.statement.expression, mod, local);
        }
    } else if (ts.isBlock(node)) statements(node.statements, mod, env);
    // Guards in registration files are dependency checks, not action handlers. Unknown dependencies
    // cannot hide an existing command from the inventory; register both syntactic arms if necessary.
    else if (ts.isIfStatement(node)) {
      for (const arm of [node.thenStatement, node.elseStatement])
        if (arm) {
          if (ts.isBlock(arm)) statements(arm.statements, mod, env);
          else if (ts.isExpressionStatement(arm)) evaluate(arm.expression, mod, env);
        }
    }
  }
  return undefined;
}
function commands() {
  const mod = parse('packages/cli/bin/program.ts');
  const env = moduleEnv(mod);
  const wiring = parse('packages/cli/bin/wiring.ts');
  const program = invoke(lookup('createProgram', wiring, moduleEnv(wiring)), []) as Cmd | undefined;
  if (program) {
    rootCommand.flags = program.flags;
  }
  // The actual registrar table is the entry point; injected deps stay inert/undefined.
  invoke(lookup('registerDoctorCommand', mod, env), [rootCommand, {}]);
  const registrars = lookup('DOMAIN_REGISTRARS', mod, env);
  if (!Array.isArray(registrars)) throw new Error('Commander registrar table was not found');
  for (const registrar of registrars) invoke(registrar, [{ program: rootCommand, world: { environment: {} } }]);
  const emit = (command: Cmd, aliasAncestor = '') => {
    const flags = new Set(command.flags);
    let parent = command.parent;
    while (parent) {
      for (const flag of parent.flags) flags.add(flag);
      parent = parent.parent;
    }
    const syntax = `${command.path}${command.args.length ? ` ${[...new Set(command.args)].join(' ')}` : ''}`;
    const [file, line] = command.source.split(/:(?=\d+$)/);
    const aliasOf = aliasAncestor || (/\balias of\b|deprecated:/.test(command.description) ? command.description : '');
    const detail = `${aliasOf ? `alias of ${aliasOf}; ` : ''}${command.description}; flags (including inherited): ${[...flags].sort().join('; ')}`;
    if (file) add('V', syntax, file, Number(line), detail);
    for (const alias of new Set(command.aliases))
      if (file)
        add(
          'V',
          syntax.replace(command.path, `${command.parent?.path ?? 'fy'} ${alias}`),
          file,
          Number(line),
          `alias of ${command.path}; ${detail}`,
        );
    if (command.path === 'fy status' && [...flags].some(flag => flag.includes('--subtree'))) {
      add('V', 'fy status --subtree', file!, Number(line), `variant; ${detail}`, 'packs');
      rows[rows.length - 1]!.name5 = 'fy pack';
    }
    if (command.path === 'fy notify' && [...flags].some(flag => flag.includes('--ping')))
      add('V', 'fy notify --ping', file!, Number(line), `flag variant; ${detail}`, 'agenda');
    for (const child of command.children) emit(child, aliasOf);
  };
  rootCommand.source = 'packages/cli/bin/wiring.ts:80';
  emit(rootCommand);
}

function tools(mod: Module) {
  if (mod.file !== 'packages/cli/src/lib/mcp/tools.ts') return;
  walk(mod.ast, node => {
    if (!ts.isObjectLiteralExpression(node)) return;
    const keys = node.properties.map(property => ('name' in property ? propName(property.name) : ''));
    if (!keys.includes('name') || !keys.includes('inputSchema') || !keys.includes('description')) return;
    const data = literal(node, mod) as Record<string, unknown>;
    add('T', String(data.name), mod.file, lineOf(node), `wire=${data.tool ?? data.name}; ${data.description}`);
  });
}

function contextName(node: ts.Node): string {
  let current = node.parent;
  const parts: string[] = [];
  while (current && !ts.isSourceFile(current)) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isPropertyAssignment(current) ||
        ts.isVariableDeclaration(current)) &&
      current.name
    ) {
      const name = propName(current.name);
      if (name && !parts.includes(name)) parts.unshift(name);
    }
    current = current.parent;
  }
  return parts.join('.');
}
function jobs(mod: Module) {
  if (!mod.file.startsWith('packages/daemon/')) return;
  walk(mod.ast, node => {
    if (
      mod.file.includes('/bin/modules/') &&
      ts.isPropertyAssignment(node) &&
      propName(node.name) === 'jobs' &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties)
        if ('name' in property)
          add(
            'J',
            `module job ${moduleName(mod.file)}.${propName(property.name)}`,
            mod.file,
            lineOf(property),
            textOf(property),
          );
    }
    if (!ts.isCallExpression(node)) return;
    const callee = textOf(node.expression);
    const timer =
      /(?:^|\.)(?:setInterval|setTimeout|watch|watchFile)$/.test(callee) ||
      /(?:scheduler|timers?|clock)\.(?:after|every|interval|repeat|schedule)$/.test(callee) ||
      /\.deps\.after$/.test(callee);
    const host = mod.file.includes('/bin/');
    const arming =
      host &&
      (/(?:^|\.)(?:arm[A-Z]\w*|start[A-Z]\w*|watch[A-Z]\w*)$/.test(callee) ||
        /\.jobs\.\w+$/.test(callee) ||
        /\.(?:arm|start|watch|run|tick|sweep|schedule|subscribe)$/.test(callee));
    if (!timer && !arming) return;
    if (
      !timer &&
      /(?:serial|sessionMutations|cardStarts|lifecycle|parts\.control|cards|service)\.(?:run|start|startOn)$/.test(
        callee,
      )
    )
      return;
    const context = contextName(node);
    const delayFirst = /(?:scheduler|timers?|clock)\.(?:after|every|interval|repeat|schedule)$/.test(callee);
    const scheduleNode = node.arguments[delayFirst ? 0 : 1];
    const callbackNode = node.arguments[delayFirst ? 1 : 0];
    const schedule = scheduleNode ? textOf(scheduleNode) : '';
    const callback = callbackNode ? textOf(callbackNode) : '';
    const what = `${timer ? 'timer/watcher' : 'job/lifecycle arm'} ${callee} in ${context || 'module'}${schedule ? `; cadence=${schedule.slice(0, 160)}` : ''}${callback ? `; action=${callback.slice(0, 140)}` : ''}`;
    add(
      'J',
      what,
      mod.file,
      lineOf(node),
      `call=${textOf(node).slice(0, 800)}; callback=${callback.slice(0, 350)}; timer sites include one-shot/backoff/adapter schedulers, not just perpetual jobs`,
      ownerOf(mod.file, `${what} ${callback}`),
    );
  });
}

function surfaces(mod: Module) {
  if (!mod.file.startsWith('packages/pwa/src/')) return;
  const file = mod.file;
  if (file.endsWith('.tsx'))
    walk(mod.ast, node => {
      const named =
        (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name && ts.isIdentifier(node.name)
          ? node.name.text
          : '';
      if (
        named &&
        /^[A-Z]/.test(named) &&
        /(?:Page|Panel|Screen|Sheet|Dialog|View|Settings|Surface|Tabs|Menu|Drawer|Modal|Tab|Section|Route)$/.test(named)
      )
        add(
          'S',
          `component ${named}`,
          file,
          lineOf(node),
          `UI declaration; ${file.includes('/settings/') ? 'settings surface' : 'feature/shell surface'}`,
        );
    });
  if (file.endsWith('/lib/pages/routes.ts'))
    walk(mod.ast, node => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        /Path$/.test(node.name.text) &&
        node.initializer
      ) {
        add(
          'S',
          `route ${node.name.text}: ${routeTemplate(node.initializer, mod)}`,
          file,
          lineOf(node),
          textOf(node.initializer),
        );
      }
      if (ts.isInterfaceDeclaration(node)) {
        const kind = node.members.find(member => 'name' in member && propName(member.name) === 'kind');
        if (kind && ts.isPropertySignature(kind) && kind.type)
          add('S', `screen ${textOf(kind.type)}`, file, lineOf(node), `route model ${node.name.text}`);
      }
    });
  if (
    /settings|navigation|nav-model|side-pane-tab|view-tabs|palette-destinations|App\.tsx|page-host|machine-route|machine-panels|app-bar/.test(
      file,
    )
  )
    walk(mod.ast, node => {
      if (ts.isObjectLiteralExpression(node)) {
        const keys = node.properties.map(property => ('name' in property ? propName(property.name) : ''));
        if (!keys.includes('id') && !keys.includes('key')) return;
        if (!keys.some(key => ['label', 'title', 'settingIds', 'render', 'Component'].includes(key))) return;
        const data = literal(node, mod) as Record<string, unknown>;
        const identity = node.properties.find(
          property => ts.isPropertyAssignment(property) && ['id', 'key'].includes(propName(property.name)),
        );
        if (!identity || !ts.isPropertyAssignment(identity) || typeof literal(identity.initializer, mod) !== 'string')
          return;
        add(
          'S',
          `settings/navigation ${String(data.id ?? data.key)}: ${String(data.label ?? data.title ?? '')}`,
          file,
          lineOf(node),
          `catalog entry in ${contextName(node)}`,
        );
        if (Array.isArray(data.panels))
          for (const panel of data.panels)
            if (typeof panel === 'string')
              add(
                'S',
                `settings panel ${panel}`,
                file,
                lineOf(node),
                `group=${data.id}; tab=${data.tab}; label=${data.label}`,
              );
      }
      if (
        ts.isTypeAliasDeclaration(node) &&
        /(?:Tab|Pane|Panel|Section)(?:Id|Key|Name)?$/.test(node.name.text) &&
        ts.isUnionTypeNode(node.type)
      ) {
        for (const type of node.type.types)
          if (ts.isLiteralTypeNode(type))
            add('S', `${node.name.text} ${textOf(type)}`, file, lineOf(type), 'tab/panel/section discriminant');
      }
      if (ts.isVariableDeclaration(node) && /(?:SLOTS|TABS|DESTINATIONS)$/.test(textOf(node.name))) {
        const value = node.initializer && unwrap(node.initializer);
        if (value && ts.isObjectLiteralExpression(value))
          for (const property of value.properties)
            if ('name' in property)
              add('S', `${textOf(node.name)} ${propName(property.name)}`, file, lineOf(property), textOf(property));
      }
    });
}

/** Expand the app's path builders symbolically; never call the production router. */
function routeTemplate(input: ts.Node, mod: Module, seen = new Set<ts.Node>()): string {
  const node = unwrap(input);
  if (seen.has(node)) return ':dynamic';
  seen = new Set(seen).add(node);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (!ts.isBlock(node.body)) return routeTemplate(node.body, mod, seen);
    const returns = node.body.statements.filter(ts.isReturnStatement);
    return returns.at(-1)?.expression ? routeTemplate(returns.at(-1)!.expression!, mod, seen) : ':dynamic';
  }
  if (ts.isTemplateExpression(node))
    return (
      node.head.text +
      node.templateSpans.map(span => `${routeTemplate(span.expression, mod, seen)}${span.literal.text}`).join('')
    );
  if (ts.isIdentifier(node)) {
    const decl = declaration(mod, node.text, node);
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return routeTemplate(decl.initializer, mod, seen);
    return node.text === 'id' ? ':daemonId' : `:${node.text}`;
  }
  if (ts.isPropertyAccessExpression(node)) return `:${node.name.text}`;
  if (ts.isCallExpression(node)) {
    if (textOf(node.expression) === 'encodeURIComponent') return routeTemplate(node.arguments[0]!, mod, seen);
    const name = textOf(node.expression);
    const decl = mod.declarations.get(name)?.[0];
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return routeTemplate(decl.initializer, mod, seen);
    return `:${ts.isPropertyAccessExpression(node.expression) ? textOf(node.expression.expression) : 'dynamic'}`;
  }
  if (ts.isConditionalExpression(node))
    return `{${routeTemplate(node.whenTrue, mod, seen)}|${routeTemplate(node.whenFalse, mod, seen)}}`;
  return ':dynamic';
}

function configPaths(mod: Module) {
  if (mod.file !== 'packages/protocol/src/lib/config-files.ts') return;
  const value = (name: string) => {
    const decl = mod.declarations.get(name)?.[0];
    return decl && ts.isVariableDeclaration(decl) ? literal(decl.initializer, mod) : undefined;
  };
  const singletons = value('SINGLETON_FILES') as Record<string, string> | undefined;
  const named = value('NAMED_DIRECTORIES') as Record<string, string> | undefined;
  const kinds = value('CONFIG_COMPONENT_KINDS') as string[] | undefined;
  const configOwners: Record<string, string> = {
    machine: 'runtimes',
    login: 'logins',
    profile: 'runtimes',
    runtime: 'runtimes',
    preset: 'logins',
    models: 'logins',
    warden: 'warden',
    learning: 'lessons',
    voice: 'voice',
    pack: 'packs',
    limits: 'ferrets',
    modelsGuide: 'packs',
    accountDefaults: 'accounts',
    instructions: 'ferrets',
    mcp: 'mcp',
    skills: 'skills',
    settings: 'claude-code',
    hooks: 'claude-code',
    modelSets: 'runtimes',
  };
  const sourceLine = (name: string) => lineOf(mod.declarations.get(name)![0]!);
  if (singletons)
    for (const [kind, file] of Object.entries(singletons))
      add(
        'F',
        `FY_HOME/config/${file}`,
        mod.file,
        sourceLine('SINGLETON_FILES'),
        `config singleton; kind=${kind}; generated from SINGLETON_FILES`,
        configOwners[kind],
      );
  if (named)
    for (const [kind, directory] of Object.entries(named))
      add(
        'F',
        `FY_HOME/config/${directory}/{name}.yaml`,
        mod.file,
        sourceLine('NAMED_DIRECTORIES'),
        `named config family; kind=${kind}`,
        configOwners[kind],
      );
  if (kinds)
    for (const kind of kinds) {
      add(
        'F',
        `FY_HOME/config/components/${kind}/{name}.yaml`,
        mod.file,
        sourceLine('CONFIG_COMPONENT_KINDS'),
        `component config family; kind=${kind}`,
        configOwners[kind],
      );
      if (kind === 'settings')
        add(
          'F',
          `FY_HOME/config/components/${kind}/{name}.yaml (Codex scope)`,
          mod.file,
          sourceLine('CONFIG_COMPONENT_KINDS'),
          'same current item family; harness-specific scope moves to the Codex package (§8)',
          'codex',
        );
    }
  const schemas = value('CONFIG_SCHEMA_IDS');
  if (Array.isArray(schemas))
    for (const id of schemas)
      if (typeof id === 'string')
        add(
          'F',
          `FY_HOME/config/.schema/${id}.json`,
          mod.file,
          sourceLine('CONFIG_SCHEMA_IDS'),
          'generated editor JSON schema',
          'kernel',
        );
  if (kinds)
    for (const kind of kinds)
      add(
        'F',
        `FY_HOME/config/.schema/component-${kind}.json`,
        mod.file,
        sourceLine('CONFIG_SCHEMA_IDS'),
        'component schema from CONFIG_SCHEMA_IDS mapped spread',
        'kernel',
      );
}

const foundation: Record<string, string> = {};
const sessionPaths: Record<string, string> = {};
const constructorRoots = new Map<string, Map<number, Set<string>>>();
const localPathMaps = new Map<string, Record<string, string>>();
const knownRoots: Record<string, string> = {
  stateHome: 'FY_HOME',
  fyHome: 'FY_HOME',
  state: 'FY_HOME/state',
  stateDirectory: 'FY_HOME/state',
  fleet: 'FY_HOME/fleet',
  fleetDirectory: 'FY_HOME/fleet',
  configDirectory: 'FY_HOME/config',
  configRoot: 'FY_HOME/config',
  wardenRoot: 'FY_HOME/state/warden',
};
/** Preserve dynamic segments; this is a path declaration inventory, not a filesystem scan. */
function pathValue(input: ts.Node | undefined, mod: Module, seen = new Set<ts.Node>()): string {
  if (!input) return '{unknown}';
  const node = unwrap(input);
  if (seen.has(node)) return `{${textOf(node)}}`;
  seen = new Set(seen).add(node);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return (
      node.head.text +
      node.templateSpans.map(span => `${pathValue(span.expression, mod, seen)}${span.literal.text}`).join('')
    );
  if (ts.isIdentifier(node)) {
    const value = literal(node, mod);
    if (typeof value === 'string') return value;
    if (node.text === 'home' && mod.file === 'packages/daemon/src/lib/paths.ts') return 'FY_HOME';
    const root = constructorRoot(node, mod, node.text);
    if (root) return root;
    const decl = declaration(mod, node.text, node);
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return pathValue(decl.initializer, mod, seen);
    if (knownRoots[node.text]) return knownRoots[node.text]!;
    return `{${node.text}}`;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const expression = textOf(node.expression);
    if (
      /^(?:this\.)?paths$/.test(expression) &&
      localPathMaps.has(mod.file) &&
      !/create\w*Paths/.test(contextName(node))
    ) {
      const local = localPathMaps.get(mod.file)![node.name.text];
      if (local) return local;
    }
    if (expression === 'this') {
      const root = constructorRoot(node, mod, node.name.text);
      if (root) return root;
      // Class path fields initialized from a constructor's confined root.
      let enclosing: ts.Node | undefined = node;
      while (enclosing && !ts.isClassDeclaration(enclosing)) enclosing = enclosing.parent;
      if (enclosing) {
        let result: string | undefined;
        walk(enclosing, candidate => {
          if (
            ts.isBinaryExpression(candidate) &&
            candidate.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            textOf(candidate.left) === textOf(node)
          )
            result = pathValue(candidate.right, mod, seen);
        });
        if (result) return result;
      }
    }
    if (/createSessionPaths\(/.test(expression) || expression === 'sessionPaths')
      return sessionPaths[node.name.text] ?? `{${textOf(node)}}`;
    if (
      /(?:^|\.)(?:paths|foundation|layout)$/.test(expression) ||
      expression === 'this.paths' ||
      expression.endsWith('.paths')
    ) {
      if (foundation[node.name.text]) return foundation[node.name.text]!;
      if (knownRoots[node.name.text]) return knownRoots[node.name.text]!;
    }
    if (/stateHome(?:\.path)?$/.test(textOf(node))) return 'FY_HOME';
    return `{${textOf(node)}}`;
  }
  if (ts.isCallExpression(node)) {
    if (/(?:^|\.)(?:join|resolve|joinPath)$/.test(textOf(node.expression)))
      return node.arguments
        .map(argument => pathValue(argument, mod, seen))
        .join('/')
        .replace(/\/{2,}/g, '/');
    if (ts.isPropertyAccessExpression(node.expression) && textOf(node.expression.expression) === 'this') {
      const root = constructorRoot(node, mod, node.expression.name.text);
      if (root) return root;
    }
  }
  if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) return pathValue(node.body, mod, seen);
  return `{${textOf(node).slice(0, 160)}}`;
}
function constructorRoot(node: ts.Node, _mod: Module, name: string): string | undefined {
  let enclosing: ts.Node | undefined = node;
  while (enclosing && !ts.isClassDeclaration(enclosing)) enclosing = enclosing.parent;
  if (!enclosing || !enclosing.name) return;
  const ctor = enclosing.members.find(ts.isConstructorDeclaration);
  if (!ctor) return;
  const index = ctor.parameters.findIndex(parameter => propName(parameter.name) === name);
  if (index < 0) return;
  const roots = constructorRoots.get(enclosing.name.text)?.get(index);
  return roots?.size === 1 ? [...roots][0] : undefined;
}
function storage(mod: Module) {
  if (!/^packages\/(?:daemon|fleet|cli|protocol)\//.test(mod.file)) return;
  walk(mod.ast, node => {
    const joinCall = ts.isCallExpression(node) && /(?:^|\.)(?:join|resolve|joinPath)$/.test(textOf(node.expression));
    const template = ts.isTemplateExpression(node);
    const pathConstant =
      ts.isVariableDeclaration(node) &&
      /(?:PATH|FILE|FILENAME|DOCUMENT|BACKUP|MARKER|OUTBOX|PENDING|NAME)$/.test(textOf(node.name)) &&
      node.initializer;
    const filename =
      ts.isStringLiteral(node) &&
      /^[\w.-]+\.(?:jsonl?|ya?ml|sqlite|db|log|sock|key|txt|toml)$/.test(node.text) &&
      /\/adapters\/|\/lib\/(?:agenda|scratch|pack|account|usage|shared-history|config-files)/.test(mod.file) &&
      !/\/host-harness-scan|syscall-tracer|browser\/|imports\//.test(mod.file);
    if (!joinCall && !template && !pathConstant && !filename) return;
    const expression = pathConstant ? (node as ts.VariableDeclaration).initializer! : node;
    if (
      pathConstant &&
      !ts.isStringLiteralLike(unwrap(expression)) &&
      !ts.isTemplateExpression(unwrap(expression)) &&
      !ts.isCallExpression(unwrap(expression))
    )
      return;
    const value = pathValue(expression, mod);
    const raw = textOf(expression);
    // Include durable documents, caches, sockets, logs and directory families. Exclude URLs,
    // package/test assets and paths explicitly outside Ferretry's home.
    if (/https?:|node_modules|\.git\b|\/etc\/|\/run\/|\.github|\.(?:png|svg|css|js|tsx?)$/.test(value)) return;
    if (
      !(joinCall && definiteHome(value)) &&
      !/(?:\.(?:jsonl?|ya?ml|sqlite(?:-wal|-shm)?|db|log|lock|sock|key|md|toml|txt)|(?:^|\/)(?:api-token|warden-token|layout-version|session-version|manifest|credentials|config|homes|assets|blobs|reports|sessions|attachments|turns|input-requests|payloads|runs|skills|instructions|browser-upload|forks|moves)(?:\/|$))/.test(
        value,
      )
    )
      return;
    if (
      /(?:userHome|process\.cwd|import\.meta|projectRoot|repoRoot|worktreeRoot)|mkdtemp|fy-format-probe|fy-trace-|runtimeDirectory|\/tmp/.test(
        value,
      )
    )
      return;
    if (!definiteHome(value) && /(?:\.claude|\.codex)/.test(value)) return;
    const definite = value.includes('FY_HOME');
    const storageContext =
      /\/adapters\/|paths|layout|store|storage|files|config|ledger|journal|repository|state-home|manifest|registry|runtime|modules|fyd\.ts/.test(
        mod.file,
      );
    if (!definite && !storageContext) return;
    if (!definite && !joinCall && !pathConstant && !filename) return;
    let shape = value;
    for (let pass = 0; pass < 8; pass++) shape = shape.replace(/\{[^{}]*\}/g, ':segment');
    if (/\s/.test(shape) || (shape.startsWith(':segment') && !shape.includes('/'))) return;
    if (
      value.length > 500 ||
      value.includes('\n') ||
      (!value.startsWith('FY_HOME/') &&
        !value.startsWith('{') &&
        !/^[\w.-]+\.(?:jsonl?|ya?ml|sqlite|log|lock|sock|key|md|toml|txt)$/.test(value) &&
        !/^(?:api-token|warden-token|layout-version|session-version)$/.test(value))
    )
      return;
    const context = contextName(node);
    add(
      'F',
      value,
      mod.file,
      lineOf(node),
      `owner module=${moduleName(mod.file)}; ${definite ? 'FY_HOME anchored' : 'relative/path family: root supplied by composition; verify confinement when porting'}; ${context}; expression=${raw.slice(0, 500)}`,
    );
  });
}
const definiteHome = (value: string) => value.includes('FY_HOME');

// Resolve the canonical foundation first so later adapters retain the actual FY_HOME-relative path.
const pathsModule = parse('packages/daemon/src/lib/paths.ts');
walk(pathsModule.ast, node => {
  if (
    (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
    /createFoundationPaths/.test(contextName(node))
  ) {
    const name = propName(node.name);
    const expression = ts.isPropertyAssignment(node) ? node.initializer : node.name;
    if (ts.isIdentifier(expression) || ts.isCallExpression(expression)) {
      const value = pathValue(expression, pathsModule);
      if (value.includes('FY_HOME')) foundation[name] = value;
    }
  }
});
walk(pathsModule.ast, node => {
  if (ts.isPropertyAssignment(node) && /createSessionPaths/.test(contextName(node))) {
    sessionPaths[propName(node.name)] = pathValue(node.initializer, pathsModule);
  }
});
sessionPaths.directory = 'FY_HOME/state/sessions/{sessionId}';
foundation.binDirectory = 'FY_HOME/fleet/bin';
foundation.homesDirectory = 'FY_HOME/fleet/homes';
foundation.assetsDirectory = 'FY_HOME/fleet/assets';
// Link constructor root parameters back to their composition sites without executing either side.
for (const file of files.filter(file => /^packages\/(?:daemon|cli|fleet)\//.test(file))) {
  const content = readFileSync(join(sourceRoot, file), 'utf8');
  if (!/new \w+\(/.test(content) || !/paths\.|stateHome|stateDirectory/.test(content)) continue;
  const mod = parse(file);
  walk(mod.ast, node => {
    if (!ts.isNewExpression(node) || !node.arguments) return;
    const name = textOf(node.expression);
    node.arguments.forEach((argument, index) => {
      const value = pathValue(argument, mod);
      if (!value.startsWith('FY_HOME') || (value.includes('{') && !/sessions\/\{/.test(value))) return;
      const roots = constructorRoots.get(name) ?? new Map<number, Set<string>>();
      const candidates = roots.get(index) ?? new Set<string>();
      candidates.add(value);
      roots.set(index, candidates);
      constructorRoots.set(name, roots);
    });
  });
  if (!file.startsWith('packages/cli/')) modules.delete(file);
}
commands();
for (const file of files) {
  const content = readFileSync(join(sourceRoot, file), 'utf8');
  digest.update(file).update('\0').update(content).update('\0');
  const mod = parse(file);
  if (file.startsWith('packages/cli/'))
    walk(mod.ast, node => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'command' &&
        !visitedCommandCalls.has(`${file}:${node.pos}`)
      )
        warnings.add(
          `Commander declaration not reached from DOMAIN_REGISTRARS: ${file}:${lineOf(node)} ${textOf(node).slice(0, 200)}`,
        );
    });
  // Private path factories (LearningPaths, WardenPaths, etc.) may reuse FoundationPaths field names.
  // Their roots must never overwrite the foundation or a ferret's paths.
  const local: Record<string, string> = {};
  walk(mod.ast, node => {
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      /create\w+Paths/.test(contextName(node)) &&
      !/createFoundationPaths|createSessionPaths/.test(contextName(node))
    )
      local[propName(node.name)] = pathValue(ts.isPropertyAssignment(node) ? node.initializer : node.name, mod);
  });
  if (Object.keys(local).length) localPathMaps.set(file, local);
  if (file.startsWith('packages/daemon/')) routes(mod);
  tools(mod);
  jobs(mod);
  surfaces(mod);
  storage(mod);
  configPaths(mod);
  // Release non-CLI trees after each file; shared box, no compiler program/typechecker required.
  if (!file.startsWith('packages/cli/') && !file.startsWith('packages/protocol/')) modules.delete(file);
}
// Every feature boundary is explicit even where a component is named without a Panel/Page suffix.
const features = new Set(
  files
    .filter(file => file.startsWith('packages/pwa/src/features/'))
    .map(file => file.split('/').slice(0, 5).join('/')),
);
for (const feature of [...features].sort()) {
  const source =
    files.find(file => file.startsWith(`${feature}/`) && file.endsWith('.tsx')) ??
    files.find(file => file.startsWith(`${feature}/`))!;
  add(
    'S',
    `feature ${feature.split('/').at(-1)}`,
    source,
    1,
    `feature folder ${feature}; individual named surfaces are listed separately`,
  );
}

// SQLite's durable sidecars are written by the engine rather than by an explicit writeFile call.
for (const row of [...rows].filter(row => row.kind === 'F' && /\.sqlite$/.test(row.what))) {
  const [file, line] = row.source.split(/:(?=\d+$)/);
  for (const suffix of ['-wal', '-shm'])
    add(
      'F',
      `${row.what}${suffix}`,
      file!,
      Number(line),
      `SQLite engine sidecar; declared database=${row.what}; see sqliteDatabaseFiles in packages/daemon/src/lib/paths.ts`,
      row.owner,
    );
}

const columns: (keyof Row)[] = [
  'id',
  'kind',
  'what',
  'source',
  'todayOwner',
  'owner',
  'name5',
  'descriptor',
  'check',
  'status',
];
const previous = new Map<string, Row>();
const next: Record<Kind, number> = { R: 1, V: 1, T: 1, S: 1, J: 1, F: 1 };
if (existsSync(tsvPath)) {
  const [header, ...lines] = readFileSync(tsvPath, 'utf8').trimEnd().split('\n');
  if (header !== columns.join('\t')) throw new Error('Unexpected TSV schema; preserve the ID/status registry');
  for (const line of lines) {
    const values = line.split('\t');
    const row = Object.fromEntries(columns.map((key, index) => [key, values[index] ?? ''])) as unknown as Row;
    previous.set(rowKey(row), row);
    next[row.kind] = Math.max(next[row.kind], Number(row.id.slice(2)) + 1);
  }
}
const unique = new Map<string, Row>();
for (const row of rows.sort((a, b) => rowKey(a).localeCompare(rowKey(b)))) {
  const key = rowKey(row);
  const existing = unique.get(key);
  if (existing) {
    if (existing.descriptor !== row.descriptor) existing.descriptor += `; other declaration: ${row.descriptor}`;
    continue;
  }
  const old = previous.get(key);
  row.id = old?.id ?? `${row.kind}-${String(next[row.kind]++).padStart(4, '0')}`;
  if (old && !row.status.startsWith('removed by design') && !old.status.startsWith('removed by design'))
    row.status = old.status;
  unique.set(key, row);
}
const inventory = [...unique.values()].sort(
  (a, b) =>
    owners.indexOf(a.owner) - owners.indexOf(b.owner) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
);
const clean = (value: string) => value.replace(/[\t\r\n]+/g, ' ');
const tsv = `${columns.join('\t')}\n${inventory.map(row => columns.map(key => clean(row[key])).join('\t')).join('\n')}\n`;
const escaped = (value: string) => clean(value).replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const count = (kind: Kind, owner?: string) =>
  inventory.filter(row => row.kind === kind && (!owner || row.owner === owner)).length;
const removed = inventory.filter(row => row.status.startsWith('removed by design')).length;
const unplaced = inventory.filter(row => row.owner === 'UNPLACED');
const out: string[] = [
  '# Ferretry 5.0 rebuild parity',
  '',
  'Generated by `scripts/rebuild/parity.ts`. Do not add inventory rows by hand. Update status in the TSV, then regenerate; IDs and status survive regeneration.',
  '',
  `Reference commit: \`${sourceHead}\`. Tracked product-source SHA-256: \`${digest.digest('hex')}\`.`,
  '',
  'Install the isolated syntax parser first: `bun install --cwd scripts/rebuild`. Reproduce: `bun scripts/rebuild/parity.ts --source ../rebuild-ref`. Validate without writing: append `--check`.',
  '',
  'Generator regression checks: `bun test scripts/rebuild/parity.test.ts` (first observe the team’s single-test-process limit). The fixture uses a temporary source repository and an untouched temporary FY_HOME; it proves that production imports and command actions never run.',
  '',
  'Generator typecheck: `bun run --cwd scripts/rebuild typecheck` (the isolated TypeScript 6 parser API, with strict indexed-access checks).',
  '',
  `**${inventory.length} rows; ${removed} removed by design; ${unplaced.length} unplaced owners.**`,
  '',
  '<!-- prettier-ignore -->',
  '| Kind | Count |',
  '| --- | ---: |',
  ...Object.entries(kindNames).map(([kind, name]) => `| ${kind}: ${name} | ${count(kind as Kind)} |`),
  '',
  '<!-- prettier-ignore -->',
  '| 5.0 owner | R | V | T | S | J | F | Total |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...owners.map(
    owner =>
      `| ${owner} | ${(['R', 'V', 'T', 'S', 'J', 'F'] as Kind[]).map(kind => count(kind, owner)).join(' | ')} | ${inventory.filter(row => row.owner === owner).length} |`,
  ),
  '',
  '## Reading the inventory',
  '',
  '- Ownership follows redesign §8 and the split responsibilities in §2.3. The 5.0 name follows §1.4; item commands fan out per item kind.',
  '- A check names the test the port must add; it is a requirement, not a claim that a test already exists. Every kept row begins unchecked.',
  '- Route descriptors come from syntax, resolving constant objects and spreads. An absent boolean is false; absent capability/remedy is none; missing required fields are shown explicitly. Member routes retain their separate `needs` descriptor.',
  '- Jobs count source sites, including adapter schedulers, one-shot/backoff timers and lifecycle arming calls. Multiple sites can participate in one runtime job.',
  '- Files are source declarations and parameterized path families, never a scan of a real home. Relative families retain their symbolic root and confinement-review note. Several modules may declare the same file.',
  '- Removed rows cite a section that explicitly deletes the old behavior/file. A rename or moved feature remains required. No converter is authorized by this list (§9.1).',
  '',
  '## Unplaced rows',
  '',
  ...(unplaced.length ? unplaced.map(row => `- ${row.id}: ${escaped(row.what)} (${row.source})`) : ['None.']),
  '',
  '## Extraction diagnostics',
  '',
  ...(warnings.size
    ? [...warnings].sort().map(warning => `- ${escaped(warning)}`)
    : ['No unresolved Commander declarations.']),
  '',
];
for (const owner of [...owners, ...(unplaced.length ? ['UNPLACED'] : [])]) {
  const owned = inventory.filter(row => row.owner === owner);
  if (!owned.length) continue;
  out.push(
    `## ${owner} (${owned.length})`,
    '',
    '<!-- prettier-ignore -->',
    '| id | Kind | Today | Today’s source | Today’s module | 5.0 owner package | 5.0 name | Descriptor / detail | Check to add | Status |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const row of owned)
    out.push(
      `| ${[row.id, row.kind, row.what, row.source, row.todayOwner, packagePath(row.owner), row.name5, row.descriptor, row.check, row.status].map(escaped).join(' | ')} |`,
    );
  out.push('');
}
const markdown = `${out.join('\n').trimEnd()}\n`;
if (args.includes('--check')) {
  if (
    !existsSync(markdownPath) ||
    readFileSync(markdownPath, 'utf8') !== markdown ||
    !existsSync(tsvPath) ||
    readFileSync(tsvPath, 'utf8') !== tsv
  )
    throw new Error('Parity artifacts differ. Regenerate with the same reference tree.');
} else {
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(markdownPath, markdown);
  writeFileSync(tsvPath, tsv);
}
console.log(
  JSON.stringify(
    {
      reference: sourceHead,
      total: inventory.length,
      counts: Object.fromEntries(Object.keys(kindNames).map(kind => [kind, count(kind as Kind)])),
      unplaced: unplaced.length,
      removed,
      diagnostics: [...warnings],
    },
    null,
    2,
  ),
);
