/**
 * Route-agreement gate: the two ends of every HTTP call must agree that the call exists.
 *
 * ## THE DEFECT
 *
 * `packages/pwa` called `/v1/push/vapid` and `/v1/push/subscriptions` for weeks. The daemon served
 * no push route at all. Both halves were green the entire time, because each half owned its own
 * fixture: the browser tested against a stub that answered, and the daemon tested the routes it
 * had. Nothing in the repository was in a position to notice that one program was calling an
 * address the other program does not answer at, and a shipped 404 is indistinguishable from a
 * benign empty case in every surface that renders it.
 *
 * The same shape in the other direction is cheaper but not free: a route nothing dials is either
 * dead code or an undocumented surface, and it costs an allowlist line with a reason.
 *
 * ## WHAT IT CANNOT PROVE — READ THIS BEFORE QUOTING A GREEN RUN
 *
 * **Route agreement proves the two ENDS of a call agree. It cannot prove the client is CAPABLE of
 * making it.** mika's finding, and it is the reason this paragraph is in the gate rather than only
 * in a review comment: `packages/pwa` has no service worker, so `pushManager.subscribe` cannot be
 * reached in a real browser no matter how many push routes the daemon mounts. A unit can therefore
 * land a validated wire that nothing can dial, with this gate green over it.
 *
 * The observation set itself has a deliberate boundary: a resolved path must contain a first segment
 * the daemon already serves. A dial under an entirely new namespace (`/push/...`, `/v2/...`) or a URL
 * whose literal host prevents a served path from beginning at a segment boundary is not observed, so
 * this pass cannot reject it. The shipped `/v1/push/...` gap is visible because `/v1` is already a
 * served prefix. This is the price of excluding asset and external URLs without guessing ownership.
 *
 * A green run here means exactly one thing: inside that observation set, no client asks for a path the
 * daemon does not serve and no route is served that no client asks for. It says nothing about whether
 * the runtime prerequisites of either end exist — no service worker, no permission, no transport, no
 * mount in the composition root (that last one is `composition-reachability`, a different gate).
 * "Route agreement passed" must never be reported as "the feature works".
 *
 * ## HOW IT READS THE CODE
 *
 * A real lexical pass, following `daemon-scope.ts` and `composition-reachability.ts`, never a grep:
 * comments, string bodies and regex literals are blanked to spaces first — with every offset and
 * newline preserved, so a finding is still a coordinate a reader can open — and the keys are then
 * matched against cleaned source. A grep would read a `/v1/…` path out of a doc comment, and this
 * repository documents its route tables in prose above them.
 *
 *   ROUTES    Every `{ method, path }` pair in `packages/daemon/src/lib/runtime/mounts/**` and
 *             `packages/daemon/src/lib/api/routes/**`. The second directory matters:
 *             `api/routes/usage.ts` and `api/routes/health.ts` declare four routes outside the
 *             runtime mounts. Restricting the server file set to the two route-table directories
 *             prevents an unrelated `{ path: '/run/socket' }` elsewhere in the daemon from being
 *             misclassified as a route.
 *
 *   CALLS     Every path expression in an argument position in every OTHER package's `src` and
 *             `bin` — pwa, cli, protocol, relay, fleet. Not only pwa and cli:
 *             `protocol/src/adapters/fy-api-client.ts` is where a third of the calls in this
 *             repository are actually written, and scanning the two obvious packages would have
 *             under-matched by that much while reading as compliance. Non-call address mentions
 *             are counted for probe visibility but NEVER make a daemon route read as reached.
 *
 * Paths are frequently assembled — `${PAIRING_CODE_PATH}/${encodeURIComponent(id)}` — so a
 * repo-wide table of path-valued constants is resolved into templates first, a hole this pass can name
 * from its own file's CALL SITES is resolved into every literal they pass (`scopedBindingsIn`), and only a
 * hole with no answer left becomes an unknown segment. A constant's DECLARATION is not a call:
 * recording one would invent a GET for every path in the repository, and `/v1/learning/run` is
 * POST-only.
 *
 * The verb comes from the enclosing call expression: an inline `method: 'DELETE'`, a helper such as
 * `jsonPost` whose whole body is one `RequestInit`, or a local name bound to one — `const init =
 * jsonRequest('POST', …)` is one hop from the call and the retry branch spreads that same name. A call
 * with no init argument at all is a GET, because that is what `fetch` and `IFyApiClient.request` do. A
 * call whose init this pass cannot read asks for any verb rather than guessing one — that direction
 * under-reports, which is stated here because an under-match reads as compliance.
 *
 * ## ONE PREDICATE, BOTH DIRECTIONS
 *
 * `pathMatches` reads the same in both directions, and that is load-bearing rather than tidy. There
 * used to be a LENIENT reading for the dead-route direction, on the grounds that a client composing a
 * suffix dynamically can genuinely reach a route the pass cannot name. It also meant a wholly unknown
 * client segment matched any route segment, so measured on the day it was removed, FIFTEEN of a
 * hundred and thirteen routes were held live by nothing but that leniency: the seven session actions
 * and eight task-board routes could be RENAMED with this gate green, which is the exact shipped-404
 * shape the gate exists to catch.
 *
 * So a `:param` accepts any client segment and, symmetrically, a wholly unknown client segment is
 * accepted only by a `:param`. A route whose only reader is an expression this pass cannot resolve
 * carries a reviewed line in the allowlist saying exactly that. A baseline line that admits what the
 * pass cannot see is worth more than a green run that meant nothing.
 *
 * ## FAIL CLOSED, INCLUDING ABOUT ITSELF
 *
 * Exit 2 — a gate bug, not a code finding — when the lexer desyncs, when a route file declares a
 * `method:` this pass could not pair with a `path:`, when no routes are found, or when no calls are
 * found. Every one of those would otherwise be a silent under-match, and an under-match reads as
 * compliance.
 */

import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const USAGE = 'usage: route-agreement.ts <repo-root> <allowlist-file>';

/** The package that SERVES. Its route tables are the definition of what exists. */
const SERVER_PACKAGE = 'packages/daemon';

/** Every directory that contains daemon route-table declarations; one file is one scan unit. */
const SERVER_ROUTE_DIRECTORIES = [
  'packages/daemon/src/lib/api/routes',
  'packages/daemon/src/lib/runtime/mounts',
] as const;

/** Independently compiled callers whose disappearance would make a green scan suspicious. */
const REQUIRED_DIAL_PACKAGES = ['packages/cli', 'packages/protocol', 'packages/pwa'] as const;

/** Where a package keeps production code. `tests/` is excluded by omission: a fixture is not a wire. */
const SOURCE_DIRECTORIES = ['src', 'bin'] as const;

/** The verbs a route table may declare. A `method:` key with any other literal is not a route. */
const HTTP_VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** A verb this pass could not read. It agrees with any route verb rather than inventing one. */
const ANY_VERB = '*';

/** A path segment this pass could not read — an interpolation. It satisfies a `:param`. */
const UNKNOWN_SEGMENT = '*';

/**
 * The most concrete paths one expression may fan out into before the hole collapses to unknown.
 *
 * One template can name several addresses once its holes are specialized from call sites, and a
 * product of holes is a product of answers. The cap keeps a pathological file bounded; passing it
 * makes the offending hole unknown again, which under-reports rather than inventing paths.
 */
const MAX_RESOLUTIONS = 64;

/**
 * The three ways the two ends can fail to be held to each other.
 *
 * `verb-unproven` is the odd one and it is the reason it exists. A dial whose init this pass cannot read
 * asks for ANY verb, so a route reached only by one of those AGREES — and kept agreeing after somebody
 * changed its method. There is no finding to exempt in the ordinary sense, because nothing disagrees.
 *
 * So the route's OWN verb and path become the target. `verb-unproven GET /v1/example` declares "this
 * address is reached, but by a dial that would have accepted any method". Change the server to `POST`
 * and that line describes nothing — a stale entry, which is a hard failure — while `verb-unproven POST
 * /v1/example` is undeclared, which is also a hard failure. The verb is held without ever guessing at
 * the runtime ternary that made it unreadable, and the declaration is paid off by making the verb
 * readable, not by editing the list.
 */
type Direction = 'unserved' | 'unreached' | 'verb-unproven';

/**
 * Every value a name may stand for.
 *
 * Set-valued because one name can honestly have several answers: `FyApiClient.#post`'s `action`
 * parameter is nine different string literals at nine call sites in its own file. Collapsing those to
 * a single unknown segment is what let seven served session routes be renamed with this gate green.
 */
type PathNames = ReadonlyMap<string, readonly string[]>;

interface Route {
  readonly verb: string;
  readonly path: string;
  readonly where: string;
}

interface Call {
  /** A dial is a request somebody makes; a mention is the client side merely knowing the address. */
  readonly kind: 'dial' | 'mention';
  readonly verb: string;
  readonly path: string;
  readonly where: string;
}

interface Finding {
  readonly direction: Direction;
  /** The allowlist target that would silence this finding, verbatim. */
  readonly target: string;
  readonly where: string;
  readonly why: string;
}

interface AllowEntry {
  readonly direction: Direction;
  readonly target: string;
  readonly reason: string;
  readonly line: number;
}

// ─── lexing ───────────────────────────────────────────────────────────────────────────────────

/**
 * Source with comments, string bodies and regex bodies blanked, and every offset preserved.
 *
 * Offset preservation is what lets this pass find a key in CLEANED text and then read the literal
 * that follows it out of the ORIGINAL — the only way to have both halves of the question answered
 * correctly, since a path lives inside a string body and a `method:` key must never be read out of
 * one. The cleaner may therefore only ever replace a character with another character.
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
  /**
   * Replace a consumed span with spaces, preserving its newlines and therefore its coordinates.
   *
   * Written over CODE UNITS rather than as a `/[^\n]/gu` replace, which is what this started as: a
   * `u`-flagged pattern matches by code POINT, so one astral character — `🚨` in a CLI label — is
   * replaced by a single space and every offset after it in the file is off by one. The tripwire
   * that compares the two lengths caught it on the first run against real sources.
   */
  const blank = (span: string): void => {
    let text = '';
    for (let index = 0; index < span.length; index += 1) text += span[index] === '\n' ? '\n' : ' ';
    out += text;
  };

  /**
   * True when a `/` here opens a regex literal rather than dividing or closing a JSX tag.
   *
   * Copied in spirit from `daemon-scope.ts`, which learned it the hard way: half the PWA is `.tsx`,
   * where `<Icon aria-hidden="true" />` and `</div>` both put a `/` after a character the textbook
   * rule reads as "an operator cannot precede a regex, so this must be one" — and the mis-lexed
   * regex then eats to the next `/`. A desynced file is not under-analysed, it is confidently
   * mis-analysed.
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
      // An escape at the very end of a file can walk the cursor past it, so the span decides the
      // length rather than the cursor. One character stands in for the whole literal, so the
      // expression still reads as a value: same length in, same length out.
      index = Math.min(index, source.length);
      const span = source.slice(start, index);
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

/** The 1-indexed line an offset falls on. */
function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === '\n') line += 1;
  }
  return line;
}

/** The end offset (exclusive) of the literal opening at `start`, or `undefined` if it never closes. */
function literalEnd(source: string, start: number): number | undefined {
  const quote = source[start];
  if (quote !== "'" && quote !== '"' && quote !== '`') return undefined;
  let index = start + 1;
  while (index < source.length && source[index] !== quote) {
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (quote !== '`' && source[index] === '\n') return undefined;
    index += 1;
  }
  return source[index] === quote ? index + 1 : undefined;
}

/** The body of the literal opening at `start`, without its quotes. */
function literalBody(source: string, start: number): string | undefined {
  const end = literalEnd(source, start);
  return end === undefined ? undefined : source.slice(start + 1, end - 1);
}

// ─── the served route table ───────────────────────────────────────────────────────────────────

interface KeyedField {
  readonly key: 'method' | 'path';
  readonly value: string | undefined;
  readonly offset: number;
  readonly container: number;
  readonly dynamic: boolean;
}

/** The opening brace of the object containing an offset, or -1 at module scope. */
function containerAt(cleaned: string, offset: number): number {
  const stack: number[] = [];
  for (let index = 0; index < offset; index += 1) {
    if (cleaned[index] === '{') stack.push(index);
    if (cleaned[index] === '}') stack.pop();
  }
  return stack[stack.length - 1] ?? -1;
}

/** Every `method:`/`path:` key in cleaned source, with a literal value when it has one. */
function keyedFields(source: string, cleaned: string): KeyedField[] {
  const found: KeyedField[] = [];
  for (const match of cleaned.matchAll(/\b(method|path)\s*:\s*/gu)) {
    const key = match[1];
    if (key !== 'method' && key !== 'path') continue;
    const offset = match.index + match[0].length;
    const quote = source[offset];
    const value = quote === "'" || quote === '"' || quote === '`' ? literalBody(source, offset) : undefined;
    found.push({
      key,
      value,
      offset,
      container: containerAt(cleaned, offset),
      dynamic: quote === '`' && value?.includes('${') === true,
    });
  }
  return found;
}

/**
 * The keys that make a `{ method, path }` object a ROUTE rather than an ordinary record.
 *
 * BOTH names, and the second one is why this is a set. `ApiRoute.handle` serves 111 of the 113 routes
 * in this repository; `SocketRoute.accept` serves the other two — `GET /v1/events` in
 * `runtime/mounts/fleet-events.ts` and the terminal stream in `runtime/mounts/terminals.ts`. Requiring
 * `handle` alone was the obvious reading and it would have dropped both socket routes out of the
 * definition of what exists, which is the shape of under-match this whole gate is built against. Every
 * one of the 113 was audited against this set before it landed.
 */
const ROUTE_HANDLER_KEYS = new Set(['handle', 'accept']);

/**
 * The spans of `interface` and `type` declarations, which describe a route without being one.
 *
 * A TYPE IS NOT A ROUTE TABLE. `interface ApiRoute { method; path; handle(…) }` is the very declaration
 * that defines a route, and reading it as one made this pass exit 2 — "route method and path must be
 * quoted literals" — over ordinary, correct code. It only escaped notice because `api/route.ts` sits
 * one directory outside the scanned route directories; the containment tripwire below now reads that
 * directory, so the exemption had to become a real rule rather than an accident of the file set.
 *
 * An `interface` ends at its matching brace. A type alias ends at its terminating `;` at depth zero, so
 * `type X = { a } | { b };` is one span; the `>` of an `=>` is not a closing angle, or a function-typed
 * member would end the span early and leave the members after it exposed.
 */
function typeDeclarationSpans(cleaned: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const match of cleaned.matchAll(/\b(interface|type)\s+[A-Za-z_$][\w$]*/gu)) {
    if (match[1] === 'interface') {
      const brace = cleaned.indexOf('{', match.index);
      const end = brace < 0 ? undefined : pairEnd(cleaned, brace, '{', '}');
      if (end !== undefined) spans.push([match.index, end]);
      continue;
    }
    let depth = 0;
    for (let index = match.index; index < cleaned.length; index += 1) {
      const character = cleaned[index] ?? '';
      if (character === '{' || character === '(' || character === '[' || character === '<') depth += 1;
      else if (character === '}' || character === ')' || character === ']') depth -= 1;
      else if (character === '>' && cleaned[index - 1] !== '=') depth -= 1;
      else if (character === ';' && depth <= 0) {
        spans.push([match.index, index + 1]);
        break;
      }
    }
  }
  return spans;
}

/**
 * The keys one object literal declares at its OWN top level, and whether any is unreadable.
 *
 * FOUR SPELLINGS, because a route that this pass cannot see the handler of vanishes from the definition
 * of what exists — the same under-match that requiring `handle` alone would have caused for the two
 * `SocketRoute` entries. TypeScript accepts all four and the first reading of this function saw only one:
 *
 *   handle: …          an identifier key
 *   handle(context)    the method shorthand, `async` included
 *   handle,            the value shorthand, where a name declared above IS the handler
 *   'handle': …        a quoted key — found in CLEANED text and read out of the ORIGINAL, because a
 *                      string body is blanked and the key lives inside one
 *   ['handle']: …      a computed key whose expression is a static literal
 *
 * `opaque` is the fifth case and it is not a spelling: `[KEY]: …`, a computed key naming an expression.
 * This pass cannot tell whether that key is the handler, and both guesses are wrong — calling it a route
 * reports an address nobody serves, and calling it a record drops one that exists. The caller fails
 * closed instead.
 *
 * Depth-tracked, so `capability: { capability: 'terminal' }` contributes `capability` once and a handler
 * body's own statements contribute nothing.
 */
function topLevelKeys(source: string, cleaned: string, brace: number): { keys: Set<string>; opaque: boolean } {
  const keys = new Set<string>();
  let opaque = false;
  const end = brace < 0 ? undefined : pairEnd(cleaned, brace, '{', '}');
  if (end === undefined) return { keys, opaque };
  /** The offset of the next non-space character at or after `from`. */
  const skipSpace = (from: number): number => {
    let cursor = from;
    while (cursor < end && /\s/u.test(cleaned[cursor] ?? '')) cursor += 1;
    return cursor;
  };
  let depth = 0;
  for (let index = brace + 1; index < end - 1; index += 1) {
    const character = cleaned[index] ?? '';
    if (depth === 0 && character === '[') {
      const close = pairEnd(cleaned, index, '[', ']');
      if (close === undefined) return { keys, opaque: true };
      const inner = skipSpace(index + 1);
      const literal = literalEnd(cleaned, inner);
      const body = literal === undefined ? undefined : literalBody(source, inner);
      if (body !== undefined && skipSpace(literal ?? inner) === close - 1 && cleaned[skipSpace(close)] === ':') {
        keys.add(body);
      } else if (cleaned[skipSpace(close)] === ':' || cleaned[skipSpace(close)] === '(') {
        opaque = true;
      }
      index = close - 1;
      continue;
    }
    if (character === '{' || character === '(' || character === '[') {
      depth += 1;
      continue;
    }
    if (character === '}' || character === ')' || character === ']') {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    if (character === "'" || character === '"' || character === '`') {
      const literal = literalEnd(cleaned, index);
      if (literal === undefined) continue;
      const body = literalBody(source, index);
      if (body !== undefined && cleaned[skipSpace(literal)] === ':') keys.add(body);
      index = literal - 1;
      continue;
    }
    if (!/[A-Za-z_$]/u.test(character)) continue;
    let cursor = index;
    while (cursor < end && /[\w$]/u.test(cleaned[cursor] ?? '')) cursor += 1;
    const after = skipSpace(cursor);
    // `,` and `}` are the value shorthand. Reading only `:` and `(` meant `{ method, path, scope, handle }`
    // had no handler this pass could see, and a real route would have dropped out silently.
    if ([':', '(', ',', '}'].includes(cleaned[after] ?? '')) keys.add(cleaned.slice(index, cursor));
    index = cursor - 1;
  }
  return { keys, opaque };
}

/** How to read the `{ method, path, … }` object at `brace`: a route, ordinary data, or unreadable. */
function classifyRouteObject(source: string, cleaned: string, brace: number): 'route' | 'record' | 'opaque' {
  const { keys, opaque } = topLevelKeys(source, cleaned, brace);
  for (const key of keys) {
    if (ROUTE_HANDLER_KEYS.has(key)) return 'route';
  }
  return opaque ? 'opaque' : 'record';
}

/**
 * The routes one server file declares.
 *
 * A route is one object containing exactly one `method:`, one `path:`, and a route HANDLER. Pairing by
 * the containing brace, rather than by proximity, prevents a request-init object or the next route in
 * the array from answering for a field it does not own.
 *
 * The handler is what tells a route from a record, and it had to be added: without it, an ordinary
 * `{ method: 'append', path: 'logs/daemon.log' }` in a route directory exited 2 with "unsupported route
 * method", telling the author to fix a pass they had not written. A `{ method, path }` object with no
 * handler is ordinary data and is ignored, exactly as a lone `method:` always was. Once an object IS a
 * route, an unreadable value is still a gate bug — dropping it would remove an address from the
 * definition of what exists.
 */
function routesIn(file: string, source: string, cleaned: string): { routes: Route[]; unpaired: string[] } {
  const declared = typeDeclarationSpans(cleaned);
  const fields = keyedFields(source, cleaned).filter(
    field => !declared.some(([from, to]) => from <= field.offset && field.offset < to),
  );
  const routes: Route[] = [];
  const unpaired: string[] = [];
  const containers = new Map<number, KeyedField[]>();
  for (const field of fields) {
    const grouped = containers.get(field.container) ?? [];
    grouped.push(field);
    containers.set(field.container, grouped);
  }

  for (const [brace, grouped] of containers) {
    const methods = grouped.filter(field => field.key === 'method');
    const paths = grouped.filter(field => field.key === 'path');
    if (methods.length === 0 || paths.length === 0) continue;
    const coordinate = `${file}:${lineAt(source, grouped[0]?.offset ?? 0)}`;
    const shape = classifyRouteObject(source, cleaned, brace);
    if (shape === 'record') continue;
    if (shape === 'opaque') {
      unpaired.push(
        `${coordinate}: this object declares method and path beside a computed key this pass cannot read, so whether it is a route is undecidable — name the handler statically (${[...ROUTE_HANDLER_KEYS].join(' or ')})`,
      );
      continue;
    }
    if (methods.length !== 1 || paths.length !== 1) {
      unpaired.push(`${coordinate}: route object has ${methods.length} method fields and ${paths.length} path fields`);
      continue;
    }
    const method = methods[0];
    const path = paths[0];
    if (method?.value === undefined || path?.value === undefined) {
      unpaired.push(`${coordinate}: route method and path must be quoted literals`);
      continue;
    }
    if (!HTTP_VERBS.has(method.value)) {
      unpaired.push(`${coordinate}: unsupported route method ${JSON.stringify(method.value)}`);
      continue;
    }
    if (path.dynamic) {
      unpaired.push(`${coordinate}: route path template contains an interpolation: ${JSON.stringify(path.value)}`);
      continue;
    }
    if (!path.value.startsWith('/')) {
      unpaired.push(`${coordinate}: route path does not start with '/': ${JSON.stringify(path.value)}`);
      continue;
    }
    routes.push({ verb: method.value, path: path.value, where: `${file}:${lineAt(source, method.offset)}` });
  }
  return { routes, unpaired };
}

// ─── the calls clients make ───────────────────────────────────────────────────────────────────

/** Brace depth at `offset` in cleaned source. Depth 0 is module scope. */
function depthAt(cleaned: string, offset: number): number {
  let depth = 0;
  for (let index = 0; index < offset && index < cleaned.length; index += 1) {
    const character = cleaned[index];
    if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
  }
  return depth;
}

interface PathBinding {
  readonly name: string;
  readonly body: string;
  readonly container: number;
}

/**
 * A name standing for SEVERAL path fragments over one lexical span.
 *
 * Two things produce one: a parameter specialized from its own file's call sites, and a name
 * destructured out of a helper whose returns are literal objects. Both are the same shape of fact —
 * "here, this name is one of these" — and both exist because collapsing such a name to a single unknown
 * segment let whole families of routes be renamed with this gate green.
 */
interface ScopedBinding {
  readonly name: string;
  readonly values: readonly string[];
  readonly from: number;
  readonly to: number;
}

/** One callable, its parameter names in order, and the brace span of its body. */
interface Declaration {
  readonly name: string;
  readonly at: number;
  readonly parameters: readonly string[];
  readonly body: readonly [number, number];
}

/** The end offset (exclusive) of the bracket pair opening at `start`, or `undefined` if unbalanced. */
function pairEnd(cleaned: string, start: number, open: string, close: string): number | undefined {
  let depth = 0;
  for (let index = start; index < cleaned.length; index += 1) {
    const character = cleaned[index];
    if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return undefined;
}

/**
 * A parameter list split on its own top-level commas, GENERICS INCLUDED.
 *
 * `callArguments` cannot answer this: it counts only `(`, `[` and `{`, so `(a: Map<string, number>, b:
 * string)` splits into three parts and every parameter after the generic is at the wrong position. A
 * wrong position resolves one parameter's literals into another's hole, which is a fabricated address
 * rather than a missing one. The `>` of an `=>` is not a closing angle, so a function-typed parameter
 * does not unbalance the count.
 */
function parameterList(span: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let angles = 0;
  let start = 0;
  for (let index = 0; index < span.length; index += 1) {
    const character = span[index];
    if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' || character === ']' || character === '}') depth -= 1;
    else if (character === '<') angles += 1;
    else if (character === '>' && span[index - 1] !== '=') angles = Math.max(0, angles - 1);
    else if (character === ',' && depth === 0 && angles === 0) {
      parts.push(span.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(span.slice(start));
  return parts;
}

/** The name one parameter declaration binds, or `''` for a pattern this pass does not name. */
function parameterName(declaration: string): string {
  const match = /^\s*(?:(?:readonly|public|private|protected)\s+)*(?:\.{3})?([A-Za-z_$][\w$]*)/u.exec(declaration);
  return match?.[1] ?? '';
}

/**
 * The brace span of the body a parameter list ending at `parenEnd` introduces, if it has one.
 *
 * The discriminator between a DECLARATION and a call is what follows the `)`: a body, an arrow, or a
 * return-type annotation and then one of those. Nothing else is allowed to reach a `{`, because
 * `wrap(value) ?? { … }` would otherwise donate an object literal as `value`'s scope and let a call's
 * argument resolve inside it.
 *
 * A return type may legitimately contain braces — `Promise<{ ok: boolean }>` — so angle depth decides
 * when a `{` is the body. A return type written as a bare object literal (`): { a: number } {`) is
 * read as the body instead; that scopes the binding to the type and it resolves nothing, which
 * under-matches rather than answering wrongly.
 */
function bodyAfterParameters(cleaned: string, parenEnd: number): [number, number] | undefined {
  let index = parenEnd;
  const skipSpace = (): void => {
    while (index < cleaned.length && /\s/u.test(cleaned[index] ?? '')) index += 1;
  };
  skipSpace();
  if (cleaned[index] === '=' && cleaned[index + 1] === '>') {
    index += 2;
    skipSpace();
  } else if (cleaned[index] === ':') {
    index += 1;
    let angles = 0;
    while (index < cleaned.length) {
      const character = cleaned[index] ?? '';
      if (character === '<') angles += 1;
      else if (character === '>') angles = Math.max(0, angles - 1);
      else if (angles === 0) {
        if (character === '{') break;
        if (character === '=' && cleaned[index + 1] === '>') {
          index += 2;
          break;
        }
        if (character === ';' || character === ')' || character === ',') return undefined;
      }
      index += 1;
    }
    skipSpace();
  }
  if (cleaned[index] !== '{') return undefined;
  const end = pairEnd(cleaned, index, '{', '}');
  return end === undefined ? undefined : [index, end];
}

/** A callee name followed by `(`, allowing the `#` of a private method. */
const CALLEE_BEFORE_PARENTHESIS = /(?<![\w$#])(#?[A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/gu;

/** One call, with each argument's string-literal body where it has one. */
interface CallSite {
  readonly callee: string;
  readonly literals: readonly (string | undefined)[];
}

/** Every call in one file, excluding the declarations whose own names sit at `declared`. */
function callSitesIn(source: string, cleaned: string, declared: ReadonlySet<number>): CallSite[] {
  const sites: CallSite[] = [];
  for (const match of cleaned.matchAll(CALLEE_BEFORE_PARENTHESIS)) {
    const callee = match[1];
    if (callee === undefined || NOT_A_CALLEE.has(callee) || declared.has(match.index)) continue;
    const open = match.index + match[0].length - 1;
    const close = pairEnd(cleaned, open, '(', ')');
    if (close === undefined) continue;
    const literals = callArguments(cleaned.slice(open + 1, close - 1)).map(argument => {
      const leading = argument.text.length - argument.text.trimStart().length;
      const at = open + 1 + argument.start + leading;
      const quote = cleaned[at];
      return quote === "'" || quote === '"' || quote === '`' ? literalBody(source, at) : undefined;
    });
    sites.push({ callee, literals });
  }
  return sites;
}

/**
 * Parameter names bound to the string literals their own file's call sites pass them.
 *
 * This is the one piece of call-site specialization this pass does, and it is the reason
 * `FyApiClient.#post` no longer hides eight addresses behind one hole. `#post(id, action, …)` builds
 * `/v1/sessions/${id}/${action}` and nine sites in the same file pass `action` as a literal, so nine
 * concrete dials are readable: seven agree with a served route, `rename` agrees with nothing — a real
 * shipped 404 that used to read as agreement — and renaming any of the seven now fails in BOTH
 * directions instead of passing.
 *
 * Bounded on purpose, and every bound under-reports rather than inventing an address:
 *
 *   SAME FILE   A name is not an identity across a workspace. Pooling every `send(` in the repository
 *               would resolve one gateway's suffixes into another gateway's path, which is the failure
 *               `sharedNames` already learned: a fabricated call is worse than a missing one.
 *   ONE LITERAL A parameter no call site passes a literal for stays exactly what it was — unknown.
 *   A BODY      A declaration whose body this pass cannot delimit contributes nothing at all.
 *   FRAGMENTS   A parameter whose literals already name a served surface is the path parameter of a
 *               GENERIC TRANSPORT, not a hole in a path. `FyApiClient.request(path, …)` is the live
 *               case: every one of those literals is already recorded at its own call site with its own
 *               verb, so specializing the parameter re-reported all of them inside `request`'s body,
 *               where `NonEmptyValueSchema.parse(path)` reads as a GET and turns POST-only surfaces
 *               into invented mismatches. Only a fragment — `'send'`, `'/create'` — is a hole.
 */
function declarationsIn(cleaned: string): Declaration[] {
  const declarations: Declaration[] = [];
  for (const match of cleaned.matchAll(CALLEE_BEFORE_PARENTHESIS)) {
    const name = match[1];
    if (name === undefined || NOT_A_CALLEE.has(name)) continue;
    const open = match.index + match[0].length - 1;
    const close = pairEnd(cleaned, open, '(', ')');
    if (close === undefined) continue;
    const body = bodyAfterParameters(cleaned, close);
    if (body === undefined) continue;
    declarations.push({
      name,
      at: match.index,
      parameters: parameterList(cleaned.slice(open + 1, close - 1)).map(parameterName),
      body,
    });
  }
  return declarations;
}

function parameterSpecializations(
  source: string,
  cleaned: string,
  declarations: readonly Declaration[],
  prefixes: ReadonlySet<string>,
): ScopedBinding[] {
  const sites = callSitesIn(source, cleaned, new Set(declarations.map(each => each.at)));
  const bindings: ScopedBinding[] = [];
  for (const declaration of declarations) {
    const calls = sites.filter(site => site.callee === declaration.name);
    if (calls.length === 0) continue;
    declaration.parameters.forEach((parameter, position) => {
      if (parameter === '') return;
      const values = new Set<string>();
      for (const call of calls) {
        const literal = call.literals[position];
        // An empty literal is not a segment this pass can hold anybody to, and neither is an
        // expression. Both mean the same thing here: unknown.
        values.add(literal === undefined || literal === '' ? UNKNOWN_SEGMENT : literal);
      }
      if (values.size === 1 && values.has(UNKNOWN_SEGMENT)) return;
      if ([...values].some(value => servedPath(value, prefixes) !== undefined)) return;
      bindings.push({
        name: parameter,
        values: [...values],
        from: declaration.body[0],
        to: declaration.body[1],
      });
    });
  }
  return bindings;
}

/**
 * The path fragments each declaration RETURNS inside a literal object, by declaration and field name.
 *
 * `FyTaskBoardGateway`'s `route(command)` is a twelve-arm switch and every arm returns
 * `{ path: '/create', schema, body }`. Reading only the `return '…'` shape left every one of those arms
 * invisible, so the gateway's dial resolved to `/v1/task-boards*` and one aggregate exemption stood in
 * for twelve addresses — including a thirteenth arm nobody had written yet, which would have been
 * absorbed on the day it landed.
 *
 * Only TOP-LEVEL fields of the returned object, and only values that look like a path, so a returned
 * `{ schema, body: command.body }` contributes nothing.
 */
function returnedPathFields(
  source: string,
  cleaned: string,
  declarations: readonly Declaration[],
): Map<string, Map<string, Set<string>>> {
  const returned = new Map<string, Map<string, Set<string>>>();
  for (const declaration of declarations) {
    const [from, to] = declaration.body;
    for (const match of cleaned.slice(from, to).matchAll(/\breturn\s*\(?\s*(?=\{)/gu)) {
      const brace = from + match.index + match[0].length;
      const close = pairEnd(cleaned, brace, '{', '}');
      if (close === undefined) continue;
      for (const member of parameterList(cleaned.slice(brace + 1, close - 1))) {
        const keyed = /^\s*([A-Za-z_$][\w$]*)\s*:\s*(?=['"`])/u.exec(member);
        if (keyed?.[1] === undefined) continue;
        const at = brace + 1 + cleaned.slice(brace + 1, close - 1).indexOf(member) + keyed[0].length;
        const value = literalBody(source, at);
        if (value === undefined || (!value.startsWith('/') && !value.startsWith('${'))) continue;
        const fields = returned.get(declaration.name) ?? new Map<string, Set<string>>();
        const values = fields.get(keyed[1]) ?? new Set<string>();
        values.add(value);
        fields.set(keyed[1], values);
        returned.set(declaration.name, fields);
      }
    }
  }
  return returned;
}

/**
 * Names destructured out of a call to one of this file's literal-object producers.
 *
 * `const { path, schema, body } = route(command)` binds `path` to all twelve arms `route` can return, so
 * the gateway dials twelve exact addresses instead of one wildcard. Scoped from the destructuring to the
 * end of its own block, because that is where the name means this.
 *
 * The initializer must be a direct call to a producer declared in the SAME FILE. Anything else — an
 * awaited call, a member expression, a producer from another module — binds nothing, which under-reports
 * rather than resolving one helper's suffixes into another's path.
 */
function destructuredFields(cleaned: string, returned: ReadonlyMap<string, Map<string, Set<string>>>): ScopedBinding[] {
  const bindings: ScopedBinding[] = [];
  for (const match of cleaned.matchAll(/\b(?:const|let)\s*\{([^{}]*)\}\s*(?::[^=;]+)?=\s*([A-Za-z_$][\w$]*)\s*\(/gu)) {
    const [, members = '', producer = ''] = match;
    const fields = returned.get(producer);
    if (fields === undefined) continue;
    const container = containerAt(cleaned, match.index);
    const end = container < 0 ? cleaned.length : (pairEnd(cleaned, container, '{', '}') ?? cleaned.length);
    for (const member of members.split(',')) {
      const renamed = /^\s*([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/u.exec(member);
      const plain = /^\s*([A-Za-z_$][\w$]*)\s*$/u.exec(member);
      const field = renamed?.[1] ?? plain?.[1];
      const local = renamed?.[2] ?? plain?.[1];
      if (field === undefined || local === undefined) continue;
      const values = fields.get(field);
      if (values === undefined) continue;
      bindings.push({ name: local, values: [...values], from: match.index, to: end });
    }
  }
  return bindings;
}

/** Every multi-valued name one file binds, from call-site specialization and from destructuring. */
function scopedBindingsIn(source: string, cleaned: string, prefixes: ReadonlySet<string>): ScopedBinding[] {
  const declarations = declarationsIn(cleaned);
  return [
    ...parameterSpecializations(source, cleaned, declarations, prefixes),
    ...destructuredFields(cleaned, returnedPathFields(source, cleaned, declarations)),
  ];
}

/** Every scoped name a file binds to a path, plus exported identifier constants shared by modules. */
function namesIn(source: string, cleaned: string): { bindings: PathBinding[]; exported: Map<string, string> } {
  const bindings: PathBinding[] = [];
  const exported = new Map<string, string>();
  const offer = (name: string, body: string, offset: number, shareable: boolean): void => {
    if (!body.startsWith('/') && !body.startsWith('${')) return;
    bindings.push({ name, body, container: containerAt(cleaned, offset) });
    // Cross-file resolution is deliberately limited to identifier-shaped constants. A module-local
    // `const path = ...` must not answer for a parameter named `path` in another package; that made
    // the generic transport call look like one arbitrary session endpoint. Local camelCase helpers
    // remain available in their own file through `all`.
    if (shareable && depthAt(cleaned, offset) === 0) exported.set(name, body);
  };
  for (const match of cleaned.matchAll(
    /\b(export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?=['"`])/gu,
  )) {
    const name = match[2];
    const body = literalBody(source, match.index + match[0].length);
    if (name !== undefined && body !== undefined) {
      offer(name, body, match.index, match[1] !== undefined && /^[A-Z][A-Z0-9_]*$/u.test(name));
    }
  }
  for (const [name, { body, offset }] of pathProducers(source, cleaned)) offer(name, body, offset, false);
  return { bindings, exported };
}

/**
 * The path names visible at one coordinate, from module scope down to its nearest object.
 *
 * Installed widest scope first, so the nearest binding shadows an outer one of the same name. The
 * specialized parameters go in before the locals for the same reason: `#post`'s body declares
 * `const path` and takes a parameter named `id`, and a `const` written inside a body is the answer for
 * every offset after it.
 */
function namesAt(
  cleaned: string,
  offset: number,
  shared: ReadonlyMap<string, string>,
  bindings: readonly PathBinding[],
  scoped: readonly ScopedBinding[],
): PathNames {
  const visible = new Map<string, readonly string[]>();
  for (const [name, body] of shared) visible.set(name, [body]);
  const inScope = scoped
    .filter(binding => binding.from <= offset && offset < binding.to)
    .sort((left, right) => right.to - right.from - (left.to - left.from));
  for (const binding of inScope) visible.set(binding.name, binding.values);
  const containers = [-1];
  const stack: number[] = [];
  for (let index = 0; index < offset; index += 1) {
    if (cleaned[index] === '{') stack.push(index);
    if (cleaned[index] === '}') stack.pop();
  }
  containers.push(...stack);
  for (const container of containers) {
    for (const binding of bindings) {
      if (binding.container === container) visible.set(binding.name, [binding.body]);
    }
  }
  return visible;
}

/**
 * Every exported SCREAMING_SNAKE name that stands for a path, across every client package.
 *
 * Repo-wide because `PAIRING_CODE_PATH` is declared in one module and interpolated in another; only
 * exported identifier constants, because a local is not shared and pretending otherwise poisons the whole run. The
 * first version collected every depth: `const path = ` inside one method of `fy-api-client.ts` then
 * stood for `path` EVERYWHERE, so `${operation.path}` in a fleet renderer resolved to a session URL
 * and the gate reported a call nobody had written.
 *
 * A name two modules define differently is dropped rather than guessed, for the same reason.
 */
function sharedNames(files: ReadonlyMap<string, { source: string; cleaned: string }>): Map<string, string> {
  const seen = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [, { source, cleaned }] of files) {
    for (const [name, body] of namesIn(source, cleaned).exported) {
      const known = seen.get(name);
      if (known !== undefined && known !== body) ambiguous.add(name);
      seen.set(name, body);
    }
  }
  for (const name of ambiguous) seen.delete(name);
  return seen;
}

/**
 * The verb stated by the first `method:` key in a span, read out of the ORIGINAL source.
 *
 * The key is found in cleaned text and the value is read beside it, because those are two different
 * questions: a `method:` inside a comment is not a verb, and a verb inside a blanked string body is
 * not readable. The first version matched both against cleaned source and reported every POST in
 * the repository as a GET — the value it was matching had been blanked to spaces.
 */
function methodLiteralIn(source: string, cleaned: string, from: number, to: number): string | undefined {
  const match = /\bmethod\s*:\s*(?=['"])/u.exec(cleaned.slice(from, to));
  if (match === null) return undefined;
  const verb = literalBody(source, from + match.index + match[0].length);
  return verb !== undefined && /^[A-Za-z]+$/u.test(verb) ? verb.toUpperCase() : undefined;
}

/**
 * Functions and methods whose answer IS a path, by name.
 *
 * A repository this size does not write its URLs out at the call site. `FyTaskGateway.sessionBase()`
 * returns `/v1/sessions/${id}/tasks` and four call sites interpolate it; the terminal surface builds
 * every one of its five routes the same way. Without this, `${sessionBase(id)}/${taskId}` resolves
 * to nothing recognisable and NINE live routes read as dead — an under-match, which reads as
 * compliance.
 *
 * Only a literal that is the immediate answer of the declaration counts (`return '…'`, `=> '…'`), so
 * a function that merely mentions a path somewhere in its body maps to nothing.
 */
function pathProducers(source: string, cleaned: string): Map<string, { body: string; offset: number }> {
  const producers = new Map<string, { body: string; offset: number }>();
  const shapes = [
    // `function name(…) {`, and a class method — the name sits immediately before the parameters.
    /\b([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*(?::[^={;]*)?(?:=>|\{)\s*(?:return\s*)?\(?\s*(?=['"`])/gu,
    // `const name = (…) =>`, where an `=` sits between the name and the parameters. Both shapes are
    // in use: the CLI writes methods, the PWA writes arrow constants, and reading only the first
    // left every per-terminal route in the daemon looking dead.
    /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\([^()]*\)\s*(?::[^={;]*)?=>\s*\(?\s*(?=['"`])/gu,
  ];
  for (const shape of shapes) {
    for (const match of cleaned.matchAll(shape)) {
      const name = match[1];
      if (name === undefined) continue;
      const body = literalBody(source, match.index + match[0].length);
      if (body === undefined) continue;
      if (!body.startsWith('/') && !body.startsWith('${')) continue;
      producers.set(name, { body, offset: match.index });
    }
  }
  return producers;
}

/** Helpers whose entire body is one `RequestInit`, so a call to one names a verb. */
function verbHelpers(source: string, cleaned: string): Map<string, string> {
  const helpers = new Map<string, string>();
  for (const match of cleaned.matchAll(
    /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>\s*\(?\{/gu,
  )) {
    const name = match[1];
    if (name === undefined) continue;
    const from = match.index + match[0].length;
    const verb = methodLiteralIn(source, cleaned, from, from + 120);
    if (verb !== undefined) helpers.set(name, verb);
  }
  return helpers;
}

/**
 * Every verb helper in the workspace, because a gateway imports one rather than declaring it.
 *
 * `jsonPost` lives in one module and is called from several. Reading only the file in front of it
 * left `FyTaskGateway.act()` looking like a GET, so the POST route it dials read as dead while the
 * GET on the same address read as fine — the quietest possible wrong answer.
 */
function sharedVerbHelpers(files: ReadonlyMap<string, { source: string; cleaned: string }>): Map<string, string> {
  const helpers = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [, { source, cleaned }] of files) {
    for (const [name, verb] of verbHelpers(source, cleaned)) {
      const known = helpers.get(name);
      if (known !== undefined && known !== verb) ambiguous.add(name);
      helpers.set(name, verb);
    }
  }
  for (const name of ambiguous) helpers.delete(name);
  return helpers;
}

/** The arguments of a call span, split on its own top-level commas. */
function callArguments(span: string): { text: string; start: number }[] {
  const args: { text: string; start: number }[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < span.length; index += 1) {
    const character = span[index];
    if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' || character === ']' || character === '}') depth -= 1;
    else if (character === ',' && depth === 0) {
      args.push({ text: span.slice(start, index), start });
      start = index + 1;
    }
  }
  args.push({ text: span.slice(start), start });
  return args;
}

/** Words that put a `(` after them without calling anything. */
const NOT_A_CALLEE = new Set([
  'if',
  'while',
  'for',
  'switch',
  'catch',
  'return',
  'typeof',
  'await',
  'yield',
  'in',
  'of',
  'do',
  'else',
]);

/**
 * The callee immediately before `open`, or `undefined` when the `(` groups rather than calls.
 *
 * `if (url.pathname === HOSTED_RELAY_OPERATOR_CONFIG_PATH)` is a COMPARISON. The first version of
 * this pass walked back to the nearest unmatched `(` and called it a call, so the Cloudflare
 * worker's own route table read as two calls to a daemon that has never served them. Naming a path
 * is not dialling it.
 */
function calleeBefore(cleaned: string, open: number): string | undefined {
  let index = open - 1;
  while (index >= 0 && /\s/u.test(cleaned[index] ?? '')) index -= 1;
  if (index < 0) return undefined;
  const last = cleaned[index] ?? '';
  if (last === ')' || last === ']') return '(expression)';
  if (!/[\w$]/u.test(last)) return undefined;
  let start = index;
  while (start >= 0 && /[\w$]/u.test(cleaned[start] ?? '')) start -= 1;
  const name = cleaned.slice(start + 1, index + 1);
  return NOT_A_CALLEE.has(name) ? undefined : name;
}

/** The span of the innermost call expression containing `offset`, as `[open, close]`. */
function enclosingCall(cleaned: string, offset: number): [number, number] | undefined {
  let depth = 0;
  let open = -1;
  for (let index = offset - 1; index >= 0; index -= 1) {
    const character = cleaned[index];
    if (character === ')') depth += 1;
    else if (character === '(') {
      if (depth === 0) {
        open = index;
        break;
      }
      depth -= 1;
    }
  }
  if (open < 0) return undefined;
  depth = 0;
  for (let index = open + 1; index < cleaned.length; index += 1) {
    const character = cleaned[index];
    if (character === '(') depth += 1;
    else if (character === ')') {
      if (depth === 0) return [open, index];
      depth -= 1;
    }
  }
  return undefined;
}

/**
 * The verb a path expression is dialled with.
 *
 * `undefined` when the expression is not an argument to anything — a constant's declaration, an
 * export, a type position. Those are not calls, and recording one would invent a GET for a path
 * whose only real caller is a POST: `/v1/learning/run` is declared once and dialled once, and the
 * declaration is not the dial.
 *
 * Otherwise the arguments AFTER the path decide it. A stated `method:`, or a helper whose whole body
 * is one `RequestInit`, is the answer. An argument list this pass can read to the end without
 * finding either is a GET, because that is what `fetch` and `IFyApiClient.request` do with an absent
 * or method-less init — `{ headers }` really is a GET. An argument it cannot read is `*`, which
 * agrees with any verb: guessing GET there would report a mismatch nobody wrote.
 */
/**
 * The verb an INVOCATION states, when the expression starting at `from` is one.
 *
 * Two shapes, and only at the top level of the expression. A helper whose whole body is one
 * `RequestInit` names its verb by identity; a helper that TAKES the verb states it in its leading
 * argument, because its own `method:` is an identifier the helper table cannot read. Looking for a
 * helper name anywhere INSIDE the expression instead made `{ body: json(value) }` turn an ordinary GET
 * into a POST just because another module exported a generic helper named `json`.
 */
function verbOfInvocation(
  source: string,
  from: number,
  raw: string,
  helpers: ReadonlyMap<string, string>,
): string | undefined {
  const text = raw.trim();
  const invokedHelper = /^([A-Za-z_$][\w$]*)\s*\(/u.exec(text)?.[1];
  if (invokedHelper !== undefined) {
    const helperVerb = helpers.get(invokedHelper);
    if (helperVerb !== undefined) return helperVerb;
  }
  const passed = /^[A-Za-z_$][\w$.]*\s*\(\s*(?=['"])/u.exec(text);
  if (passed === null) return undefined;
  const leading = raw.length - raw.trimStart().length;
  const verb = literalBody(source, from + leading + passed[0].length);
  return verb !== undefined && HTTP_VERBS.has(verb.toUpperCase()) ? verb.toUpperCase() : undefined;
}

/**
 * Local names bound to a request init whose verb is readable, per file.
 *
 * A name two declarations in one file bind to different verbs is dropped rather than guessed, for the
 * same reason `sharedVerbHelpers` drops one: a wrong verb reports a mismatch nobody wrote.
 */
function initVerbsIn(source: string, cleaned: string, helpers: ReadonlyMap<string, string>): Map<string, string> {
  const bound = new Map<string, string>();
  const ambiguous = new Set<string>();
  const offer = (name: string, verb: string | undefined): void => {
    if (verb === undefined) return;
    const known = bound.get(name);
    if (known !== undefined && known !== verb) ambiguous.add(name);
    bound.set(name, verb);
  };
  for (const match of cleaned.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?=[A-Za-z_$])/gu)) {
    const name = match[1];
    if (name === undefined) continue;
    const from = match.index + match[0].length;
    const statementEnd = cleaned.indexOf('\n', from);
    offer(
      name,
      verbOfInvocation(source, from, cleaned.slice(from, statementEnd < 0 ? cleaned.length : statementEnd), helpers),
    );
  }
  // `const startInit: RequestInit = { method: 'POST', body, headers }` — the verb is STATED, in the
  // plainest form there is, and the call that hands `startInit` to the transport is two lines below it.
  // Reading only invocation-shaped initializers left `POST /v1/sessions` asking for any verb, so a
  // daemon that started serving it as a PUT would still have agreed.
  for (const match of cleaned.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?=\{)/gu)) {
    const name = match[1];
    if (name === undefined) continue;
    const brace = match.index + match[0].length;
    const end = pairEnd(cleaned, brace, '{', '}');
    if (end !== undefined) offer(name, methodLiteralIn(source, cleaned, brace, end));
  }
  for (const name of ambiguous) bound.delete(name);
  return bound;
}

function verbFor(
  source: string,
  cleaned: string,
  start: number,
  end: number,
  helpers: ReadonlyMap<string, string>,
  initVerbs: ReadonlyMap<string, string>,
): string | undefined {
  const call = enclosingCall(cleaned, start);
  if (call === undefined) return undefined;
  const [open, close] = call;
  const callee = calleeBefore(cleaned, open);
  if (callee === undefined) return undefined;
  // `new URL(path, base)` COMPOSES an address; the dial is the call it is handed to. Reading one level
  // out is what makes `fetch(new URL('/v1/fleet/environment', base), { headers })` a GET rather than a
  // request for any verb — and that one reading is what uncovered `PUT /v1/fleet/environment`, a route
  // with no client anywhere, which the unreadable verb had been answering for.
  //
  // Strictly one direction: the outer reading may only ever REPLACE unknown with a definite verb. When
  // the composed URL is not itself an argument — `const url = new URL(…)` — there is no outer call and
  // unknown stays the honest answer rather than whatever an unrelated `(` further back would have said.
  if (callee === 'URL') {
    const outer = verbFor(source, cleaned, open, close + 1, helpers, initVerbs);
    return outer === undefined || outer === ANY_VERB ? ANY_VERB : outer;
  }
  const args = callArguments(cleaned.slice(open + 1, close));
  const pathArgument = args.findIndex(
    argument => open + 1 + argument.start <= start && start < open + 1 + argument.start + argument.text.length,
  );
  if (pathArgument < 0) return ANY_VERB;

  let readable = true;
  for (const argument of args.slice(pathArgument + 1)) {
    const from = open + 1 + argument.start;
    const stated = methodLiteralIn(source, cleaned, from, from + argument.text.length);
    if (stated !== undefined) return stated;
    const text = argument.text.trim();
    const invoked = verbOfInvocation(source, from, argument.text, helpers);
    if (invoked !== undefined) return invoked;
    // A NAMED init, whole or spread. `#post` writes `const init = jsonRequest('POST', …)` and hands
    // `init` to the transport, so the verb is one hop from the call; its retry branch spreads the same
    // name into `{ ...init, headers }`. Reading neither made all nine session actions ask for any
    // verb, so a POST route quietly turned into a PUT would still have agreed with them.
    const named = /^\.{3}([A-Za-z_$][\w$]*)/u.exec(text)?.[1] ?? /^\{\s*\.{3}([A-Za-z_$][\w$]*)/u.exec(text)?.[1];
    const bound = named === undefined ? undefined : initVerbs.get(named);
    if (bound !== undefined) return bound;
    // A spread of an INVOCATION: `{ ...jsonRequest('POST', schema, value), headers }`. Same stated verb
    // literal the top-level reader already understands, one syntactic layer in. Without it,
    // `POST /v1/task-boards/child-grants/request` asked for any verb.
    if (/^\{?\s*\.{3}/u.test(text)) {
      const after = argument.text.indexOf('...') + 3;
      const spread = verbOfInvocation(source, from + after, argument.text.slice(after), helpers);
      if (spread !== undefined) return spread;
    }
    if (/^[A-Za-z_$][\w$]*$/u.test(text)) {
      const wholeVerb = initVerbs.get(text);
      if (wholeVerb !== undefined) return wholeVerb;
    }
    // An object spread may carry `method:` from a RequestInit this pass could not name. Treating it as
    // a method-less object invented GET for `#post()`'s `{ ...init, headers }` retry branch.
    if (/\.{3}/u.test(text)) readable = false;
    // A bare identifier could be the init this pass just failed to read. A schema is the one
    // argument that never is, and this repository names them all the same way.
    if (/^[A-Za-z_$][\w$.]*$/u.test(text) && !/schema/iu.test(text)) readable = false;
  }
  return readable && end <= close ? 'GET' : ANY_VERB;
}

/**
 * Every path a template can name, with each `${…}` replaced by a value its name stands for.
 *
 * Set-valued because a specialized hole has several answers, and the answers multiply: nine `action`
 * literals against one unresolvable `id` is nine paths, and each is a separate observation. A hole
 * with no answer is the unknown segment, exactly as before.
 *
 * Brace-BALANCED rather than `\$\{[^}]*\}`, which is where this started and is wrong on the first
 * real path it met: `` `/v1/analytics${search.size === 0 ? '' : `?${search}`}` `` closes the inner
 * template's brace first, so the lazy pattern kept half the expression as literal path text and
 * reported a route nobody wrote.
 */
function substituteInterpolations(body: string, paths: PathNames, depth = 0): string[] {
  let outputs = [''];
  let index = 0;
  while (index < body.length) {
    if (body[index] !== '$' || body[index + 1] !== '{') {
      const character = body[index] ?? '';
      outputs = outputs.map(text => text + character);
      index += 1;
      continue;
    }
    let braces = 1;
    let cursor = index + 2;
    while (cursor < body.length && braces > 0) {
      if (body[cursor] === '{') braces += 1;
      else if (body[cursor] === '}') braces -= 1;
      cursor += 1;
    }
    const resolved = resolveExpression(body.slice(index + 2, cursor - 1).trim(), paths, depth);
    const values = outputs.length * resolved.length > MAX_RESOLUTIONS ? [UNKNOWN_SEGMENT] : resolved;
    outputs = outputs.flatMap(text => values.map(value => text + value));
    index = cursor;
  }
  return outputs;
}

/** Every path an interpolated expression names, or the unknown segment. */
function resolveExpression(expression: string, paths: PathNames, depth: number): string[] {
  if (depth >= 4) return [UNKNOWN_SEGMENT];
  const named = /^(?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*)\s*(?:\(|$)/u.exec(expression);
  const values = named?.[1] === undefined ? undefined : paths.get(named[1]);
  if (values === undefined || values.length === 0) return [UNKNOWN_SEGMENT];
  return values.flatMap(value => substituteInterpolations(value, paths, depth + 1));
}

/**
 * Every served surface one resolved text names, or `undefined` when it names none.
 *
 * Everything before the first served prefix is dropped, so `${origin}/v1/health` is the same
 * observation as `/v1/health`.
 *
 * Adjacent unknown markers collapse to ONE. Two interpolations in a row are the same observation as
 * one — `segmentMatches` reads only the literal text before the first marker and after the last — and
 * a `**` in a target is a line the allowlist parser rejects as a glob. Without this, the gate printed
 * `allow deliberately with: unserved POST /v1/x/**` and then exited 2 on the very line it had just
 * told the author to add. A gate must not hand out a remedy it refuses.
 */
function servedPath(candidate: string, prefixes: ReadonlySet<string>): string | undefined {
  let text = candidate.replace(/\*{2,}/gu, UNKNOWN_SEGMENT);
  const query = text.indexOf('?');
  if (query >= 0) text = text.slice(0, query);
  // Prose, not an address. A URL path has no spaces in it, and a sentence that happens to hold one
  // resolved interpolation would otherwise be reported as a call.
  if (/\s/u.test(text)) return undefined;
  for (const prefix of prefixes) {
    let from = 0;
    while (from < text.length) {
      const at = text.indexOf(prefix, from);
      if (at < 0) break;
      const before = text[at - 1];
      const after = text[at + prefix.length];
      // `/v1` is a prefix of `/v10`, but it is not the same first path segment. Single-segment
      // routes such as `/healthz` end at this boundary instead of carrying a trailing slash.
      if ((at === 0 || !/[\w$]/u.test(before ?? '')) && (after === undefined || after === '/')) {
        return text.slice(at);
      }
      from = at + prefix.length;
    }
  }
  return undefined;
}

/** Every served surface a path expression can name, deduplicated; empty when it names none. */
function resolvePaths(
  body: string,
  kind: 'quoted' | 'template',
  names: PathNames,
  prefixes: ReadonlySet<string>,
): string[] {
  const candidates = kind === 'template' ? substituteInterpolations(body, names) : [body];
  const resolved = new Set<string>();
  for (const candidate of candidates) {
    const path = servedPath(candidate, prefixes);
    if (path !== undefined) resolved.add(path);
  }
  return [...resolved];
}

/** Every call a client file makes to a served surface. */
function callsIn(
  file: string,
  source: string,
  cleaned: string,
  shared: ReadonlyMap<string, string>,
  bindings: readonly PathBinding[],
  scoped: readonly ScopedBinding[],
  prefixes: ReadonlySet<string>,
  helpers: ReadonlyMap<string, string>,
): Call[] {
  const calls: Call[] = [];
  const initVerbs = initVerbsIn(source, cleaned, helpers);
  const record = (paths: readonly string[], start: number, end: number): void => {
    if (paths.length === 0) return;
    // DIAL vs MENTION. Only a dial can satisfy either direction of this gate.
    //
    // A path in an argument position is a request somebody makes: if no route answers it, that is a
    // shipped 404. A path anywhere else — a `const …_PATH` a module exports, the answer of a helper
    // like `FyTaskGateway.sessionBase()` — is the client side KNOWING the address, but it does not
    // prove anything dials it. Recording every mention as a dial reported `/v1/fleet` and
    // `/v1/task-boards` as unserved because they are prefixes. Mentions remain in the measurement
    // breakdown so a package the probe stopped reading is visible; agreement itself uses only dials.
    const verb = verbFor(source, cleaned, start, end, helpers, initVerbs);
    for (const path of paths) {
      calls.push({
        kind: verb === undefined ? 'mention' : 'dial',
        verb: verb ?? ANY_VERB,
        path,
        where: `${file}:${lineAt(source, start)}`,
      });
    }
  };

  for (let index = 0; index < cleaned.length; index += 1) {
    const character = cleaned[index];
    if (character !== "'" && character !== '"' && character !== '`') continue;
    const end = literalEnd(cleaned, index);
    if (end === undefined) continue;
    const body = source.slice(index + 1, end - 1);
    const kind = character === '`' ? 'template' : 'quoted';
    record(resolvePaths(body, kind, namesAt(cleaned, index, shared, bindings, scoped), prefixes), index, end);
    index = end - 1;
  }

  // A bare name reference is the same call written with a name. Import statements are skipped, and so
  // is the name's own declaration: naming a path is not dialling it, and the literal scan above has
  // already recorded that coordinate. Counting both was why one `const …_PATH` produced two
  // observations and the totals over-reported the places a path is written.
  const candidateNames = new Set([
    ...shared.keys(),
    ...bindings.map(binding => binding.name),
    ...scoped.map(binding => binding.name),
  ]);
  for (const name of candidateNames) {
    for (const match of cleaned.matchAll(new RegExp(String.raw`\b${name}\b`, 'gu'))) {
      const lineStart = cleaned.lastIndexOf('\n', match.index) + 1;
      const before = cleaned.slice(lineStart, match.index);
      if (/^\s*(?:import|export)\b/u.test(before)) continue;
      if (/(?:const|let|var)\s+$/u.test(before)) continue;
      const visible = namesAt(cleaned, match.index, shared, bindings, scoped);
      const values = visible.get(name);
      if (values === undefined) continue;
      const resolved = new Set<string>();
      for (const value of values) {
        for (const path of resolvePaths(value, 'template', visible, prefixes)) resolved.add(path);
      }
      record([...resolved], match.index, match.index + name.length);
    }
  }

  // One coordinate stating one address once. The literal scan and the name scan can both land on the
  // same place, and a duplicate observation inflates every number this gate prints without changing a
  // single agreement decision.
  const distinct = new Map<string, Call>();
  for (const call of calls) distinct.set(`${call.kind} ${call.verb} ${call.path} ${call.where}`, call);
  return [...distinct.values()];
}

// ─── agreement ────────────────────────────────────────────────────────────────────────────────

/**
 * True when a client segment could be the route segment at the same position.
 *
 * ONE PREDICATE, BOTH DIRECTIONS. There used to be a lenient reading for the dead-route direction, and
 * it is the hole this gate shipped with: a wholly unknown client segment matched ANY route segment, so
 * one generic `` fetch(`/v1/${resource}`) `` marked every route of that shape as reached. Measured on
 * the day it was removed, fifteen of a hundred and thirteen routes were held live by nothing but that
 * leniency — seven session actions and eight task-board routes could be RENAMED with the gate green,
 * which is the exact shipped-404 shape this gate exists to catch.
 *
 * So: a `:param` accepts any segment, and its symmetric counterpart is that a wholly unknown segment is
 * accepted only by a `:param`. A route whose only reader is an unresolvable expression carries a
 * reviewed baseline line instead, which is the honest way to say this pass cannot see the address.
 *
 * A PARTIAL unknown segment still names the literal segment its interpolation could be empty for, so
 * `tasks*` can be `tasks`. It may not absorb extra literal route text: letting `attention*` match
 * `attention-REMOVED` hid a route rename.
 */
function segmentMatches(routeSegment: string, clientSegment: string): boolean {
  if (routeSegment.startsWith(':')) return clientSegment.length > 0;
  if (!clientSegment.includes(UNKNOWN_SEGMENT)) return routeSegment === clientSegment;
  if (clientSegment === UNKNOWN_SEGMENT) return false;
  const prefix = clientSegment.slice(0, clientSegment.indexOf(UNKNOWN_SEGMENT));
  const suffix = clientSegment.slice(clientSegment.lastIndexOf(UNKNOWN_SEGMENT) + 1);
  return routeSegment === `${prefix}${suffix}`;
}

/** True when a route pattern would answer a client path. */
function pathMatches(routePath: string, clientPath: string): boolean {
  const routeSegments = routePath.split('/');
  const clientSegments = clientPath.split('/');
  for (let index = 0; index < routeSegments.length; index += 1) {
    const routeSegment = routeSegments[index] ?? '';
    const clientSegment = clientSegments[index];
    // The client ran out of readable path where the route has more. That is a different address, and
    // it is one in both directions. Letting a trailing partial segment stand for "anything below" is
    // what made `${TASK_BOARD_ROUTE_PREFIX}${path}` read as reaching all nine board routes, so
    // renaming any of them passed; those routes carry reviewed baseline lines now.
    if (clientSegment === undefined) return false;
    if (!segmentMatches(routeSegment, clientSegment)) return false;
  }
  // A client path DEEPER than the route is a different address. Full stop, and the reasoning is worth
  // keeping because a plausible-sounding branch used to live here.
  //
  // That branch accepted a deeper client path when the client segment at the route's own last position
  // was a PARTIAL unknown, on the theory that a trailing interpolation may carry the rest of the URL.
  // The theory is sound and the branch could never implement it: an interpolation that carries the rest
  // of the URL does not ADD segments to the resolved text — `*` stays one segment however many slashes
  // its value holds — so that case is the client-SHORTER one, handled above. For the client to be deeper
  // there must be literal path text AFTER the interpolation, and literal text is exactly what an
  // interpolation cannot absorb.
  //
  // The counterexample is one line. `` `/v1/foo${x}/bar` `` resolves to `/v1/foo*/bar`, and the branch
  // matched it against the route `/v1/foo`: every route segment agreed, the client was one deeper, and
  // `foo*` is a partial unknown. But `${x}` cannot make `foo${x}/bar` equal `foo` — `/bar` is literal —
  // so a client dialling that address against a daemon serving only `/v1/foo` gets a 404, and the gate
  // reported agreement in BOTH directions. Measured before removal: zero (route, dial) pairs in this
  // repository matched only through it, so it was pure fail-open surface.
  return clientSegments.length === routeSegments.length;
}

function verbMatches(routeVerb: string, clientVerb: string): boolean {
  return clientVerb === ANY_VERB || routeVerb === clientVerb;
}

function agrees(route: Route, call: Call): boolean {
  return verbMatches(route.verb, call.verb) && pathMatches(route.path, call.path);
}

// ─── allowlist ────────────────────────────────────────────────────────────────────────────────

function parseAllowlist(path: string, displayPath: string): AllowEntry[] {
  const entries: AllowEntry[] = [];
  const seen = new Map<string, number>();
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((raw, index) => {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) return;
      const match = /^(unserved|unreached|verb-unproven)\s+([A-Z*]+)\s+(\S+)\s*#\s*(.+)$/u.exec(line);
      if (match === null) {
        console.error(
          `❌ ${displayPath}:${index + 1}: every entry is "<unserved|unreached|verb-unproven> <VERB> <path> # <reason>" with a reason`,
        );
        process.exit(2);
      }
      const [, direction, verb, target, reason] = match as unknown as [string, Direction, string, string, string];
      if (target.includes('**') || target.includes('…')) {
        console.error(`❌ ${displayPath}:${index + 1}: globs are forbidden — one exact path per line`);
        process.exit(2);
      }
      const key = `${direction} ${verb} ${target}`;
      const prior = seen.get(key);
      if (prior !== undefined) {
        console.error(`❌ ${displayPath}:${index + 1}: duplicate exemption ${key} (first at line ${prior})`);
        process.exit(2);
      }
      seen.set(key, index + 1);
      entries.push({ direction, target: `${verb} ${target}`, reason: reason.trim(), line: index + 1 });
    });
  return entries;
}

// ─── walk ─────────────────────────────────────────────────────────────────────────────────────

function packageDirectories(root: string): string[] {
  const listed = new Bun.Glob('*/package.json').scanSync({ cwd: resolve(root, 'packages'), onlyFiles: true });
  return [...listed].map(entry => `packages/${entry.replace(/\/package\.json$/u, '')}`).sort();
}

function filesUnder(root: string, relativeDirectory: string): string[] {
  const absolute = resolve(root, relativeDirectory);
  if (!existsSync(absolute)) return [];
  const listed = new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: absolute, absolute: true, onlyFiles: true });
  return [...listed].map(path => relative(root, path)).sort();
}

function sourceFiles(root: string, packageDirectory: string): string[] {
  const files: string[] = [];
  for (const directory of SOURCE_DIRECTORIES) {
    files.push(...filesUnder(root, `${packageDirectory}/${directory}`));
  }
  return files.sort();
}

function main(): void {
  const [rootArgument, allowlistArgument] = process.argv.slice(2);
  if (rootArgument === undefined || allowlistArgument === undefined) {
    console.error(`❌ ${USAGE}`);
    process.exit(2);
  }
  const root = resolve(rootArgument);
  const allowlistPath = resolve(allowlistArgument);
  if (!existsSync(allowlistPath)) {
    console.error(`❌ missing route-agreement allowlist: ${allowlistArgument}`);
    process.exit(2);
  }

  const packages = packageDirectories(root);
  if (!packages.includes(SERVER_PACKAGE)) {
    console.error(`❌ ${SERVER_PACKAGE} does not exist — this gate has lost its subject, not its work`);
    process.exit(2);
  }

  const load = (paths: readonly string[]): Map<string, { source: string; cleaned: string }> => {
    const loaded = new Map<string, { source: string; cleaned: string }>();
    for (const path of paths) {
      const source = readFileSync(resolve(root, path), 'utf8');
      const cleaned = clean(source);
      if (cleaned.length !== source.length) {
        console.error(`❌ the route-agreement lexer changed the length of ${path} — every offset after it is wrong`);
        process.exit(2);
      }
      loaded.set(path, { source, cleaned });
    }
    return loaded;
  };

  const serverFiles = load(SERVER_ROUTE_DIRECTORIES.flatMap(directory => filesUnder(root, directory)));
  const clientFiles = load(packages.filter(each => each !== SERVER_PACKAGE).flatMap(each => sourceFiles(root, each)));
  if (serverFiles.size === 0 || clientFiles.size === 0) {
    console.error('❌ found no sources to compare — refusing to report a vacuous pass');
    process.exit(2);
  }

  // CONTAINMENT. The route file set is two directories, and nothing used to hold the daemon to them: a
  // route table in `api/` one level up was invisible, so this gate reported the same 113 routes and
  // passed while its own subject moved out from under it. A count that is short by a table nobody
  // declared out of scope is an under-match, and an under-match reads as compliance.
  //
  // Route-SHAPED is decided by `routesIn`, the same function that reads the route directories, so the
  // two definitions cannot drift. That contract has three parts, and the daemon's two other `method:`
  // records are why: `{ method: 'docx-xml', text, … }` in `attachments/document-extraction.ts` and the
  // `method: 'POST'` of a `fetch` init in `adapters/stt/fetch-enhancement-transport.ts` each have no
  // `path` sibling and no handler, so neither is a route and both stay green.
  const scannedDirectories = SERVER_ROUTE_DIRECTORIES.map(directory => `${directory}/`);
  const outsideFiles = load(
    sourceFiles(root, SERVER_PACKAGE).filter(path => !scannedDirectories.some(each => path.startsWith(each))),
  );
  const stowaways: string[] = [];
  for (const [path, { source, cleaned }] of outsideFiles) {
    const found = routesIn(path, source, cleaned);
    for (const route of found.routes) stowaways.push(`${route.where}: ${route.verb} ${route.path}`);
    stowaways.push(...found.unpaired);
  }
  if (stowaways.length > 0) {
    console.error(`❌ ${SERVER_PACKAGE} declares route-shaped objects outside the directories this gate reads:`);
    for (const entry of stowaways) console.error(`   ${entry}`);
    console.error(`   Route tables live only in ${SERVER_ROUTE_DIRECTORIES.join(' and ')}.`);
    console.error('   Move the table there, or widen SERVER_ROUTE_DIRECTORIES in the same change.');
    console.error('   Until then this gate would report a route count short by every address above.');
    process.exit(2);
  }

  const routes: Route[] = [];
  const unpaired: string[] = [];
  for (const [path, { source, cleaned }] of serverFiles) {
    const found = routesIn(path, source, cleaned);
    routes.push(...found.routes);
    unpaired.push(...found.unpaired);
  }
  if (unpaired.length > 0) {
    console.error('❌ these daemon route objects are structurally unreadable:');
    for (const entry of unpaired) console.error(`   ${entry}`);
    console.error('   Fix the pass. A route it cannot read is a route it cannot hold anybody to.');
    process.exit(2);
  }
  if (routes.length === 0) {
    console.error(`❌ found no routes in ${SERVER_PACKAGE} — refusing to report a vacuous pass`);
    process.exit(2);
  }

  // The prefixes worth recognising are the ones the daemon actually serves, derived rather than
  // listed: a gate that knew only about `/v1/` would silently ignore `/usage`, `/metrics` and
  // `/healthz`, and silence is what an under-match sounds like.
  const prefixes = new Set(routes.map(route => `/${route.path.split('/')[1] ?? ''}`));
  const shared = sharedNames(clientFiles);
  const helpers = sharedVerbHelpers(clientFiles);
  const calls: Call[] = [];
  for (const [path, { source, cleaned }] of clientFiles) {
    // Each observation resolves against exported identifier constants, the bindings in its own lexical
    // container chain, and the parameters of the declaration it sits inside. One method's `const path`
    // must never answer for another method's `path` parameter merely because both live in the file.
    const { bindings } = namesIn(source, cleaned);
    const scoped = scopedBindingsIn(source, cleaned, prefixes);
    calls.push(...callsIn(path, source, cleaned, shared, bindings, scoped, prefixes, helpers));
  }
  if (calls.length === 0) {
    console.error('❌ found no client path observations at any served prefix — refusing to report a vacuous pass');
    process.exit(2);
  }
  const dialCalls = calls.filter(call => call.kind === 'dial');
  const mentionCalls = calls.filter(call => call.kind === 'mention');
  if (dialCalls.length === 0) {
    console.error('❌ found path mentions but no client dials — refusing to report a vacuous client pass');
    process.exit(2);
  }
  for (const requiredPackage of REQUIRED_DIAL_PACKAGES) {
    const prefix = `${requiredPackage}/`;
    if (![...clientFiles.keys()].some(path => path.startsWith(prefix))) {
      console.error(`❌ required client package has no production source files: ${requiredPackage}`);
      process.exit(2);
    }
    if (!dialCalls.some(call => call.where.startsWith(prefix))) {
      console.error(`❌ required client package produced zero daemon dials: ${requiredPackage}`);
      process.exit(2);
    }
  }

  const findings: Finding[] = [];
  const seenUnserved = new Set<string>();
  for (const call of dialCalls) {
    if (routes.some(route => agrees(route, call))) continue;
    const target = `${call.verb} ${call.path}`;
    if (seenUnserved.has(target)) continue;
    seenUnserved.add(target);
    findings.push({
      direction: 'unserved',
      target,
      where: call.where,
      why: `no daemon route answers ${target} — a caller reaching it gets a 404 that renders as an empty case`,
    });
  }
  const seenUnreached = new Set<string>();
  const seenUnproven = new Set<string>();
  for (const route of routes) {
    const target = `${route.verb} ${route.path}`;
    const reaching = dialCalls.filter(call => agrees(route, call));
    if (reaching.length === 0) {
      if (seenUnreached.has(target)) continue;
      seenUnreached.add(target);
      findings.push({
        direction: 'unreached',
        target,
        where: route.where,
        why: `nothing outside ${SERVER_PACKAGE} dials ${target} — it is dead, or it is a surface no shipped client uses yet`,
      });
      continue;
    }
    // Reached, but by nothing that names a verb. The address is proved; the METHOD is not, and this is
    // the only place that can say so — the dials themselves agree, so neither direction above fires.
    if (reaching.some(call => call.verb !== ANY_VERB)) continue;
    if (seenUnproven.has(target)) continue;
    seenUnproven.add(target);
    findings.push({
      direction: 'verb-unproven',
      target,
      where: route.where,
      why: `${target} is reached only by dials whose init this pass cannot read (${[...new Set(reaching.map(call => call.where))].join(', ')}), so changing its method would still agree`,
    });
  }

  const relativeAllowlist = relative(root, allowlistPath);
  const allowed = parseAllowlist(allowlistPath, relativeAllowlist);
  const allowedKeys = new Set(allowed.map(entry => `${entry.direction} ${entry.target}`));
  const matched = new Set<string>();
  const unallowed = findings.filter(finding => {
    const key = `${finding.direction} ${finding.target}`;
    if (allowedKeys.has(key)) {
      matched.add(key);
      return false;
    }
    return true;
  });
  const stale = allowed.filter(entry => !matched.has(`${entry.direction} ${entry.target}`));

  if (unallowed.length > 0) {
    const disagreements = unallowed.filter(finding => finding.direction !== 'verb-unproven');
    const unproven = unallowed.filter(finding => finding.direction === 'verb-unproven');
    const report = (finding: Finding): void => {
      console.error(`   ${finding.where}`);
      console.error(`     ${finding.why}`);
      console.error(`     allow deliberately with: ${finding.direction} ${finding.target} # <why this is correct>`);
    };
    if (disagreements.length > 0) {
      console.error('❌ the two ends of these calls do not agree:');
      for (const finding of disagreements) report(finding);
    }
    if (unproven.length > 0) {
      console.error("❌ these routes are reached, but their METHOD is not proved by any dial's verb:");
      for (const finding of unproven) report(finding);
      console.error('   Prefer making the verb readable at the dial. Declaring it is the fallback, and a');
      console.error('   declaration names the SERVED verb, so changing the method invalidates the line.');
    }
    console.error('   The rule and the reasoning: docs/standards/contracts/README.md#route-agreement');
  }
  if (stale.length > 0) {
    console.error(`❌ ${relativeAllowlist} has entries that no longer describe anything:`);
    for (const entry of stale) {
      console.error(`   ${relativeAllowlist}:${entry.line}: ${entry.direction} ${entry.target}`);
    }
    console.error('   Delete the line in the same change that closed it — the list may only ever shrink.');
  }
  if (unallowed.length > 0 || stale.length > 0) process.exit(1);

  const observationsByPackage = new Map<string, { files: number; dials: number; mentions: number }>();
  for (const packageDirectory of packages.filter(each => each !== SERVER_PACKAGE)) {
    const prefix = `${packageDirectory}/`;
    observationsByPackage.set(packageDirectory, {
      files: [...clientFiles.keys()].filter(path => path.startsWith(prefix)).length,
      dials: calls.filter(call => call.kind === 'dial' && call.where.startsWith(prefix)).length,
      mentions: calls.filter(call => call.kind === 'mention' && call.where.startsWith(prefix)).length,
    });
  }
  const unknownVerbDials = dialCalls.filter(call => call.verb === ANY_VERB);
  const unknownSegmentDials = dialCalls.filter(call => call.path.includes(UNKNOWN_SEGMENT));
  // Every verb-unproven route is DECLARED by the time this line runs, or the gate has already failed, so
  // the honest number to print is that there are none left undeclared. The declared count is printed
  // beside it because it is the size of the debt, and it shrinks as verbs become readable.
  const declaredUnproven = allowed.filter(entry => entry.direction === 'verb-unproven').length;

  console.log(
    `✅ route agreement holds: ${routes.length} literal {method,path} declaration-pair units across ${serverFiles.size} files under packages/daemon/src/lib/{api/routes,runtime/mounts}/**/*.{ts,tsx}; ${calls.length} resolved client path-observation units (${dialCalls.length} dials, ${mentionCalls.length} mentions) across ${clientFiles.size} non-daemon packages/*/{src,bin}/**/*.{ts,tsx} files; ${allowed.length} exact reviewed exemption-line units`,
  );
  console.log(
    `   Conservative dial units: ${unknownVerbDials.length} with an unreadable verb; ${unknownSegmentDials.length} with at least one unresolved path segment`,
  );
  console.log(
    `   Verb proof: 0 undeclared verb-unproven route units; ${declaredUnproven} of ${routes.length} declared, each naming the SERVED verb so a method change invalidates its line`,
  );
  console.log('   Client observation breakdown (file units; dial units; non-dial address-mention units):');
  for (const [packageDirectory, counts] of observationsByPackage) {
    console.log(`   ${packageDirectory}: ${counts.files} files; ${counts.dials} dials; ${counts.mentions} mentions`);
  }
  console.log('   It proves the two ENDS of a call agree. It cannot prove a client is capable of making it.');
}

main();
