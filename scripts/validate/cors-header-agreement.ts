/**
 * CORS-header agreement: a header the browser code can send must be one the transport admits.
 *
 * ## THE DEFECT
 *
 * `x-ferretry-operator-unlock` became part of every governed mutation the operator password
 * authorizes — applying a fleet proposal, unlocking or locking a grant — and nothing added it to
 * `CORS_REQUEST_HEADERS` in `packages/daemon/src/adapters/api/bun-api-server.ts`. The consequence was
 * not a degraded header, it was an unreachable route: `corsPreflight` refused the whole `OPTIONS`,
 * the refusal carried no `access-control-allow-origin`, and the mutation never left Chrome. The
 * hosted PWA could not apply a fleet proposal or change a grant at all.
 *
 * Every tier stayed green through it. The browser's own tests send their headers to a fixture that
 * answers whatever it is asked, and the daemon's tests exercise the transport with the headers the
 * transport already knows. Two lists have to agree and nothing was in a position to notice they had
 * stopped agreeing — the same shape `route-agreement` and `closed-set-agreement` exist for.
 *
 * ## WHAT IT PROVES, IN BOTH DIRECTIONS
 *
 *   unadmitted  the browser code can present a header the preflight refuses. A shipped dead route:
 *               the request never leaves the browser, and the failure reads as a CORS misconfiguration
 *               at an origin the daemon does in fact allow.
 *   unsent      the transport admits a header no browser code can present. Cheaper, never free: an
 *               allowlist that grows speculatively stops being a reachability gate and becomes a wish
 *               list. It costs an allowlist line with a reason, exactly like an unreached route.
 *
 * ## WHAT IT CANNOT PROVE — READ THIS BEFORE QUOTING A GREEN RUN
 *
 * **The observation set is header names of the `x-` shape.** That is this repository's convention for
 * every custom header it defines, and it is what makes the pass exact rather than a guess about which
 * string in a source file is a header name. A future client that sends a NON-`x-` header — an
 * `if-none-match`, a `prefer` — is outside what this pass can see, and it would break in production
 * exactly the way the unlock header did. Extending the observation set means reading the argument of
 * every `headers.set` and the keys of every `headers:` object, which is `route-agreement`-grade
 * expression parsing rather than the literal pass below.
 *
 * **It proves the two lists agree, not that a request works.** Being admitted by the preflight says
 * nothing about authentication, about grants, or about whether a browser can reach the address at all
 * — Chrome gates a public page's request to a loopback address behind a permission the daemon has no
 * say in. "CORS header agreement passed" must never be reported as "the browser can call this".
 *
 * **A string literal is read as code only.** Comments are skipped, so prose naming a header is not a
 * sender. A quote inside a regular-expression literal can still open a false span, bounded to that
 * one line because a non-template string may not cross a newline; the sibling gates accept the same
 * bound for the same reason.
 *
 * ## WHAT IT DELIBERATELY DOES NOT ASK
 *
 * Whether anything SENDS a header the daemon READS. `x-fy-warden-capability` is read by the
 * dispatcher and produced by nothing in this repository, which is dead protocol surface rather than a
 * transport disagreement, and folding it in here would make one gate answer two questions.
 *
 * ## HOW IT READS THE CODE
 *
 *     bun scripts/validate/cors-header-agreement.ts <repo-root> <allowlist-file>
 *
 * Client-sendable names come from the string literals of `packages/pwa/src` and
 * `packages/protocol/src` — the two trees a browser bundle is built from. A header constant is
 * declared as a literal in one of them, so collecting literals collects both the constants and the
 * names written inline at a `fetch`.
 *
 * The admitted names come from the sole `CORS_REQUEST_HEADERS = new Set([...])` in the daemon's HTTP
 * adapter, read as literals. Anything this pass cannot read exactly — a missing marker, a second one,
 * a computed member — is a hard failure rather than an empty set, because a gate that silently
 * observes nothing reports agreement.
 */

import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const USAGE = 'usage: cors-header-agreement.ts <repo-root> <allowlist-file>';

/** The trees a browser bundle is built from, and therefore what a browser can send. */
const CLIENT_SOURCES = ['packages/pwa/src', 'packages/protocol/src'] as const;
const TRANSPORT_FILE = 'packages/daemon/src/adapters/api/bun-api-server.ts';
const TRANSPORT_MARKER = 'CORS_REQUEST_HEADERS';
/** This repository's shape for every custom header it defines. See the observation-set limit above. */
const HEADER_SHAPE = /^x-[a-z0-9-]+$/u;

type Direction = 'unadmitted' | 'unsent';

interface Finding {
  readonly direction: Direction;
  readonly header: string;
  /** Where a reader can see it, so a finding is a coordinate rather than a claim. */
  readonly at: string;
}

interface AllowEntry {
  readonly direction: Direction;
  readonly header: string;
  readonly reason: string;
  readonly line: number;
}

interface Literal {
  readonly value: string;
  readonly offset: number;
}

function fail(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(2);
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let at = 0; at < offset && at < text.length; at += 1) if (text[at] === '\n') line += 1;
  return line;
}

/**
 * Source with comments, regex bodies and string bodies blanked, and every offset preserved.
 *
 * PORTED FROM `route-agreement.ts`, INCLUDING THE TWO THINGS IT LEARNED THE HARD WAY, because both
 * bit this gate on its first run against real sources. A hand-rolled scan that only knew comments and
 * strings desynced at `packages/pwa/src/lib/tool-extract.ts:58`, where a regex matches BACKTICKS
 * (`` /cmd\s*:\s*`([^`]+)`/ ``): its third backtick opened a template literal that ran 330 lines to
 * the next one, and the gate reported an unterminated template rather than the headers it was asked
 * about. Half the PWA is `.tsx`, where `<Icon aria-hidden="true" />` puts a `/` where the textbook
 * rule expects a regex, so the regex test has to read what came before it.
 *
 * The blanking may only ever replace a character with another character: this pass reads a literal's
 * VALUE out of the original text at an offset found in the cleaned text, and a length change would
 * make every later coordinate a lie.
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
  /** Written over code units, so one astral character cannot shift every offset after it by one. */
  const blank = (span: string): void => {
    let text = '';
    for (let at = 0; at < span.length; at += 1) text += span[at] === '\n' ? '\n' : ' ';
    out += text;
  };
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
      index = Math.min(index, source.length);
      const span = source.slice(start, index);
      // One character stands in for the whole literal, so the expression still reads as a value.
      emit('0');
      blank(span.slice(1));
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
        // JSX TEXT would otherwise open a string that swallows the rest of the file.
        if (character !== '`' && source[index] === '\n') break;
        index += 1;
      }
      if (source[index] !== character) {
        index = start + 1;
        emit(character);
        continue;
      }
      index = Math.min(index + 1, source.length);
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

/**
 * Every string literal of the cleaned source, valued from the original.
 *
 * A literal is a matched pair of quote characters in the CLEANED text — where a comment, a regex body
 * and a nested substitution have all been blanked, so a quote that survives is a real delimiter — and
 * its value is read from the ORIGINAL at those offsets. That is what makes a header inside a doc
 * comment prose rather than a sender.
 */
function literalsOf(file: string, source: string): Literal[] {
  const cleaned = clean(source);
  if (cleaned.length !== source.length) fail(`${file}: the lexer changed the file length and every offset with it`);
  return pairedLiterals(cleaned, source);
}

/** The matched quote pairs of an already-cleaned span, valued from the original span. */
function pairedLiterals(cleaned: string, source: string): Literal[] {
  const literals: Literal[] = [];
  let index = 0;
  while (index < cleaned.length) {
    const character = cleaned[index];
    if (character !== "'" && character !== '"' && character !== '`') {
      index += 1;
      continue;
    }
    const end = cleaned.indexOf(character, index + 1);
    if (end < 0) {
      // An unterminated quote in cleaned text is a lone delimiter the cleaner already declined to
      // pair, which is code rather than a literal.
      index += 1;
      continue;
    }
    literals.push({ value: source.slice(index + 1, end), offset: index });
    index = end + 1;
  }
  return literals;
}

function filesUnder(root: string, relativeDirectory: string): string[] {
  const absolute = resolve(root, relativeDirectory);
  if (!existsSync(absolute)) fail(`missing client source tree: ${relativeDirectory}`);
  const listed = new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: absolute, absolute: true, onlyFiles: true });
  const files = [...listed].map(path => relative(root, path)).sort();
  if (files.length === 0) fail(`no sources under ${relativeDirectory} — this pass would observe nothing`);
  return files;
}

/** Header names the browser code can present, each with the first place a reader can see it. */
function clientHeaders(root: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const tree of CLIENT_SOURCES) {
    for (const file of filesUnder(root, tree)) {
      const text = readFileSync(resolve(root, file), 'utf8');
      for (const literal of literalsOf(file, text)) {
        const header = literal.value.toLowerCase();
        if (!HEADER_SHAPE.test(header) || found.has(header)) continue;
        found.set(header, `${file}:${lineAt(text, literal.offset)}`);
      }
    }
  }
  return found;
}

/**
 * The transport's admitted set, read as literals from its sole declaration.
 *
 * Fails on anything it cannot read exactly. A gate that shrugged at a computed member would compare
 * the client's headers against a set smaller than the one the daemon enforces, and report agreement
 * about elements it never saw.
 */
function admittedHeaders(root: string): Map<string, string> {
  const file = TRANSPORT_FILE;
  const absolute = resolve(root, file);
  if (!existsSync(absolute)) fail(`missing transport file: ${file}`);
  const text = readFileSync(absolute, 'utf8');
  const cleaned = clean(text);
  if (cleaned.length !== text.length) fail(`${file}: the lexer changed the file length and every offset with it`);

  // Searched in the CLEANED text, so the paragraph above the declaration naming it is prose.
  const declaration = `const ${TRANSPORT_MARKER} = new Set([`;
  const at = cleaned.indexOf(declaration);
  if (at < 0) fail(`${file}: no "${declaration}" — the admitted set could not be read`);
  if (cleaned.indexOf(declaration, at + 1) >= 0) fail(`${file}: two declarations of ${TRANSPORT_MARKER}`);

  const open = at + declaration.length - 1;
  const close = cleaned.indexOf('])', open);
  if (close < 0) fail(`${file}:${lineAt(text, at)}: unterminated ${TRANSPORT_MARKER} array`);

  const body = cleaned.slice(open + 1, close);
  const literals = pairedLiterals(body, text.slice(open + 1, close));
  const members = body
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry !== '');
  if (members.length !== literals.length) {
    fail(`${file}:${lineAt(text, at)}: ${TRANSPORT_MARKER} holds a member this pass cannot read as a literal`);
  }
  if (literals.length === 0) fail(`${file}:${lineAt(text, at)}: ${TRANSPORT_MARKER} is empty`);

  const admitted = new Map<string, string>();
  for (const literal of literals) {
    admitted.set(literal.value.toLowerCase(), `${file}:${lineAt(text, open + 1 + literal.offset)}`);
  }
  return admitted;
}

function parseAllowlist(path: string, displayPath: string): AllowEntry[] {
  const entries: AllowEntry[] = [];
  const seen = new Map<string, number>();
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((raw, index) => {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) return;
      const match = /^(unadmitted|unsent)\s+(\S+)\s*#\s*(.+)$/u.exec(line);
      if (match === null) {
        fail(`${displayPath}:${index + 1}: every entry is "<unadmitted|unsent> <header> # <reason>" with a reason`);
      }
      const [, direction, header, reason] = match as unknown as [string, Direction, string, string];
      const key = `${direction} ${header.toLowerCase()}`;
      const prior = seen.get(key);
      if (prior !== undefined) fail(`${displayPath}:${index + 1}: duplicate exemption ${key} (first at line ${prior})`);
      seen.set(key, index + 1);
      entries.push({ direction, header: header.toLowerCase(), reason: reason.trim(), line: index + 1 });
    });
  return entries;
}

function main(): void {
  const [rootArgument, allowlistArgument] = process.argv.slice(2);
  if (rootArgument === undefined || allowlistArgument === undefined) fail(USAGE);
  const root = resolve(rootArgument);
  const allowlistPath = resolve(allowlistArgument);
  if (!existsSync(allowlistPath)) fail(`missing cors-header-agreement allowlist: ${allowlistArgument}`);
  const displayAllowlist = relative(root, allowlistPath);
  const allowed = parseAllowlist(allowlistPath, displayAllowlist);

  const client = clientHeaders(root);
  const admitted = admittedHeaders(root);

  const findings: Finding[] = [];
  for (const [header, at] of [...client].sort(([left], [right]) => left.localeCompare(right))) {
    if (!admitted.has(header)) findings.push({ direction: 'unadmitted', header, at });
  }
  for (const [header, at] of [...admitted].sort(([left], [right]) => left.localeCompare(right))) {
    if (!HEADER_SHAPE.test(header) || client.has(header)) continue;
    findings.push({ direction: 'unsent', header, at });
  }

  const exempt = new Set(allowed.map(entry => `${entry.direction} ${entry.header}`));
  const unexplained = findings.filter(finding => !exempt.has(`${finding.direction} ${finding.header}`));
  const claimed = new Set(findings.map(finding => `${finding.direction} ${finding.header}`));
  const stale = allowed.filter(entry => !claimed.has(`${entry.direction} ${entry.header}`));

  for (const finding of unexplained) {
    if (finding.direction === 'unadmitted') {
      console.error(
        `❌ ${finding.at}: the browser can send "${finding.header}" and the preflight refuses it — the request never leaves the browser. Add it to ${TRANSPORT_MARKER} in ${TRANSPORT_FILE}, or exempt it in ${displayAllowlist} with a reason.`,
      );
    } else {
      console.error(
        `❌ ${finding.at}: ${TRANSPORT_MARKER} admits "${finding.header}" and no browser code sends it. Remove it, or exempt it in ${displayAllowlist} with a reason — an allowlist that grows speculatively is a wish list, not a gate.`,
      );
    }
  }
  for (const entry of stale) {
    console.error(
      `❌ ${displayAllowlist}:${entry.line}: stale exemption "${entry.direction} ${entry.header}" — the disagreement it describes is gone, so the line must go with it.`,
    );
  }
  if (unexplained.length > 0 || stale.length > 0) process.exit(1);

  const exemptCount = allowed.length === 0 ? '' : `, ${allowed.length} exempt`;
  console.log(
    `✅ CORS header agreement: ${client.size} client header${client.size === 1 ? '' : 's'} against ${admitted.size} admitted${exemptCount}`,
  );
}

main();
