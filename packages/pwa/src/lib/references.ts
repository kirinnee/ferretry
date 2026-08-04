/**
 * One canonical reference grammar and proof gate for every Markdown surface.
 *
 * References are authored as plain sigil tokens:
 *   `:agent`  `@file[:line[-end]]`  `&task`  `!attention`  `/skill` or `$skill`
 *   `:term/<id>` (terminal instance)  `:page/<id>` (browser page)
 *
 * A reference is a TOKEN, never a Markdown link. `[label](#fy-reference?…)`
 * written by hand is not a reference and never becomes one: the renderer only
 * trusts links this module's own transform produced.
 *
 * SKILLS ACCEPT TWO SIGILS AND MEAN ONE THING. Claude invokes a skill as
 * `/name` and Codex as `$name` (`features/skills/skills-catalog.ts` owns that
 * insertion contract), so both parse to the same `skill` reference and the
 * authored bytes are what the reader keeps seeing. `formatReference` answers
 * with the `/name` form because it is the one a reader can type on either
 * harness.
 *
 * TERMINALS AND BROWSER PAGES SHARE THE AGENT SIGIL, namespaced. `:` already
 * means "a live thing in this session you can open", and an agent callsign can
 * never contain `/` (`AGENT_NAME`), so `:term/<id>` and `:page/<id>` cannot
 * collide with `:zelda` — an agent literally named `term` still resolves as
 * `:term`. Handover #64 supplies the live proof and the click destinations for
 * both kinds; until it does, an instance token has no resolver and stays prose,
 * which is the same rule every other kind obeys.
 *
 * **Syntax is never existence proof.** `findReferences` reports lexical
 * candidates; `resolveReference` requires the appropriate live resolver; and
 * `remarkReferences` creates a link only after that resolver proves the target.
 * The React renderer re-proves the reserved href and the transform-origin marker
 * before exposing a click, so a link the model wrote into its own prose cannot
 * become a real destination.
 *
 * The composer's highlight overlay only ever needs the lexical reading: it
 * colours what the reader typed, and colour is not a claim that the target
 * exists.
 *
 * MULTI-DAEMON. kteam resolved an agent to a bare session id and linked to
 * `/session/:id`, because there was one daemon. Here a resolved agent carries the
 * `DaemonId` it was proved against and links to `/d/:daemon/session/:id`, so a
 * reference in one daemon's transcript can never open a same-named session on
 * another daemon.
 *
 * Ported from kteam's `src/lib/references.ts`.
 */

import type { AttentionId } from '@ferretry/protocol';
import type { DaemonId } from './daemon-connection.ts';

export interface AgentReference {
  readonly kind: 'agent';
  readonly name: string;
}

export interface CodeReference {
  /** Session-root-relative path after resolution. */
  readonly path: string;
  /** 1-based source line. Absent means "open this file". */
  readonly line?: number;
  /** Inclusive 1-based range end. */
  readonly endLine?: number;
}

export interface FileReference extends CodeReference {
  readonly kind: 'file';
}

export interface TaskReference {
  readonly kind: 'task';
  readonly id: string;
}

export interface AttentionReference {
  readonly kind: 'attention';
  readonly id: AttentionId;
}

export interface SkillReference {
  readonly kind: 'skill';
  /** Canonical lowercase skill name, without either sigil. */
  readonly name: string;
}

/** One registered terminal instance inside the surface's own session. */
export interface TerminalReference {
  readonly kind: 'terminal';
  readonly id: string;
}

/** One registered browser page inside the surface's own session. */
export interface BrowserPageReference {
  readonly kind: 'browser';
  readonly id: string;
}

export type Reference =
  | AgentReference
  | FileReference
  | TaskReference
  | AttentionReference
  | SkillReference
  | TerminalReference
  | BrowserPageReference;

/** An agent reference that a live fleet has proved, daemon and session both. */
export interface ResolvedAgentReference extends AgentReference {
  readonly daemonId: DaemonId;
  readonly sessionId: string;
}

export type ResolvedReference =
  | ResolvedAgentReference
  | FileReference
  | TaskReference
  | AttentionReference
  | SkillReference
  | TerminalReference
  | BrowserPageReference;

export interface ReferenceMatch {
  readonly reference: Reference;
  readonly raw: string;
  /** Offset of the sigil in the scanned string; the prefix character is not part of the match. */
  readonly start: number;
  readonly end: number;
}

const INTEGER = /^[1-9][0-9]*$/u;
const FILE_TOKEN = /^@(?!@)([/.\p{L}\p{N}_+@#-]*[\p{L}\p{N}_+@#-])(?::([1-9][0-9]*)(?:-([1-9][0-9]*))?)?$/u;
const AGENT_NAME = /^[a-z][a-z0-9-]{0,31}$/iu;
const AGENT_TOKEN = /^:([a-z][a-z0-9-]{0,31})$/iu;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TASK_ID = /^[BFIC][0-9]{1,9}$/iu;
const TASK_TOKEN = /^&([BFIC][0-9]{1,9})$/iu;
const ATTENTION_ID = /^A[1-9][0-9]*$/u;
const ATTENTION_TOKEN = /^!(A[1-9][0-9]*)$/u;
// A skill name is a directory name on the host, so the grammar is deliberately
// narrower than the filesystem: lowercase words and hyphens only. Namespaced
// forms a harness may accept elsewhere (`plugin:skill`, `apps/web:deploy`) are
// NOT references, because their separators are this grammar's own boundaries.
// LOWERCASE ONLY, unlike an agent callsign. A skill name is a directory name,
// not a daemon-normalised identity, and `$HOME`/`$PATH` are far more common in
// prose and in code than a capitalised skill invocation is. Reading `$HOME` as
// `$home` would make the reference layer volunteer a candidate for every shell
// variable a message contains.
const SKILL_NAME = /^[a-z][a-z0-9-]{0,63}$/u;
const SKILL_TOKEN = /^[/$]([a-z][a-z0-9-]{0,63})$/u;
// Mirrors `TerminalIdSchema` — twelve lowercase hex digits, minted by the daemon.
const TERMINAL_ID = /^[a-f0-9]{12}$/u;
const TERMINAL_TOKEN = /^:term\/([a-f0-9]{12})$/u;
// A browser page id is the worker's own opaque target id, so the grammar bounds
// its shape and length rather than describing it. It must START and END
// alphanumeric: `.` and `-` are legal inside an id and are also ordinary
// sentence punctuation, so a trailing one would swallow the period that ends
// `open :page/PAGE-1.`
const BROWSER_PAGE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const BROWSER_PAGE_TOKEN = /^:page\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?)$/u;

// Each alternative owns its right boundary. A colon may naturally follow
// agent/task/attention prose, but it cannot terminate a file candidate because
// it could be the start of a malformed location suffix.
//
// Composed rather than written as one 500-character literal: seven alternatives
// sharing two boundary sets is exactly the shape a single literal hides. The
// alternatives are ordered longest-prefix-first so a namespaced instance token
// is never read as an agent callsign that happens to be followed by a slash.
// Ordinary quoted strings, not `String.raw`: a backtick is one of the boundary
// characters, and `String.raw` would keep the backslash that escaping it needs —
// which a `u`-mode character class rejects as an invalid escape.
const BOUNDARY_BEFORE = '(^|[\\s([{"\'`<>=—–])';
const BOUNDARY_AFTER = '(?=$|[\\s)\\]}"\'`,;!?<>:.=—–])';
const BOUNDARY_AFTER_FILE = '(?=$|[\\s)\\]}"\'`,;!?<>.=—–])';
const CANDIDATE_ALTERNATIVES = [
  `:term/[a-f0-9]{12}${BOUNDARY_AFTER}`,
  `:page/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?${BOUNDARY_AFTER}`,
  `:[a-z][a-z0-9-]{0,31}${BOUNDARY_AFTER}`,
  `&[BFIC][0-9]{1,9}${BOUNDARY_AFTER}`,
  `!A[1-9][0-9]*${BOUNDARY_AFTER}`,
  `[/$][a-z][a-z0-9-]{0,63}${BOUNDARY_AFTER}`,
  `@(?!@)[/.\\p{L}\\p{N}_+@#-]*[\\p{L}\\p{N}_+@#-](?::[1-9][0-9]*(?:-[1-9][0-9]*)?)?${BOUNDARY_AFTER_FILE}`,
];
const REFERENCE_CANDIDATE = new RegExp(`${BOUNDARY_BEFORE}(${CANDIDATE_ALTERNATIVES.join('|')})`, 'giu');

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !INTEGER.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function validPath(path: string): boolean {
  if (!path || /[\\\p{Cc}]/u.test(path) || path.endsWith('/') || path.endsWith('.')) return false;
  const withoutRoot = path.startsWith('/') ? path.slice(1) : path;
  const segments = withoutRoot.split('/');
  if (!segments.length || segments.some(segment => !segment || segment === '..')) return false;
  return !segments.some((segment, index) => segment === '.' && index !== 0);
}

function safeSessionId(value: string): boolean {
  return SESSION_ID.test(value) && value !== '.' && value !== '..';
}

function validCodeReference(reference: CodeReference): boolean {
  if (!validPath(reference.path)) return false;
  if (reference.line === undefined) return reference.endLine === undefined;
  if (!Number.isSafeInteger(reference.line) || reference.line < 1) return false;
  return (
    reference.endLine === undefined || (Number.isSafeInteger(reference.endLine) && reference.endLine >= reference.line)
  );
}

/** Parse one complete canonical token. No legacy sigils or implicit paths. */
export function parseReferenceToken(raw: string): Reference | null {
  const terminal = raw.match(TERMINAL_TOKEN);
  if (terminal?.[1]) return { kind: 'terminal', id: terminal[1] };

  const page = raw.match(BROWSER_PAGE_TOKEN);
  if (page?.[1]) return { kind: 'browser', id: page[1] };

  const agent = raw.match(AGENT_TOKEN);
  if (agent?.[1]) return { kind: 'agent', name: agent[1].toLowerCase() };

  const skill = raw.match(SKILL_TOKEN);
  if (skill?.[1]) return { kind: 'skill', name: skill[1].toLowerCase() };

  const task = raw.match(TASK_TOKEN);
  if (task?.[1]) return { kind: 'task', id: task[1].toUpperCase() };

  const attention = raw.match(ATTENTION_TOKEN);
  if (attention?.[1]) return { kind: 'attention', id: attention[1] as AttentionId };

  const file = raw.match(FILE_TOKEN);
  if (!file?.[1]) return null;
  const line = positiveInteger(file[2]);
  const endLine = positiveInteger(file[3]);
  const reference: FileReference = {
    kind: 'file',
    path: file[1],
    ...(line === undefined ? {} : { line }),
    ...(endLine === undefined ? {} : { endLine }),
  };
  return validCodeReference(reference) ? reference : null;
}

/** Find lexical candidates without claiming any target exists. */
export function findReferences(value: string): ReferenceMatch[] {
  const matches: ReferenceMatch[] = [];
  for (const match of value.matchAll(REFERENCE_CANDIDATE)) {
    const prefix = match[1] ?? '';
    const raw = match[2] ?? match[3] ?? match[4] ?? match[5];
    if (!raw || match.index === undefined) continue;
    const reference = parseReferenceToken(raw);
    if (!reference) continue;
    const start = match.index + prefix.length;
    matches.push({ reference, raw, start, end: start + raw.length });
  }
  return matches;
}

export interface AgentReferenceLookup {
  /** Stable identity. Used when re-proving an already-transformed link. */
  readonly sessionId?: string;
  /** Canonical lowercase callsign. Used for authored `:name` tokens. */
  readonly name?: string;
}

/** What a live fleet answers with: the daemon AND the session it proved. */
export interface ResolvedAgent {
  readonly daemonId: DaemonId;
  readonly sessionId: string;
  readonly name: string;
}

export type AgentReferenceResolver = (lookup: AgentReferenceLookup) => ResolvedAgent | null | undefined;
/** Answers a candidate path with its canonical session-relative path, or nothing. */
export type FileReferenceResolver = (candidatePath: string) => string | null | undefined;
export type TaskReferenceResolver = (id: string) => boolean;
export type AttentionReferenceResolver = (id: AttentionId) => boolean;
/** Answers whether this session's own skills catalog carries that name. */
export type SkillReferenceResolver = (name: string) => boolean;
/** Answers whether that terminal instance is registered in this session. */
export type TerminalReferenceResolver = (id: string) => boolean;
/** Answers whether that browser page is registered in this session. */
export type BrowserPageReferenceResolver = (id: string) => boolean;

/**
 * The live proofs a Markdown surface can offer. Every one is optional: a surface
 * with no fleet, no filesystem or no task board simply cannot prove those
 * references, and unproved reference-shaped text stays plain prose.
 */
export interface ReferenceResolvers {
  readonly agent?: AgentReferenceResolver;
  readonly file?: FileReferenceResolver;
  readonly task?: TaskReferenceResolver;
  readonly attention?: AttentionReferenceResolver;
  readonly skill?: SkillReferenceResolver;
  readonly terminal?: TerminalReferenceResolver;
  readonly browser?: BrowserPageReferenceResolver;
}

export interface RemarkReferencesOptions {
  readonly resolvers?: ReferenceResolvers;
}

/**
 * Fragment hrefs are inert delivery envelopes, not browser destinations: a
 * fragment cannot navigate away from a static Cloudflare Pages bundle, and the
 * renderer re-proves the payload before it will act on a click.
 */
export const REFERENCE_HREF_PREFIX = '#fy-reference?';

/** The attribute a transformed link carries, proving the remark plugin made it. */
export const REFERENCE_ORIGIN_ATTRIBUTE = 'data-fy-reference';

/** Render a reference back to its canonical authored token. */
export function formatReference(reference: Reference | ResolvedReference): string {
  switch (reference.kind) {
    case 'agent':
      if (!AGENT_NAME.test(reference.name)) throw new TypeError('invalid agent reference');
      return `:${reference.name.toLowerCase()}`;
    case 'file': {
      if (!validCodeReference(reference)) throw new TypeError('invalid file reference');
      const location =
        reference.line === undefined
          ? ''
          : `:${reference.line}${reference.endLine === undefined ? '' : `-${reference.endLine}`}`;
      return `@${reference.path}${location}`;
    }
    case 'task': {
      const id = reference.id.toUpperCase();
      if (!TASK_ID.test(id)) throw new TypeError('invalid task reference');
      return `&${id}`;
    }
    case 'attention':
      if (!ATTENTION_ID.test(reference.id)) throw new TypeError('invalid attention reference');
      return `!${reference.id}`;
    case 'skill': {
      // `/name` over `$name`: it is the form the shipped harness invokes and the
      // one the composer's `/` trigger inserts. `$name` remains a valid
      // AUTHORED alias — this is the canonical rendering, not a rewrite of what
      // a reader typed.
      if (!SKILL_NAME.test(reference.name)) throw new TypeError('invalid skill reference');
      return `/${reference.name.toLowerCase()}`;
    }
    case 'terminal':
      if (!TERMINAL_ID.test(reference.id)) throw new TypeError('invalid terminal reference');
      return `:term/${reference.id}`;
    case 'browser':
      if (!BROWSER_PAGE_ID.test(reference.id)) throw new TypeError('invalid browser page reference');
      return `:page/${reference.id}`;
  }
}

/** Formats a file open target as its canonical `@path[:line[-end]]` token. */
export function formatCodeReference(reference: CodeReference): string {
  return formatReference({ kind: 'file', ...reference });
}

function resolvedAgent(value: ResolvedAgent | null | undefined): ResolvedAgentReference | null {
  if (!value || !safeSessionId(value.sessionId) || !AGENT_NAME.test(value.name)) return null;
  if (typeof value.daemonId !== 'string' || value.daemonId.trim() === '') return null;
  return { kind: 'agent', daemonId: value.daemonId, sessionId: value.sessionId, name: value.name.toLowerCase() };
}

/**
 * The sole proof gate. A resolver that is absent, answers nothing, or throws
 * always resolves to null — an unproved reference is prose, never a link.
 */
export function resolveReference(reference: Reference, resolvers: ReferenceResolvers): ResolvedReference | null {
  try {
    switch (reference.kind) {
      case 'agent':
        return resolvers.agent ? resolvedAgent(resolvers.agent({ name: reference.name })) : null;
      case 'file': {
        const path = resolvers.file?.(reference.path);
        if (!path) return null;
        const resolved: FileReference = { ...reference, path };
        return validCodeReference(resolved) ? resolved : null;
      }
      case 'task':
        return resolvers.task?.(reference.id) ? reference : null;
      case 'attention':
        return resolvers.attention?.(reference.id) ? reference : null;
      case 'skill':
        return resolvers.skill?.(reference.name) ? reference : null;
      case 'terminal':
        return resolvers.terminal?.(reference.id) ? reference : null;
      case 'browser':
        return resolvers.browser?.(reference.id) ? reference : null;
    }
  } catch {
    return null;
  }
}

function one(query: URLSearchParams, name: string): string | undefined {
  const values = query.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

/** Rejects an envelope carrying anything beyond the exact keys its kind needs. */
function exactKeys(query: URLSearchParams, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return [...query.keys()].every(key => allowed.has(key)) && keys.every(key => query.getAll(key).length === 1);
}

/** Encode a proved reference as the reserved fragment envelope. */
export function referenceHref(reference: ResolvedReference): string {
  const query = new URLSearchParams({ kind: reference.kind });
  switch (reference.kind) {
    case 'agent':
      if (resolvedAgent(reference) === null) throw new TypeError('invalid resolved agent reference');
      // The daemon travels with the link: a bare session id would let a
      // reference open a same-named session on whichever daemon happens to be
      // in front of the reader.
      query.set('daemon', reference.daemonId);
      query.set('id', reference.sessionId);
      query.set('name', reference.name.toLowerCase());
      break;
    case 'file':
      if (!validCodeReference(reference)) throw new TypeError('invalid resolved file reference');
      query.set('path', reference.path);
      if (reference.line !== undefined) query.set('line', String(reference.line));
      if (reference.endLine !== undefined) query.set('end', String(reference.endLine));
      break;
    case 'task':
      if (!TASK_ID.test(reference.id)) throw new TypeError('invalid resolved task reference');
      query.set('id', reference.id.toUpperCase());
      break;
    case 'attention':
      if (!ATTENTION_ID.test(reference.id)) throw new TypeError('invalid resolved attention reference');
      query.set('id', reference.id);
      break;
    case 'skill':
      if (!SKILL_NAME.test(reference.name)) throw new TypeError('invalid resolved skill reference');
      query.set('name', reference.name.toLowerCase());
      break;
    case 'terminal':
      if (!TERMINAL_ID.test(reference.id)) throw new TypeError('invalid resolved terminal reference');
      query.set('id', reference.id);
      break;
    case 'browser':
      if (!BROWSER_PAGE_ID.test(reference.id)) throw new TypeError('invalid resolved browser page reference');
      query.set('id', reference.id);
      break;
  }
  return `${REFERENCE_HREF_PREFIX}${query}`;
}

/** Decode a reserved envelope. Anything malformed or embellished answers null. */
export function parseReferenceHref(href: string | undefined): ResolvedReference | null {
  if (!href?.startsWith(REFERENCE_HREF_PREFIX)) return null;
  const query = new URLSearchParams(href.slice(REFERENCE_HREF_PREFIX.length));
  const kind = one(query, 'kind');
  if (kind === 'agent') {
    if (!exactKeys(query, ['kind', 'daemon', 'id', 'name'])) return null;
    const daemon = one(query, 'daemon');
    const sessionId = one(query, 'id');
    const name = one(query, 'name');
    return daemon && sessionId && name ? resolvedAgent({ daemonId: daemon as DaemonId, sessionId, name }) : null;
  }
  if (kind === 'file') {
    const allowed = ['kind', 'path', ...(query.has('line') ? ['line'] : []), ...(query.has('end') ? ['end'] : [])];
    if (!exactKeys(query, allowed) || (query.has('end') && !query.has('line'))) return null;
    const path = one(query, 'path');
    const rawLine = one(query, 'line');
    const rawEnd = one(query, 'end');
    const line = rawLine === undefined ? undefined : positiveInteger(rawLine);
    const endLine = rawEnd === undefined ? undefined : positiveInteger(rawEnd);
    if (!path || (rawLine !== undefined && line === undefined) || (rawEnd !== undefined && endLine === undefined))
      return null;
    const reference: FileReference = {
      kind: 'file',
      path,
      ...(line === undefined ? {} : { line }),
      ...(endLine === undefined ? {} : { endLine }),
    };
    return validCodeReference(reference) ? reference : null;
  }
  if (kind === 'task') {
    if (!exactKeys(query, ['kind', 'id'])) return null;
    const id = one(query, 'id')?.toUpperCase();
    return id && TASK_ID.test(id) ? { kind: 'task', id } : null;
  }
  if (kind === 'attention') {
    if (!exactKeys(query, ['kind', 'id'])) return null;
    const id = one(query, 'id');
    return id && ATTENTION_ID.test(id) ? { kind: 'attention', id: id as AttentionId } : null;
  }
  if (kind === 'skill') {
    if (!exactKeys(query, ['kind', 'name'])) return null;
    const name = one(query, 'name');
    return name && SKILL_NAME.test(name) ? { kind: 'skill', name: name.toLowerCase() } : null;
  }
  if (kind === 'terminal') {
    if (!exactKeys(query, ['kind', 'id'])) return null;
    const id = one(query, 'id');
    return id && TERMINAL_ID.test(id) ? { kind: 'terminal', id } : null;
  }
  if (kind === 'browser') {
    if (!exactKeys(query, ['kind', 'id'])) return null;
    const id = one(query, 'id');
    return id && BROWSER_PAGE_ID.test(id) ? { kind: 'browser', id } : null;
  }
  return null;
}

/** A stable identity for a proved reference, used as the transform-origin mark. */
export function referenceIdentity(reference: ResolvedReference): string {
  switch (reference.kind) {
    case 'agent':
      return `agent:${reference.daemonId}:${reference.sessionId}`;
    case 'file':
      return `file:${reference.path}:${reference.line ?? ''}:${reference.endLine ?? ''}`;
    case 'task':
      return `task:${reference.id}`;
    case 'attention':
      return `attention:${reference.id}`;
    case 'skill':
      return `skill:${reference.name}`;
    case 'terminal':
      return `terminal:${reference.id}`;
    case 'browser':
      return `browser:${reference.id}`;
  }
}

/**
 * Re-prove an already-encoded reference at click time. The fleet, the filesystem
 * and the task board all move while a transcript sits on screen, so a link that
 * was true when it was painted is asked again before it is allowed to act.
 */
export function revalidateReference(
  reference: ResolvedReference,
  resolvers: ReferenceResolvers,
): ResolvedReference | null {
  try {
    switch (reference.kind) {
      case 'agent': {
        const current = resolvers.agent ? resolvedAgent(resolvers.agent({ sessionId: reference.sessionId })) : null;
        // Identity is (daemon, session): the same session id on a different
        // daemon is a different session, not a match.
        return current?.sessionId === reference.sessionId && current.daemonId === reference.daemonId ? current : null;
      }
      case 'file': {
        const path = resolvers.file?.(reference.path);
        return path === reference.path && validCodeReference(reference) ? reference : null;
      }
      case 'task':
        return resolvers.task?.(reference.id) ? reference : null;
      case 'attention':
        return resolvers.attention?.(reference.id) ? reference : null;
      case 'skill':
        return resolvers.skill?.(reference.name) ? reference : null;
      case 'terminal':
        return resolvers.terminal?.(reference.id) ? reference : null;
      case 'browser':
        return resolvers.browser?.(reference.id) ? reference : null;
    }
  } catch {
    return null;
  }
}

/** The hover sentence a proved reference carries, in its own kind's voice. */
export function referenceTitle(reference: ResolvedReference): string {
  switch (reference.kind) {
    case 'agent':
      return `Open :${reference.name}'s session`;
    case 'file':
      if (reference.line === undefined) return `Open ${formatReference(reference)}`;
      if (reference.endLine !== undefined)
        return `Open @${reference.path} at lines ${reference.line}–${reference.endLine}`;
      return `Open @${reference.path} at line ${reference.line}`;
    case 'task':
      return `Open task &${reference.id}`;
    case 'attention':
      return `Open attention !${reference.id}`;
    case 'skill':
      return `Open the /${reference.name} skill`;
    case 'terminal':
      return `Open terminal ${formatReference(reference)}`;
    case 'browser':
      return `Open browser page ${formatReference(reference)}`;
  }
}

/** The mdast subset this transform reads. The full typings are transitive. */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  title?: string;
  data?: { hProperties?: Record<string, string> };
  children?: MdNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

/** The vfile subset this transform reads: the document it was parsed from. */
interface MdFile {
  value?: unknown;
}

// Already-linked text and raw HTML are left exactly as authored: a reference
// inside them is content, not a destination. CODE IS NOT IN THIS SET by
// accident — a fence's content is not mdast children at all, so it is decorated
// by the renderer through `code-span-references.ts` instead, which can slice
// code text without an mdast round trip that would re-escape it.
const SKIP_CHILDREN = new Set(['link', 'linkReference', 'code', 'inlineCode', 'html']);

/** One proved reference and the exact bytes of the token that proved it. */
export interface ProvenReference {
  readonly reference: ResolvedReference;
  readonly raw: string;
  readonly start: number;
  readonly end: number;
}

/**
 * The one scan-then-prove pass every surface shares: prose linkification and
 * code-span decoration must agree about which tokens are live, so neither owns
 * its own loop over `findReferences`.
 */
export function provenReferences(value: string, resolvers: ReferenceResolvers): ProvenReference[] {
  return findReferences(value).flatMap(match => {
    const reference = resolveReference(match.reference, resolvers);
    return reference ? [{ reference, raw: match.raw, start: match.start, end: match.end }] : [];
  });
}

/**
 * Which sigils in a parsed text node the author had escaped, and how far the
 * source could be trusted at all.
 *
 * WHY THIS EXISTS. Markdown eats a backslash escape before the transform ever
 * runs: `\:zelda` reaches this module as the text `:zelda`, indistinguishable
 * from an authored reference. The node's position still points at the original
 * bytes, so the escape is recoverable — but only by walking the source and the
 * parsed value together.
 *
 * `limit` is the fail-closed half. The walk understands exactly two things: a
 * character escape, and the block prefixes (`>` and indentation) a continuation
 * line carries in the source but not in the value. Anything else it meets — a
 * character reference like `&amp;`, most likely — makes every later offset
 * ambiguous, so it stops and REFUSES to link from there on. Ambiguous evidence
 * about whether an author suppressed a reference is not evidence that they
 * didn't.
 */
interface SourceAlignment {
  /** Value offsets whose sigil was backslash-escaped in the source. */
  readonly escaped: ReadonlySet<number>;
  /** The value offset from which the source could no longer be aligned. */
  readonly limit: number;
}

const WHOLE: SourceAlignment = { escaped: new Set(), limit: Number.POSITIVE_INFINITY };
const BLOCK_PREFIX = /[ \t>]/u;

function alignSource(source: string, value: string): SourceAlignment {
  if (source === value) return WHOLE;
  const escaped = new Set<number>();
  let at = 0;
  let cursor = 0;
  while (cursor < value.length) {
    if (source[at] === value[cursor]) {
      at += 1;
      cursor += 1;
      continue;
    }
    if (source[at] === '\\' && source[at + 1] === value[cursor]) {
      escaped.add(cursor);
      at += 2;
      cursor += 1;
      continue;
    }
    // A continuation line's own prefix belongs to the block, not to the prose.
    if (cursor > 0 && value[cursor - 1] === '\n' && at < source.length && BLOCK_PREFIX.test(source[at] ?? '')) {
      at += 1;
      continue;
    }
    return { escaped, limit: cursor };
  }
  return { escaped, limit: Number.POSITIVE_INFINITY };
}

function linkifyText(value: string, resolvers: ReferenceResolvers, alignment: SourceAlignment): MdNode[] | null {
  const output: MdNode[] = [];
  let cursor = 0;
  let changed = false;
  for (const match of provenReferences(value, resolvers)) {
    if (match.start >= alignment.limit || alignment.escaped.has(match.start)) continue;
    const resolved = match.reference;
    if (match.start > cursor) output.push({ type: 'text', value: value.slice(cursor, match.start) });
    output.push({
      type: 'link',
      url: referenceHref(resolved),
      title: referenceTitle(resolved),
      data: { hProperties: { [REFERENCE_ORIGIN_ATTRIBUTE]: referenceIdentity(resolved) } },
      children: [{ type: 'text', value: match.raw }],
    });
    cursor = match.end;
    changed = true;
  }
  if (!changed) return null;
  if (cursor < value.length) output.push({ type: 'text', value: value.slice(cursor) });
  return output;
}

/** The source bytes a text node was parsed from, when it can be recovered. */
function nodeSource(node: MdNode, source: string | null): string | null {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (source === null || typeof start !== 'number' || typeof end !== 'number' || end < start) return null;
  return source.slice(start, end);
}

function transformNode(node: MdNode, resolvers: ReferenceResolvers, source: string | null): void {
  if (SKIP_CHILDREN.has(node.type) || !node.children) return;
  const children: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      const raw = nodeSource(child, source);
      // No recoverable source is not evidence of an escape: a synthesised node
      // carries no author's backslash to honour.
      const alignment = raw === null ? WHOLE : alignSource(raw, child.value);
      children.push(...(linkifyText(child.value, resolvers, alignment) ?? [child]));
      continue;
    }
    transformNode(child, resolvers, source);
    children.push(child);
  }
  node.children = children;
}

/**
 * remark plugin: turn PROVED reference tokens in prose into links carrying the
 * reserved envelope and the transform-origin mark. With no resolvers it is a
 * no-op, which is the correct behaviour for a surface that cannot prove anything.
 *
 * The document is read as well as the tree, because an escaped sigil only exists
 * in the source: see `alignSource`.
 */
export function remarkReferences(options: RemarkReferencesOptions = {}) {
  const { resolvers } = options;
  return (tree: MdNode, file?: MdFile): void => {
    if (!resolvers) return;
    transformNode(tree, resolvers, typeof file?.value === 'string' ? file.value : null);
  };
}
