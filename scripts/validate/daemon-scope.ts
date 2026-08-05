/**
 * Daemon-scoping gate for the PWA.
 *
 * ONE BROWSER, SEVERAL DAEMONS. A Ferretry reader can be paired to more than one daemon at once,
 * and the ids that daemons mint — session ids, task ids, pin ids, board ids — are unique only
 * WITHIN the daemon that minted them. Two daemons therefore routinely hand the same browser the
 * same id for different things. Anything the browser remembers about daemon-owned data must be
 * keyed by `(daemonId, …)`, or the second daemon reads the first daemon's answer.
 *
 * This has been true for the whole migration and it has been carried by hand: every unit brief
 * repeats "key everything by (daemonId, …)", `docs/migration/surveys/pwa-shape.md` lists 56
 * single-daemon assumptions with file:line, and surfaces were still being found by eye. An
 * invariant that depends on every author remembering it is not an invariant. This is the gate that
 * makes it one.
 *
 * Three passes, each catching a different way a surface goes unscoped:
 *
 *   RETAIN     Module-scope mutable state that remembers daemon-owned data must key through
 *              `daemonSessionKey()`. A module-level `Map<string, …>` keyed by a bare session id is
 *              the original bug: session `abc` on daemon A and session `abc` on daemon B collide
 *              in one entry, and whichever rendered last wins.
 *
 *   ACCESS     A module that opens a socket or a request to a daemon must carry a
 *              `DaemonConnection`. That type is the only thing in the PWA that pairs an origin
 *              with the device token minted for it; a module that assembles a URL from parts has
 *              no daemon identity to be scoped BY.
 *
 *   INVALIDATE A class that declares `clearDaemon()` has declared itself daemon-scoped state. It
 *              must be registered with the connection registry, which is what calls `clearDaemon`
 *              on unpair, eviction, and credential rotation. An unregistered one keeps serving the
 *              old daemon's records after the reader has unpaired it — the same "damaged state
 *              read as ordinary state" failure this project has now shipped three times.
 *
 * WHY THIS IS NOT A GREP FOR `daemonId`. It has been tried in this repo and it fails open: a file
 * that merely MENTIONS the word in a comment passes, and `no-legacy-state.sh` has been bitten by
 * exactly that class of mistake. Every check here is made against cleaned source — comments blanked
 * and string bodies emptied before a single pattern is matched — and asks a structural question
 * (what is this map keyed BY, does this class reach the registry) rather than a lexical one.
 *
 * The pass is deliberately conservative in one direction only: when it cannot ANALYSE a binding —
 * because the container escapes into a function it cannot follow — it demands an allowlist line
 * rather than assuming the benign reading. Fail closed, including about itself.
 */

import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const USAGE = 'usage: daemon-scope.ts <repo-root> <allowlist-file>';

/** Every pass is scoped to the browser bundle: this is the only place a daemon is a runtime value. */
const SCANNED_ROOT = 'packages/pwa/src';

/** The single seam that turns a `(daemonId, sessionId)` scope into a collision-safe key string. */
const KEY_PRODUCERS = ['daemonSessionKey', 'daemonSessionScope'] as const;

/**
 * The one type that pairs a daemon origin with the device token minted for it. It is matched as an
 * IDENTIFIER in cleaned source, not as an import path: paths live inside string literals, whose
 * bodies this gate blanks precisely so a name in a comment or a message can never stand in for a
 * name in the code.
 */
const CONNECTION_TYPE = /\bDaemonConnection\b/u;

/** The composition root that owns document-lifetime stores and registers them for invalidation. */
const STORE_MODULE = 'packages/pwa/src/lib/store.tsx';

type PassName = 'retain' | 'access' | 'invalidate';

interface Violation {
  readonly pass: PassName;
  /** The allowlist target that would silence this finding, verbatim. */
  readonly target: string;
  readonly where: string;
  readonly why: string;
}

interface AllowEntry {
  readonly pass: PassName;
  readonly target: string;
  readonly reason: string;
  readonly line: number;
}

// ─── lexing ───────────────────────────────────────────────────────────────────────────────────

/**
 * Source with comments and string bodies removed, and every line number preserved.
 *
 * Line preservation is load-bearing: a violation reports a `file:line` a reader opens, so the
 * cleaner may only ever replace a character with another character or a space — never delete a
 * newline, and never collapse a block comment to a single token the way the reachability walker
 * does (it needs a module graph, not coordinates).
 *
 * String BODIES go rather than whole literals so `'…'` still reads as an expression to the brace
 * and argument scanners below, while no identifier inside a message can be mistaken for code.
 */
function clean(source: string): string {
  let out = '';
  let index = 0;
  let previousSignificant = '';
  /** The significant character before `previousSignificant`; only `=>` needs it. */
  let priorSignificant = '';

  const emit = (text: string): void => {
    out += text;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    priorSignificant = trimmed.length > 1 ? trimmed.slice(-2, -1) : previousSignificant;
    previousSignificant = trimmed.slice(-1);
  };
  /** Replace a consumed span with spaces, preserving its newlines and therefore its line numbers. */
  const blank = (span: string): void => {
    out += span.replace(/[^\n]/gu, ' ');
  };

  /**
   * True when a `/` here opens a regex literal rather than dividing or closing a JSX tag.
   *
   * The quote and angle-bracket cases are why this is not the textbook version. Half the bundle is
   * `.tsx`, where `<Icon aria-hidden="true" />` and `</div>` both put a `/` after a character the
   * textbook rule reads as "an operator can't precede a regex, so this must be one" — and the
   * mis-lexed regex then eats to the next `/` or newline. It desynced 39 files before the
   * balance tripwire caught it, and a desynced file is not under-analysed, it is CONFIDENTLY
   * mis-analysed: every construct after the desync reads as nested and is never examined at all.
   *
   * `>` alone is not enough to decide, which is why the character before it is tracked: a body that
   * opens `=> /^…/.test(value)` is an arrow returning a regex, and reading its `[` as a real bracket
   * desynced the one file the first version of this rule still got wrong.
   */
  const startsRegex = (): boolean => {
    if (previousSignificant === '') return true;
    if (previousSignificant === '>') return priorSignificant === '=';
    return !/[)\]}\w$'"`<]/u.test(previousSignificant);
  };

  while (index < source.length) {
    const character = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (character === '/' && next === '/') {
      const start = index;
      while (index < source.length && source[index] !== '\n') index += 1;
      blank(source.slice(start, index));
      continue;
    }

    if (character === '/' && next === '*') {
      const start = index;
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index = Math.min(index + 2, source.length);
      blank(source.slice(start, index));
      continue;
    }

    if (character === '/' && startsRegex()) {
      const start = index;
      index += 1;
      let inClass = false;
      while (index < source.length) {
        const current = source[index];
        if (current === '\\') {
          index += 2;
          continue;
        }
        if (current === '\n') break;
        if (current === '[') inClass = true;
        else if (current === ']') inClass = false;
        else if (current === '/' && !inClass) break;
        index += 1;
      }
      index += 1;
      while (index < source.length && /[a-z]/u.test(source[index] ?? '')) index += 1;
      blank(source.slice(start, index));
      emit('0');
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      const start = index;
      index += 1;
      while (index < source.length && source[index] !== character) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        // A quoted string closes on its own line; only a template may cross one. An apostrophe in
        // JSX TEXT — `<p>the daemon's answer</p>`, which is ordinary markup, not a literal — would
        // otherwise open a string that swallows the rest of the file and hides whatever is in it.
        if (character !== '`' && source[index] === '\n') break;
        index += 1;
      }
      if (source[index] !== character) {
        // Unterminated: it was not a delimiter. Emit it as the plain character it is.
        index = start + 1;
        emit(character);
        continue;
      }
      index = Math.min(index + 1, source.length);
      // Keep the quotes as a two-character expression and blank everything between them, so a
      // multi-line template contributes exactly the newlines it occupied.
      const span = source.slice(start, index);
      emit(character);
      blank(span.slice(1, -1));
      emit(character);
      continue;
    }

    emit(character);
    index += 1;
  }
  return out;
}

/** Brace depth at the START of each line of `text`, 0-indexed. Depth 0 is module scope. */
function braceDepths(text: string): number[] {
  const depths: number[] = [];
  let depth = 0;
  for (const line of text.split('\n')) {
    depths.push(depth);
    for (const character of line) {
      if (character === '{' || character === '(' || character === '[') depth += 1;
      else if (character === '}' || character === ')' || character === ']') depth -= 1;
    }
  }
  return depths;
}

/**
 * Depth after the last line. A tripwire, not a measurement.
 *
 * Every pass here decides what module scope is by counting brackets in cleaned source, so a lexer
 * that mis-parsed one construct — a quote it took for a delimiter, a regex it took for a division —
 * does not report a wrong answer, it reports a CONFIDENT wrong answer: the desynced region reads as
 * nested, and nothing nested is ever examined. A file that does not close every bracket it opened
 * is the signature of exactly that, and it exits 2 rather than passing quietly.
 */
function finalDepth(text: string): number {
  let depth = 0;
  for (const character of text) {
    if (character === '{' || character === '(' || character === '[') depth += 1;
    else if (character === '}' || character === ')' || character === ']') depth -= 1;
  }
  return depth;
}

/**
 * The argument list of `text.slice(open)`, where `open` indexes the `(`, split at top-level commas.
 * Returns an empty array when the call is unterminated, which a syntactically valid file never is.
 */
function callArguments(text: string, open: number): string[] {
  let depth = 0;
  let current = '';
  const args: string[] = [];
  for (let index = open; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (character === '(' || character === '[' || character === '{') {
      depth += 1;
      if (depth === 1) continue;
    } else if (character === ')' || character === ']' || character === '}') {
      depth -= 1;
      if (depth === 0) {
        args.push(current);
        return args;
      }
    } else if (character === ',' && depth === 1) {
      args.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  return [];
}

// ─── pass: RETAIN ─────────────────────────────────────────────────────────────────────────────

/** Member calls that read or write a keyed container by key. */
const KEYED_CALLS = ['get', 'set', 'has', 'delete'] as const;
/** Member calls that prove a container is mutable rather than a frozen lookup table. */
const MUTATING_CALLS = ['set', 'add', 'delete', 'clear', 'push', 'pop', 'splice', 'unshift', 'shift'] as const;

type ContainerKind = 'map' | 'set' | 'literal' | 'singleton';

interface ModuleBinding {
  readonly name: string;
  readonly line: number;
  readonly container: ContainerKind;
}

const CONTAINER_DECLARATION =
  /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(new\s+(?:Map|WeakMap)\b|new\s+(?:Set|WeakSet)\b|\{\s*\}|\[\s*\])/u;
const SINGLETON_DECLARATION = /^(?:export\s+)?(?:let|var)\s+([A-Za-z_$][\w$]*)/u;

/** Module-scope bindings that could retain daemon-owned data across renders. */
function moduleBindings(cleaned: string): ModuleBinding[] {
  const lines = cleaned.split('\n');
  const depths = braceDepths(cleaned);
  const found: ModuleBinding[] = [];
  lines.forEach((line, index) => {
    if (depths[index] !== 0) return;
    const container = CONTAINER_DECLARATION.exec(line);
    if (container?.[1] !== undefined) {
      const initializer = container[2] ?? '';
      const kind: ContainerKind = initializer.includes('Map') ? 'map' : initializer.includes('Set') ? 'set' : 'literal';
      found.push({ name: container[1], line: index + 1, container: kind });
      return;
    }
    const singleton = SINGLETON_DECLARATION.exec(line);
    if (singleton?.[1] !== undefined) found.push({ name: singleton[1], line: index + 1, container: 'singleton' });
  });
  return found;
}

/**
 * Identifiers in this file whose value is, or produces, a `daemonSessionKey`.
 *
 * The initializer is read forward to the statement's own `;` at depth zero rather than to the end
 * of the line, so a multi-line arrow still resolves — and, more importantly, one declaration can
 * never swallow the next. A greedy multi-line initializer silently hid EVERY
 * `const key = daemonSessionKey(scope)` in four already-correct modules the first time this was
 * written, which would have made the gate demand exemptions for code that was right.
 */
function keyProducers(cleaned: string): ReadonlySet<string> {
  const producers = new Set<string>(KEY_PRODUCERS);
  const declaration = /(?:^|[\s(])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=(?!=)/gu;
  const initializers: Array<readonly [string, string]> = [];
  for (const match of cleaned.matchAll(declaration)) {
    const name = match[1];
    if (name === undefined) continue;
    const start = (match.index ?? 0) + match[0].length;
    let depth = 0;
    let end = start;
    while (end < cleaned.length) {
      const character = cleaned[end];
      if (character === '(' || character === '[' || character === '{') depth += 1;
      else if (character === ')' || character === ']' || character === '}') {
        if (depth === 0) break;
        depth -= 1;
      } else if (character === ';' && depth === 0) break;
      end += 1;
    }
    initializers.push([name, cleaned.slice(start, end)]);
  }
  // Two rounds so a key helper defined in terms of another one still resolves.
  for (let round = 0; round < 2; round += 1) {
    for (const [name, initializer] of initializers) {
      if ([...producers].some(producer => initializer.includes(`${producer}(`))) producers.add(name);
    }
  }
  // A key iterated out of a container's own `.keys()` is already one of that container's keys, so
  // it is a daemon key whenever the container is daemon-keyed. This is how every `clearDaemon`
  // sweep is written — read the keys, decode the daemon, delete the matches — and it must not be
  // the one shape the gate cannot express.
  for (const match of cleaned.matchAll(/for\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s+([^)]*\.keys\s*\()/gu)) {
    if (match[1] !== undefined) producers.add(match[1]);
  }
  return producers;
}

/** Whether every keyed access to `name` goes through a daemon key, and it never escapes unanalysed. */
function retentionVerdict(
  cleaned: string,
  binding: ModuleBinding,
  producers: ReadonlySet<string>,
): { readonly mutated: boolean; readonly proven: boolean; readonly why: string } {
  // A container handed to another function is mutated somewhere this pass cannot see. That counts
  // as mutation for MAP-LIKE bindings, which exist to be written to; a `{}` or `[]` default that is
  // only ever passed along is an ordinary frozen constant and is not read as one.
  const escaped = new RegExp(`[(,]\\s*${binding.name}\\s*[,)]`, 'u').test(cleaned);
  const reassigned = new RegExp(`^\\s*${binding.name}\\s*=[^=]`, 'mu').test(cleaned);
  const indexWrite = new RegExp(`${binding.name}\\[[^\\]]*\\]\\s*=[^=]`, 'u').test(cleaned);
  const mutatingCall = MUTATING_CALLS.some(call =>
    new RegExp(`\\b${binding.name}\\.${call}\\s*\\(`, 'u').test(cleaned),
  );
  const unanalysable = escaped && binding.container !== 'literal';
  // A module-scope `let` is a document-lifetime singleton whether or not this pass can spot the
  // write: `+=`, `++`, and a write from a nested closure all reassign it. Reading "no visible
  // assignment" as "immutable" would be the benign assumption, and this gate does not make those.
  const mutated = binding.container === 'singleton' || reassigned || indexWrite || mutatingCall || unanalysable;
  if (!mutated) return { mutated: false, proven: true, why: '' };

  if (unanalysable) {
    return {
      mutated,
      proven: false,
      why: `${binding.name} is passed to another function, so its keys cannot be read here`,
    };
  }
  if (binding.container !== 'map') {
    return { mutated, proven: false, why: `${binding.name} is module-scope mutable state with no daemon key` };
  }

  const unscoped: string[] = [];
  for (const call of KEYED_CALLS) {
    const pattern = new RegExp(`\\b${binding.name}\\.${call}\\s*\\(`, 'gu');
    for (const match of cleaned.matchAll(pattern)) {
      const open = (match.index ?? 0) + match[0].length - 1;
      const first = (callArguments(cleaned, open)[0] ?? '').trim();
      const keyed = [...producers].some(producer => first === producer || first.startsWith(`${producer}(`));
      if (!keyed) unscoped.push(`.${call}(${first.slice(0, 40)})`);
    }
  }
  if (unscoped.length > 0) {
    return {
      mutated,
      proven: false,
      why: `${binding.name} is keyed by something other than daemonSessionKey: ${[...new Set(unscoped)].join(', ')}`,
    };
  }
  return { mutated, proven: true, why: '' };
}

// ─── pass: ACCESS ─────────────────────────────────────────────────────────────────────────────

const NETWORK_CALLS = [/(?<![.\w])fetch\s*\(/u, /new\s+WebSocket\s*\(/u, /new\s+EventSource\s*\(/u, /sendBeacon\s*\(/u];

// ─── pass: INVALIDATE ─────────────────────────────────────────────────────────────────────────

/** Classes declaring `clearDaemon`, i.e. classes that have declared themselves daemon-scoped. */
function scopedCacheClasses(files: readonly string[], cleanedOf: (path: string) => string): Map<string, string> {
  const classes = new Map<string, string>();
  for (const path of files) {
    const cleaned = cleanedOf(path);
    const lines = cleaned.split('\n');
    const depths = braceDepths(cleaned);
    let current: string | null = null;
    lines.forEach((line, index) => {
      const declaration = /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/u.exec(line);
      if (depths[index] === 0 && declaration?.[1] !== undefined) current = declaration[1];
      if (current !== null && /^\s*(?:public\s+|readonly\s+)?clearDaemon\s*\(/u.test(line)) {
        classes.set(current, `${path}:${index + 1}`);
        current = null;
      }
    });
  }
  return classes;
}

/**
 * Class names the connection registry receives, resolved from the names in the `caches:` array.
 *
 * The array holds VARIABLES, so each one is traced back to the `new C(…)` that produced it — first
 * in the composition root, then across the bundle, because a store the composition root imports
 * rather than builds (a module default a component needs before React context exists) is registered
 * every bit as much as one built inline.
 */
function registeredCaches(storeSource: string, corpus: readonly string[]): ReadonlySet<string> {
  const cleanedStore = clean(storeSource);
  const registered = new Set<string>();
  const array = /caches:\s*\[([^\]]*)\]/u.exec(cleanedStore);
  if (array?.[1] === undefined) return registered;
  const names = array[1]
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry !== '');
  for (const name of names) {
    const construction = new RegExp(`\\b${name}\\s*(?::[^=]*)?=\\s*(?:await\\s+)?new\\s+([A-Za-z_$][\\w$]*)`, 'u');
    for (const source of [cleanedStore, ...corpus]) {
      const match = construction.exec(source);
      if (match?.[1] !== undefined) {
        registered.add(match[1]);
        break;
      }
    }
  }
  return registered;
}

// ─── allowlist ────────────────────────────────────────────────────────────────────────────────

function parseAllowlist(path: string): AllowEntry[] {
  const entries: AllowEntry[] = [];
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((raw, index) => {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) return;
      const match = /^(retain|access|invalidate)\s+(\S+)\s*#\s*(.+)$/u.exec(line);
      if (match === null) {
        console.error(
          `❌ ${path}:${index + 1}: every entry is "<retain|access|invalidate> <target> # <reason>" with a reason`,
        );
        process.exit(2);
      }
      const [, pass, target, reason] = match as unknown as [string, PassName, string, string];
      if (target.includes('*')) {
        console.error(`❌ ${path}:${index + 1}: globs are forbidden — one exact target per line`);
        process.exit(2);
      }
      entries.push({ pass, target, reason: reason.trim(), line: index + 1 });
    });
  return entries;
}

// ─── walk ─────────────────────────────────────────────────────────────────────────────────────

function main(): void {
  const [rootArgument, allowlistArgument] = process.argv.slice(2);
  if (rootArgument === undefined || allowlistArgument === undefined) {
    console.error(`❌ ${USAGE}`);
    process.exit(2);
  }
  const root = resolve(rootArgument);
  const allowlistPath = resolve(allowlistArgument);
  if (!existsSync(allowlistPath)) {
    console.error(`❌ missing daemon-scope allowlist: ${allowlistArgument}`);
    process.exit(2);
  }

  const scanned = resolve(root, SCANNED_ROOT);
  if (!existsSync(scanned)) {
    console.error(`❌ ${SCANNED_ROOT} does not exist — this gate has lost its subject, not its work`);
    process.exit(2);
  }

  const listed = new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: scanned, absolute: true, onlyFiles: true });
  const files = [...listed].map(path => relative(root, path)).sort();
  if (files.length === 0) {
    console.error(`❌ found no sources under ${SCANNED_ROOT} — refusing to report a vacuous pass`);
    process.exit(2);
  }
  const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');
  const sources = new Map(files.map(path => [path, clean(read(path))]));
  const cleanedOf = (path: string): string => sources.get(path) ?? '';

  const desynced = [...sources].filter(([, cleaned]) => finalDepth(cleaned) !== 0).map(([path]) => path);
  if (desynced.length > 0) {
    console.error('❌ the daemon-scope lexer desynced — every bracket it opened in these files never closed:');
    for (const path of desynced) console.error(`   ${path}`);
    console.error('   Fix the lexer. Its module-scope answers for these files are wrong, not merely incomplete.');
    process.exit(2);
  }

  const violations: Violation[] = [];

  for (const path of files) {
    const cleaned = cleanedOf(path);
    const producers = keyProducers(cleaned);

    for (const binding of moduleBindings(cleaned)) {
      const verdict = retentionVerdict(cleaned, binding, producers);
      if (verdict.mutated && !verdict.proven) {
        violations.push({
          pass: 'retain',
          target: `${path}:${binding.name}`,
          where: `${path}:${binding.line}`,
          why: verdict.why,
        });
      }
    }

    if (NETWORK_CALLS.some(pattern => pattern.test(cleaned)) && !CONNECTION_TYPE.test(cleaned)) {
      violations.push({
        pass: 'access',
        target: path,
        where: path,
        why: 'opens a request or socket without importing DaemonConnection, so it carries no daemon identity',
      });
    }
  }

  const classes = scopedCacheClasses(files, cleanedOf);
  const storePath = files.find(path => path === STORE_MODULE);
  if (storePath === undefined) {
    console.error(`❌ ${STORE_MODULE} is gone — the invalidate pass cannot find the cache registry`);
    process.exit(2);
  }
  const registered = registeredCaches(read(storePath), [...sources.values()]);
  if (registered.size === 0) {
    console.error(`❌ ${STORE_MODULE} no longer registers any daemon-scoped cache — the registry seam moved`);
    process.exit(2);
  }
  // A store that is CONSTRUCTED somewhere in the bundle and still unregistered is live state the
  // registry cannot reach. One that is constructed nowhere is an unmounted surface — a different
  // problem, owned by a different gate, and worth saying differently so nobody "fixes" it by
  // registering a class the product never builds.
  const built = new Set<string>();
  for (const path of files) {
    for (const match of cleanedOf(path).matchAll(/new\s+([A-Za-z_$][\w$]*)\s*\(/gu)) {
      if (match[1] !== undefined) built.add(match[1]);
    }
  }
  for (const [name, where] of [...classes].sort(([left], [right]) => left.localeCompare(right))) {
    if (registered.has(name)) continue;
    violations.push({
      pass: 'invalidate',
      target: name,
      where,
      why: built.has(name)
        ? `${name} declares clearDaemon and IS constructed in the bundle, but the connection registry never receives it — unpairing, evicting, or re-pairing a daemon leaves its records readable`
        : `${name} declares clearDaemon but nothing in ${SCANNED_ROOT} constructs it, so the surface is unmounted; register it in the change that mounts it`,
    });
  }

  // ─── reconcile against the allowlist ────────────────────────────────────────────────────────
  const allowed = parseAllowlist(allowlistPath);
  const allowedKeys = new Set(allowed.map(entry => `${entry.pass} ${entry.target}`));
  const matched = new Set<string>();
  const unallowed = violations.filter(violation => {
    const key = `${violation.pass} ${violation.target}`;
    if (allowedKeys.has(key)) {
      matched.add(key);
      return false;
    }
    return true;
  });

  const relativeAllowlist = relative(root, allowlistPath);
  const stale = allowed.filter(entry => !matched.has(`${entry.pass} ${entry.target}`));

  if (unallowed.length > 0) {
    console.error('❌ PWA surfaces are not daemon-scoped:');
    for (const violation of unallowed) {
      console.error(`   ${violation.where}`);
      console.error(`     ${violation.why}`);
      console.error(`     allow deliberately with: ${violation.pass} ${violation.target} # <why this is safe>`);
    }
    console.error(`   The rule and the reasoning: docs/standards/contracts/README.md#daemon-scoping`);
  }
  if (stale.length > 0) {
    console.error(`❌ ${relativeAllowlist} has entries that no longer describe anything:`);
    for (const entry of stale) console.error(`   ${relativeAllowlist}:${entry.line}: ${entry.pass} ${entry.target}`);
    console.error('   Delete the line in the same change that fixed it — a stale exemption silences the next bug.');
  }
  if (unallowed.length > 0 || stale.length > 0) process.exit(1);

  console.log(
    `✅ daemon scoping holds across ${files.length} PWA modules (${allowed.length} reviewed exemptions, ${classes.size} scoped caches)`,
  );
}

main();
