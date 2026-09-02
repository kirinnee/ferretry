/**
 * Closed-set agreement gate: a member copied across package boundaries cannot disappear silently.
 *
 * ## THE DEFECT
 *
 * `DAEMON_CAPABILITIES` owns the closed capability set in `@ferretry/protocol`, while the daemon's
 * configuration schema needs a literal Zod field map. The mapped type on that map now proves that
 * every protocol capability is present; this gate keeps independently comparing the source shapes
 * while the owner decides whether the redundant detector should be removed.
 *
 * `PushNotificationKindSchema` and the PWA's `NOTIFICATION_KIND_FIELDS` have the same shape. Its
 * mapped type likewise proves completeness, while `NOTIFICATION_KINDS` is derived from the map.
 *
 * This gate compares every registered pair in BOTH directions and rejects duplicate members. It is
 * deliberately a detector rather than the final ownership model. Wave 2a upgrades the first two
 * registered pairs to compiler-exhaustive maps, so they no longer need this gate for completeness;
 * the gate remains unchanged in scope pending the owner's deletion decision and still changes no
 * production behavior.
 *
 * ## WHY IT PARSES INSTEAD OF SCANNING FOR QUOTES — TWO MEASURED FAIL-OPENS
 *
 * The first version extracted members by collecting every quoted string inside the array slice, and
 * located the slice with `text.indexOf(marker)`. Both halves were fail-OPEN, and a fail-open in a
 * detection gate is worse than no gate, because a green run is then evidence of nothing.
 *
 *   ELEMENTS IT COULD NOT SEE.   `const EXTRA_CAPABILITY = 'audio';` followed by
 *                                `DAEMON_CAPABILITIES = [… 'pairing', EXTRA_CAPABILITY]` is a SEVEN
 *                                member set. A quote scan reports six, matches the six in the daemon,
 *                                and exits 0. Spreads, holes, nested values and interpolated
 *                                templates all disappear the same way; a nested `['x']` was worse
 *                                than invisible, because its member was flattened into the outer set.
 *                                Same shape in the grants document: an extra `audio: z.boolean()`
 *                                entry is not a `grantSchemaFor` entry, so the entry regex skipped it
 *                                and the gate compared six against six while the schema accepted a
 *                                seventh key.
 *
 *   A MARKER IN A COMMENT.       `indexOf` cannot tell code from prose. A docblock above the real
 *                                declaration that quotes `DAEMON_CAPABILITIES = ['fleet', …]` — which
 *                                is exactly how this repository documents its lists — was found
 *                                FIRST, so the gate read the comment's example. A prose list that
 *                                still matches the replica keeps the build green over any real
 *                                declaration at all.
 *
 * So: every registered slice is now parsed STRUCTURALLY EXHAUSTIVELY. Anything in it that is not one
 * of the shapes named below is a gate bug, exit 2 — never a member the gate quietly skips. And the
 * declaration is anchored: exactly one occurrence of the marker in CODE, or exit 2.
 *
 * The lexer classifies the whole file once into code, comment and string-literal spans, so a marker,
 * a bracket and a member are each read in the state they actually occur in. An unterminated quoted
 * string is treated as a single ordinary character rather than a string that swallows the rest of the
 * file — `route-agreement.ts` learned that from `.tsx`, where an apostrophe in JSX text is not a
 * quote. The failure mode of any residual desync is a marker that no longer reads as code, which is
 * exit 2 rather than a silent pass.
 *
 * ## FILE SET, PATTERN, AND UNIT
 *
 * The file set is the five exact production files named in AGREEMENTS below. One extracted
 * member/key is one unit. Every slice must satisfy its shape completely:
 *
 *   ARRAY    `[` then only quoted string members separated by commas, one optional trailing comma,
 *            with comments and whitespace allowed anywhere. A member is `'…'` or `"…"` naming a plain
 *            identifier-shaped value — never an identifier, spread, hole, nested array or object,
 *            template literal, or any other expression.
 *   OBJECT   `{` then only the entry shape the registered map names, separated by commas, one optional
 *            trailing comma, comments allowed. No spread, computed or quoted key, shorthand, or
 *            extra expressions are permitted.
 *
 * Zero members, a duplicate member, a marker that is absent or declared twice in code, a delimiter
 * that is not where it must be, and a key whose grant argument names another capability are all gate
 * bugs. None of them is ever reported as a compliant zero.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Enumeration {
  readonly label: string;
  readonly file: string;
  readonly pattern: string;
  readonly members: readonly string[];
}

interface Agreement {
  readonly id: string;
  readonly owner: Enumeration;
  readonly replica: Enumeration;
}

/** A gate bug, never a code finding. */
function fail(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(2);
}

const rootArgument = process.argv[2];
if (rootArgument === undefined) fail('usage: closed-set-agreement.ts <repo-root>');
const root = resolve(rootArgument);

function source(file: string): string {
  const absolute = resolve(root, file);
  if (!existsSync(absolute)) fail(`closed-set input is missing: ${file}`);
  return readFileSync(absolute, 'utf8');
}

/** The 1-indexed line an offset falls on, so every refusal is a coordinate a reader can open. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === '\n') line += 1;
  }
  return line;
}

/** What the parser is looking at, for a message that names the shape it refused. */
function snippet(text: string, offset: number): string {
  return JSON.stringify(text.slice(offset, offset + 32).split('\n')[0] ?? '');
}

// ─── lexing ───────────────────────────────────────────────────────────────────────────────────

const CODE = 0;
const TRIVIA = 1;
const TEXT = 2;

/**
 * Classify every character of a file as code, comment or string-literal content.
 *
 * One pass over the whole file rather than a state machine repeated at each probe, because the three
 * questions this gate asks — is this marker code, is this bracket code, is this member a literal —
 * are the same question about three offsets, and answering it four different ways is how the
 * comment-marker fail-open survived.
 */
function classify(file: string, text: string): Uint8Array {
  const kind = new Uint8Array(text.length);
  let index = 0;

  const mark = (from: number, to: number, value: number): void => {
    for (let at = from; at < to; at += 1) kind[at] = value;
  };

  while (index < text.length) {
    const current = text[index];
    const next = text[index + 1];

    if (current === '/' && next === '/') {
      const start = index;
      while (index < text.length && text[index] !== '\n') index += 1;
      mark(start, index, TRIVIA);
      continue;
    }

    if (current === '/' && next === '*') {
      const start = index;
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      if (index >= text.length) {
        fail(`${file}:${lineAt(text, start)}: unterminated block comment — the closed-set lexer desynced`);
      }
      index += 2;
      mark(start, index, TRIVIA);
      continue;
    }

    if (current === "'" || current === '"' || current === '`') {
      const start = index;
      let cursor = index + 1;
      let closed = false;
      while (cursor < text.length) {
        if (text[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (text[cursor] === current) {
          cursor += 1;
          closed = true;
          break;
        }
        // Only a template may cross a line. An apostrophe in JSX TEXT would otherwise open a string
        // that swallows the rest of the file, which is the one desync that reads as compliance.
        if (current !== '`' && text[cursor] === '\n') break;
        cursor += 1;
      }
      if (!closed) {
        if (current === '`') {
          fail(`${file}:${lineAt(text, start)}: unterminated template literal — the closed-set lexer desynced`);
        }
        kind[start] = CODE;
        index = start + 1;
        continue;
      }
      mark(start, cursor, TEXT);
      index = cursor;
      continue;
    }

    kind[index] = CODE;
    index += 1;
  }

  return kind;
}

function isCodeSpan(kind: Uint8Array, from: number, length: number): boolean {
  for (let at = from; at < from + length; at += 1) {
    if (kind[at] !== CODE) return false;
  }
  return true;
}

/**
 * True when a marker occurrence is a whole token rather than the tail of a longer one.
 *
 * `SECOND_DAEMON_CAPABILITIES =` contains `DAEMON_CAPABILITIES =`. A substring match counted it as a
 * declaration, and if the real one were ever renamed that neighbour's array would have been read as
 * the closed set — the same fail-open as reading a comment, one identifier further along. The
 * trailing check is the mirror case: `DAEMON_CAPABILITIES ==` is a comparison, not a declaration.
 */
function isWholeToken(text: string, marker: string, at: number): boolean {
  const before = text[at - 1];
  if (/[\w$]/u.test(marker[0] ?? '') && before !== undefined && /[\w$]/u.test(before)) return false;
  const last = marker[marker.length - 1] ?? '';
  const after = text[at + marker.length];
  if (after === undefined) return true;
  if (/[\w$]/u.test(last) && /[\w$]/u.test(after)) return false;
  return !(last === '=' && after === '=');
}

/**
 * The single offset where a declaration marker occurs in CODE.
 *
 * Zero and several are both exit 2. Zero means the probe is aimed at something that is not there any
 * more; several means it cannot know which one it is holding the repository to. Neither may be
 * resolved by picking one, which is what `indexOf` silently did.
 */
function soleDeclaration(file: string, text: string, kind: Uint8Array, marker: string): number {
  const found: number[] = [];
  for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + 1)) {
    if (isCodeSpan(kind, at, marker.length) && isWholeToken(text, marker, at)) found.push(at);
  }
  if (found.length === 0) {
    fail(`${file}: no CODE declaration of ${JSON.stringify(marker)} — a match in a comment or a string is not one`);
  }
  if (found.length > 1) {
    const lines = found.map(at => lineAt(text, at)).join(', ');
    fail(
      `${file}: ${found.length} code declarations of ${JSON.stringify(marker)} (lines ${lines}) — which one is the owner?`,
    );
  }
  return found[0] as number;
}

/** The next offset that is neither whitespace nor part of a comment. */
function skipTrivia(text: string, kind: Uint8Array, from: number): number {
  let index = from;
  while (index < text.length && (kind[index] === TRIVIA || /\s/u.test(text[index] ?? ''))) index += 1;
  return index;
}

/**
 * The offset of an expected delimiter, allowing only trivia before it.
 *
 * Only trivia, deliberately: the first version scanned forward for the next bracket, so a marker
 * whose array had been replaced by an identifier silently adopted some unrelated `[` further down
 * the file and reported its contents as the closed set.
 */
function expectAt(file: string, text: string, kind: Uint8Array, from: number, character: string, what: string): number {
  const index = skipTrivia(text, kind, from);
  if (text[index] !== character || kind[index] !== CODE) {
    fail(
      `${file}:${lineAt(text, index)}: ${what} must be followed by ${JSON.stringify(character)}, found ${snippet(text, index)}`,
    );
  }
  return index;
}

/**
 * The offset after an expected identifier, allowing only trivia before it.
 *
 * The companion to `expectAt` for the token halves of a builder chain: together they let a declaration
 * be followed to its object one token at a time, so no step is a search that could land anywhere else
 * in the file.
 */
function expectIdentifier(
  file: string,
  text: string,
  kind: Uint8Array,
  from: number,
  expected: string,
  what: string,
): number {
  const index = skipTrivia(text, kind, from);
  const found = readIdentifier(text, kind, index);
  if (found !== expected) {
    fail(`${file}:${lineAt(text, index)}: ${what} must be ${JSON.stringify(expected)}, found ${snippet(text, index)}`);
  }
  return index + expected.length;
}

/** The offset of the delimiter closing the one opened at `openAt`. */
function balancedEnd(
  file: string,
  text: string,
  kind: Uint8Array,
  openAt: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  for (let index = openAt; index < text.length; index += 1) {
    if (kind[index] !== CODE) continue;
    if (text[index] === open) depth += 1;
    else if (text[index] === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return fail(`${file}:${lineAt(text, openAt)}: unterminated ${open}${close} expression`);
}

/** A closed-set member is a name. Anything else is a way to write one member as two. */
const MEMBER_SHAPE = /^[A-Za-z][A-Za-z0-9_.:-]*$/u;

interface Literal {
  readonly value: string;
  /** The offset after the closing quote. */
  readonly end: number;
}

/** The quoted string literal beginning at `offset`, or exit 2 when there is not one there. */
function readLiteral(file: string, text: string, kind: Uint8Array, offset: number, what: string): Literal {
  const quote = text[offset];
  if ((quote !== "'" && quote !== '"') || kind[offset] !== TEXT) {
    fail(
      `${file}:${lineAt(text, offset)}: ${what} must be a single-or-double-quoted string, found ${snippet(text, offset)}`,
    );
  }
  let value = '';
  let index = offset + 1;
  while (index < text.length) {
    const current = text[index];
    if (current === '\\') {
      fail(
        `${file}:${lineAt(text, offset)}: ${what} must not contain an escape — two spellings of one member is the defect`,
      );
    }
    if (current === quote) break;
    value += current;
    index += 1;
  }
  if (text[index] !== quote) fail(`${file}:${lineAt(text, offset)}: ${what} is an unterminated quoted member`);
  if (!MEMBER_SHAPE.test(value)) {
    fail(`${file}:${lineAt(text, offset)}: ${what} is not a member name: ${JSON.stringify(value)}`);
  }
  return { value, end: index + 1 };
}

/** The identifier beginning at `offset` in code, or `undefined`. */
function readIdentifier(text: string, kind: Uint8Array, offset: number): string | undefined {
  if (kind[offset] !== CODE || !/[A-Za-z_$]/u.test(text[offset] ?? '')) return undefined;
  let index = offset;
  while (index < text.length && kind[index] === CODE && /[\w$]/u.test(text[index] ?? '')) index += 1;
  return text.slice(offset, index);
}

// ─── the two shapes a registered enumeration may take ─────────────────────────────────────────

/**
 * Every member of one array literal, refusing anything that is not a quoted string member.
 *
 * The walk alternates member and separator rather than collecting whatever looks like a string,
 * because "whatever looks like a string" is what let `[… , EXTRA_CAPABILITY]` read as a six-member
 * set. A `,` where a member belongs is an array HOLE; at the end of the list it is the trailing comma
 * this repository's formatter writes.
 */
function arrayMembers(
  file: string,
  text: string,
  kind: Uint8Array,
  openAt: number,
  closeAt: number,
  what: string,
): string[] {
  const members: string[] = [];
  let index = openAt + 1;
  let expecting: 'member' | 'separator' = 'member';

  for (;;) {
    index = skipTrivia(text, kind, index);
    if (index >= closeAt) break;

    if (expecting === 'separator') {
      if (text[index] === ',' && kind[index] === CODE) {
        expecting = 'member';
        index += 1;
        continue;
      }
      fail(`${file}:${lineAt(text, index)}: ${what} expects ',' or ']' after a member, found ${snippet(text, index)}`);
    }

    if (text[index] === ',' && kind[index] === CODE) {
      fail(`${file}:${lineAt(text, index)}: ${what} has an array hole — a missing member is not an empty one`);
    }
    if (kind[index] !== TEXT) {
      fail(
        `${file}:${lineAt(text, index)}: ${what} may contain only quoted string members — found ${snippet(text, index)}`,
      );
    }

    const literal = readLiteral(file, text, kind, index, `${what} member`);
    members.push(literal.value);
    index = literal.end;
    expecting = 'separator';
  }

  return members;
}

/**
 * Every key of the grants document, refusing any entry that is not exactly one supported entry.
 *
 * Exhaustive rather than pattern-matched: the entry regex it replaces extracted the six conforming
 * entries and stepped over anything else, so an extra key the schema really accepted was invisible.
 */
function grantEntries(file: string, text: string, kind: Uint8Array, openAt: number, closeAt: number): string[] {
  const what = "CapabilityGrantsDocumentSchema entries are exactly `<key>: grantSchemaFor('<key>')`";
  const members: string[] = [];
  let index = openAt + 1;
  let expecting: 'entry' | 'separator' = 'entry';

  for (;;) {
    index = skipTrivia(text, kind, index);
    if (index >= closeAt) break;

    if (expecting === 'separator') {
      if (text[index] === ',' && kind[index] === CODE) {
        expecting = 'entry';
        index += 1;
        continue;
      }
      fail(`${file}:${lineAt(text, index)}: nothing may follow a grant entry — found ${snippet(text, index)}`);
    }

    const key = readIdentifier(text, kind, index);
    if (key === undefined) {
      fail(`${file}:${lineAt(text, index)}: ${what} — found ${snippet(text, index)}`);
    }
    index = expectAt(file, text, kind, index + key.length, ':', `grant key ${key}`) + 1;

    index = skipTrivia(text, kind, index);
    const callee = readIdentifier(text, kind, index);
    if (callee !== 'grantSchemaFor') {
      fail(
        `${file}:${lineAt(text, index)}: grant key ${key} is not a grantSchemaFor call — found ${snippet(text, index)}`,
      );
    }
    index = expectAt(file, text, kind, index + callee.length, '(', `grantSchemaFor for ${key}`) + 1;

    index = skipTrivia(text, kind, index);
    const literal = readLiteral(file, text, kind, index, `the grantSchemaFor argument for ${key}`);
    index = expectAt(file, text, kind, literal.end, ')', `grantSchemaFor('${literal.value}')`) + 1;

    // Preserved verbatim: a key answering for another capability is the original probe's own error.
    if (key !== literal.value) {
      console.error(`❌ ${file} maps capability key ${key} through grantSchemaFor(${JSON.stringify(literal.value)})`);
      process.exit(2);
    }

    members.push(key);
    expecting = 'separator';
  }

  return members;
}

/** Every key of a literal boolean key map, refusing any entry that is not exactly `<key>: true`. */
function trueEntries(file: string, text: string, kind: Uint8Array, openAt: number, closeAt: number): string[] {
  const what = 'notification key-map entries are exactly `<key>: true`';
  const members: string[] = [];
  let index = openAt + 1;
  let expecting: 'entry' | 'separator' = 'entry';

  for (;;) {
    index = skipTrivia(text, kind, index);
    if (index >= closeAt) break;

    if (expecting === 'separator') {
      if (text[index] === ',' && kind[index] === CODE) {
        expecting = 'entry';
        index += 1;
        continue;
      }
      fail(
        `${file}:${lineAt(text, index)}: nothing may follow a notification key-map entry — found ${snippet(text, index)}`,
      );
    }

    const key = readIdentifier(text, kind, index);
    if (key === undefined) fail(`${file}:${lineAt(text, index)}: ${what} — found ${snippet(text, index)}`);
    index = expectAt(file, text, kind, index + key.length, ':', `notification key ${key}`) + 1;
    index = expectIdentifier(file, text, kind, index, 'true', `the value for notification key ${key}`);
    members.push(key);
    expecting = 'separator';
  }

  return members;
}

function literalArray(file: string, marker: string, label: string): Enumeration {
  const text = source(file);
  const kind = classify(file, text);
  const markerAt = soleDeclaration(file, text, kind, marker);
  const openAt = expectAt(file, text, kind, markerAt + marker.length, '[', `the declaration ${JSON.stringify(marker)}`);
  const closeAt = balancedEnd(file, text, kind, openAt, '[', ']');
  const members = arrayMembers(file, text, kind, openAt, closeAt, `${marker} [...]`);
  return { label, file, pattern: `quoted members of ${marker} [...]`, members };
}

function grantObject(file: string, label: string): Enumeration {
  const text = source(file);
  const kind = classify(file, text);
  const schemaMarker = 'CapabilityGrantsDocumentSchema =';
  const schemaAt = soleDeclaration(file, text, kind, schemaMarker);
  // ADJACENT, token by token, never a forward search for the next `.strictObject(`.
  //
  // Searching forward adopted an unrelated object with no way to tell. Reassign the declaration to a
  // NARROWER schema — `= NarrowGrantsSchema;`, or `= z.object({…})` with a capability dropped — and
  // leave any later `z.strictObject` in the file that still spells all six, and the scan read the
  // later one: six against six, exit 0, over a document the daemon parses with five. The decoy does
  // not even have to be planted. `grantSchemaFor`'s own strict object is declared ABOVE this marker
  // precisely because the six entries were extracted once already, and the next refactor that moves a
  // reusable field map BELOW it re-creates the shape.
  //
  // So the chain from the schema to the field map is spelled out: `z` `.` `strictObject` `(` then
  // `CAPABILITY_GRANT_FIELDS`, with only trivia allowed between tokens. A refactor that changes the
  // builder is exit 2 — a probe that has to be re-aimed deliberately, which is the honest answer.
  let cursor = expectIdentifier(
    file,
    text,
    kind,
    schemaAt + schemaMarker.length,
    'z',
    `the declaration ${schemaMarker}`,
  );
  cursor = expectAt(file, text, kind, cursor, '.', 'the zod builder for the grants document') + 1;
  cursor = expectIdentifier(file, text, kind, cursor, 'strictObject', 'the zod builder for the grants document');
  cursor = expectAt(file, text, kind, cursor, '(', 'z.strictObject for the grants document') + 1;
  expectIdentifier(
    file,
    text,
    kind,
    cursor,
    'CAPABILITY_GRANT_FIELDS',
    'z.strictObject field map for the grants document',
  );

  const marker = 'CAPABILITY_GRANT_FIELDS =';
  const markerAt = soleDeclaration(file, text, kind, marker);
  const openAt = expectAt(file, text, kind, markerAt + marker.length, '{', `the declaration ${marker}`);
  const closeAt = balancedEnd(file, text, kind, openAt, '{', '}');
  const members = grantEntries(file, text, kind, openAt, closeAt);
  return {
    label,
    file,
    pattern: "<key>: grantSchemaFor('<member>') entries in CapabilityGrantsDocumentSchema",
    members,
  };
}

function trueObject(file: string, marker: string, label: string): Enumeration {
  const text = source(file);
  const kind = classify(file, text);
  const markerAt = soleDeclaration(file, text, kind, marker);
  const openAt = expectAt(file, text, kind, markerAt + marker.length, '{', `the declaration ${JSON.stringify(marker)}`);
  const closeAt = balancedEnd(file, text, kind, openAt, '{', '}');
  const members = trueEntries(file, text, kind, openAt, closeAt);
  return { label, file, pattern: `<key>: true entries in ${marker}`, members };
}

const agreements: readonly Agreement[] = [
  {
    id: 'daemon-capabilities',
    owner: literalArray(
      'packages/protocol/src/lib/grants.ts',
      'DAEMON_CAPABILITIES =',
      '@ferretry/protocol DAEMON_CAPABILITIES',
    ),
    replica: grantObject('packages/daemon/src/lib/runtime/config.ts', 'daemon CapabilityGrantsDocumentSchema keys'),
  },
  {
    id: 'push-notification-kinds',
    owner: literalArray(
      'packages/protocol/src/lib/push.ts',
      'PushNotificationKindSchema = z.enum(',
      '@ferretry/protocol PushNotificationKindSchema',
    ),
    replica: trueObject(
      'packages/pwa/src/lib/notification-preferences.ts',
      'NOTIFICATION_KIND_FIELDS =',
      'PWA NOTIFICATION_KIND_FIELDS',
    ),
  },
  {
    // The disclosure that says whether an account is still holding this host's own login. The two
    // sides never import each other — the daemon publishes a code and each surface owns its words —
    // so a state added on one side and not rendered on the other is exactly the silent gap this gate
    // exists for, on a row that is about somebody's credential.
    id: 'seed-provenance-states',
    owner: literalArray(
      'packages/fleet/src/lib/seed-provenance.ts',
      'FleetSeedProvenanceStateSchema = z.enum(',
      '@ferretry/fleet FleetSeedProvenanceStateSchema',
    ),
    replica: literalArray(
      'packages/pwa/src/lib/account-picker-catalog.ts',
      'PickerSeedProvenanceStateSchema = z.enum(',
      'PWA PickerSeedProvenanceStateSchema',
    ),
  },
  {
    // The MEASUREMENT CLAIM about a harness's refresh tokens: `single_use` is established for Codex,
    // `unproven` is the honest answer for Claude. If these two ever disagree, one surface is asserting
    // something the other refuses to, which is the failure the whole feature is written around.
    id: 'harness-refresh-rotation',
    owner: literalArray(
      'packages/fleet/src/lib/seed-provenance.ts',
      'HarnessRefreshRotationSchema = z.enum(',
      '@ferretry/fleet HarnessRefreshRotationSchema',
    ),
    replica: literalArray(
      'packages/pwa/src/lib/account-picker-catalog.ts',
      'PickerRefreshRotationSchema = z.enum(',
      'PWA PickerRefreshRotationSchema',
    ),
  },
  {
    id: 'push-notification-settings-kinds',
    owner: literalArray(
      'packages/protocol/src/lib/push.ts',
      'PushNotificationKindSchema = z.enum(',
      '@ferretry/protocol PushNotificationKindSchema',
    ),
    replica: literalArray(
      'packages/pwa/src/features/settings/notification-settings.tsx',
      'const kinds: readonly PushNotificationKind[] =',
      'PWA notification settings kinds',
    ),
  },
];

if (agreements.length === 0) fail('closed-set registry is empty — refusing to report a vacuous pass');

let status = 0;
for (const agreement of agreements) {
  for (const enumeration of [agreement.owner, agreement.replica]) {
    if (enumeration.members.length === 0) {
      console.error(`❌ ${agreement.id}: ${enumeration.label} produced zero members`);
      console.error(`   file set: ${enumeration.file}`);
      console.error(`   pattern: ${enumeration.pattern}`);
      process.exit(2);
    }
    const unique = new Set(enumeration.members);
    if (unique.size !== enumeration.members.length) {
      const duplicates = [...unique].filter(
        member => enumeration.members.filter(candidate => candidate === member).length > 1,
      );
      console.error(`❌ ${agreement.id}: ${enumeration.label} repeats members: ${duplicates.join(', ')}`);
      process.exit(2);
    }
  }

  const owner = new Set(agreement.owner.members);
  const replica = new Set(agreement.replica.members);
  const ownerOnly = [...owner].filter(member => !replica.has(member));
  const replicaOnly = [...replica].filter(member => !owner.has(member));
  if (ownerOnly.length === 0 && replicaOnly.length === 0) continue;

  status = 1;
  console.error(`❌ closed set disagrees: ${agreement.id}`);
  console.error(`   owner: ${agreement.owner.file} (${agreement.owner.pattern})`);
  console.error(`   replica: ${agreement.replica.file} (${agreement.replica.pattern})`);
  if (ownerOnly.length > 0) console.error(`   missing from replica: ${ownerOnly.join(', ')}`);
  if (replicaOnly.length > 0) console.error(`   absent from owner: ${replicaOnly.join(', ')}`);
}

if (status !== 0) process.exit(status);

console.log(`✅ closed-set agreement holds for ${agreements.length} registered enumeration pairs`);
for (const agreement of agreements) {
  console.log(
    `   ${agreement.id}: ${agreement.owner.members.length} quoted owner members in ${agreement.owner.file} ↔ ${agreement.replica.members.length} ${agreement.replica.pattern} in ${agreement.replica.file}`,
  );
}
