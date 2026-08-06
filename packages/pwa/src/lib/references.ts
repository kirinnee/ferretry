/**
 * One canonical reference grammar and proof gate for every Markdown surface.
 *
 * References are authored as plain sigil tokens:
 *   `:agent`  `@file[:line[-end]]`  `&task`  `!attention`  `%surface:key`
 *   `/skill` or `$skill`
 *
 * A reference is a TOKEN, never a Markdown link. `[label](#fy-reference?…)`
 * written by hand is not a reference and never becomes one: the renderer only
 * trusts links this module's own transform produced. The whole grammar, with
 * authoring examples and the click contract, is `docs/reference-standard.md`.
 *
 * SKILLS ACCEPT TWO SIGILS AND MEAN ONE THING. Claude invokes a skill as
 * `/name` and Codex as `$name` (`features/skills/skills-catalog.ts` owns that
 * insertion contract), so both parse to the same `skill` reference and the
 * authored bytes are what the reader keeps seeing. `formatReference` answers
 * with the `/name` form because it is the one a reader can type on either
 * harness.
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
 * SURFACES ARE SESSION-SCOPED, WHICH IS A CORRECTNESS PROPERTY, NOT A STYLE ONE.
 * A `%terminal:…` token names one live surface inside ONE session, and a proved
 * surface therefore carries the daemon AND the session it was proved against.
 * Agent, task and attention identities are fleet-wide; a terminal id is not — the
 * same twelve hex characters mean nothing outside the session that owns them, and
 * an agent told to type into "that terminal" must never reach a different one.
 *
 * A SURFACE THAT IS GONE SAYS SO. Every other family resolves to a link or to
 * plain prose, because "we cannot prove it" and "it is not there" are the same
 * answer for a file path. For a surface they are not: a terminal that CLOSED is
 * positive evidence, and silently reprinting the token would leave the reader and
 * the agent believing they still share a target. A proved-closed surface renders
 * as an inert tombstone (`delete`, i.e. `<del>`), never as a link and never as
 * indistinguishable prose.
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

/**
 * The addressable live surfaces of a session.
 *
 * `terminal` is real today. `browser` is declared here on purpose: the browser
 * worker is unbuilt and `/v1/sessions/:id/browser` answers 501, so nothing can
 * prove a page yet — but the grammar, the envelope, the identity and the
 * tombstone are all key-agnostic, so a page slots in by teaching one resolver
 * about it. Declaring the kind now is what stops a second surface grammar being
 * invented next to this one.
 */
export const SURFACE_KINDS = ['terminal', 'browser'] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

/**
 * One surface inside the session being read.
 *
 * `key` is the OWNER's identity for the surface — the daemon's terminal id, the
 * page id — and is opaque here. A reference is never an index into a list: a
 * strip position shifts when a neighbour closes, and a shifted reference is how
 * an agent ends up typing into the wrong shell.
 */
export interface SurfaceReference {
  readonly kind: 'surface';
  readonly surface: SurfaceKind;
  readonly key: string;
}

export interface SkillReference {
  readonly kind: 'skill';
  /** Canonical lowercase skill name, without either sigil. */
  readonly name: string;
}

export type Reference =
  | AgentReference
  | FileReference
  | TaskReference
  | AttentionReference
  | SurfaceReference
  | SkillReference;

/** An agent reference that a live fleet has proved, daemon and session both. */
export interface ResolvedAgentReference extends AgentReference {
  readonly daemonId: DaemonId;
  readonly sessionId: string;
}

/**
 * A surface a live owner has proved, daemon and session both.
 *
 * The TITLE is deliberately absent. A terminal can be retitled at any moment, and
 * a mutable field inside the envelope would change `referenceIdentity`, so every
 * already-painted link to that terminal would fail its origin check and go inert
 * the moment someone renamed it. Titles belong to the picker and the pane, which
 * read them live; identity belongs here.
 */
export interface ResolvedSurfaceReference extends SurfaceReference {
  readonly daemonId: DaemonId;
  readonly sessionId: string;
}

export type ResolvedReference =
  | ResolvedAgentReference
  | FileReference
  | TaskReference
  | AttentionReference
  | ResolvedSurfaceReference
  | SkillReference;

export interface ReferenceMatch {
  readonly reference: Reference;
  readonly raw: string;
  /** Offset of the sigil in the scanned string; the prefix character is not part of the match. */
  readonly start: number;
  readonly end: number;
}

const INTEGER = /^[1-9][0-9]*$/u;
const FILE_TOKEN = /^@(?!@)([/.\p{L}\p{N}_+@#-]*[\p{L}\p{N}_+@#-])(?::([1-9][0-9]*)(?:-([1-9][0-9]*))?)?$/u;
/**
 * The BODY of each sigil token, written once.
 *
 * Each of these shapes used to be spelled three times — in the `…_ID`/`…_NAME`
 * validator, in the `…_TOKEN` parser, and again inside `CANDIDATE_ALTERNATIVES`
 * below — and a composer that offers a picker for the same tokens would have
 * been a fourth. Three copies of `[a-z][a-z0-9-]{0,31}` agree only for as long
 * as nobody edits one of them.
 */
const AGENT_NAME_BODY = '[a-z][a-z0-9-]{0,31}';
const TASK_ID_BODY = '[BFIC][0-9]{1,9}';
const ATTENTION_ID_BODY = 'A[1-9][0-9]*';
const SKILL_NAME_BODY = '[a-z][a-z0-9-]{0,63}';
const AGENT_NAME = new RegExp(`^${AGENT_NAME_BODY}$`, 'iu');
const AGENT_TOKEN = new RegExp(`^:(${AGENT_NAME_BODY})$`, 'iu');
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TASK_ID = new RegExp(`^${TASK_ID_BODY}$`, 'iu');
const TASK_TOKEN = new RegExp(`^&(${TASK_ID_BODY})$`, 'iu');
const ATTENTION_ID = new RegExp(`^${ATTENTION_ID_BODY}$`, 'u');
const ATTENTION_TOKEN = new RegExp(`^!(${ATTENTION_ID_BODY})$`, 'u');
/**
 * A surface key is deliberately dot-free. Daemon terminal ids are twelve hex
 * characters and page keys are `page-<n>`, so a dot buys nothing — and it would
 * cost the one thing that matters here: `%terminal:abc.` at the end of a sentence
 * would swallow the full stop into the identity and address nothing.
 */
const SURFACE_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SURFACE_TOKEN = /^%(terminal|browser):([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/iu;
// LOWERCASE ONLY, unlike an agent callsign. A skill name is a directory name,
// not a daemon-normalised identity, and `$HOME`/`$PATH` are far more common in
// prose and in code than a capitalised skill invocation is. Reading `$HOME` as
// `$home` would make the reference layer volunteer a candidate for every shell
// variable a message contains. Namespaced invocation forms a harness may accept
// elsewhere (`plugin:skill`, `apps/web:deploy`) are NOT references, because
// their separators are this grammar's own boundaries.
const SKILL_NAME = new RegExp(`^${SKILL_NAME_BODY}$`, 'u');
const SKILL_TOKEN = new RegExp(`^[/$](${SKILL_NAME_BODY})$`, 'u');

// Each alternative owns its right boundary. A colon may naturally follow
// agent/task/attention prose, but it cannot terminate a file candidate because
// it could be the start of a malformed location suffix. A surface token contains
// exactly one interior colon and is bounded like the others — `%` is otherwise a
// percentage, and `50%` never opens a candidate because a digit is not a left
// boundary.
//
// Composed rather than written as one 600-character literal: six alternatives
// sharing two boundary sets is exactly the shape a single literal hides. Ordinary
// quoted strings, not `String.raw`, because a backtick is one of the boundary
// characters and `String.raw` would keep the backslash escaping it needs — which
// a `u`-mode character class rejects as an invalid escape.
const BOUNDARY_BEFORE_CHARS = '\\s([{"\'`<>=—–';
const BOUNDARY_BEFORE = `(^|[${BOUNDARY_BEFORE_CHARS}])`;
const BOUNDARY_AFTER = '(?=$|[\\s)\\]}"\'`,;!?<>:.=—–])';
const BOUNDARY_AFTER_FILE = '(?=$|[\\s)\\]}"\'`,;!?<>.=—–])';
const CANDIDATE_ALTERNATIVES = [
  `:${AGENT_NAME_BODY}${BOUNDARY_AFTER}`,
  `&${TASK_ID_BODY}${BOUNDARY_AFTER}`,
  `!${ATTENTION_ID_BODY}${BOUNDARY_AFTER}`,
  `%(?:terminal|browser):[A-Za-z0-9][A-Za-z0-9_-]{0,63}${BOUNDARY_AFTER}`,
  `[/$]${SKILL_NAME_BODY}${BOUNDARY_AFTER}`,
  `@(?!@)[/.\\p{L}\\p{N}_+@#-]*[\\p{L}\\p{N}_+@#-](?::[1-9][0-9]*(?:-[1-9][0-9]*)?)?${BOUNDARY_AFTER_FILE}`,
];
const REFERENCE_CANDIDATE = new RegExp(`${BOUNDARY_BEFORE}(${CANDIDATE_ALTERNATIVES.join('|')})`, 'giu');
const LEFT_BOUNDARY = new RegExp(`^[${BOUNDARY_BEFORE_CHARS}]$`, 'u');

/**
 * May a reference token BEGIN after this character?
 *
 * Exported as the decision rather than as the character set, because the
 * composer asks exactly this question while a token is still being typed and
 * an independent answer there is the defect this repository names: a picker
 * that opens where the grammar refuses inserts a token the renderer can never
 * prove, and the reader sees a reference that silently stays prose.
 *
 * `undefined` means "nothing precedes it", which is the `^` half of the same
 * rule. Note that the `@` and `%` scans in the composer engine deliberately use
 * a WIDER rule of their own (`see:@src` opens a file picker) — that divergence
 * predates this function and is recorded in `docs/reference-standard.md`.
 */
export function isReferenceLeftBoundary(previous: string | undefined): boolean {
  return previous === undefined || LEFT_BOUNDARY.test(previous);
}

/**
 * The sigils that open a picker for a complete token of their own family.
 *
 * `@` and `%` are absent on purpose: they are the composer's own triggers (a
 * repeated-`@` run selects a family, `%` opens surfaces) rather than a token
 * whose first character is the whole prefix. `/` is absent because it opens the
 * harness command line, which is not a reference family.
 */
export const DIRECT_REFERENCE_SIGILS = [':', '&', '!', '$'] as const;
export type DirectReferenceSigil = (typeof DIRECT_REFERENCE_SIGILS)[number];

/**
 * What a HALF-TYPED token of each family may still look like.
 *
 * A picker has to decide on incomplete bytes: `&F` is not a task reference and
 * never will be on its own, but it can still become `&F12`, while `&x` cannot
 * become anything. Every pattern here is the body above with its final
 * quantifier relaxed to admit the empty tail — and only that, so a query these
 * accept is exactly a query some complete token starts with.
 *
 * The mapped type is the completeness proof: a fifth direct sigil is a compile
 * error here rather than a family that silently offers nothing.
 */
const DIRECT_SIGIL_PREFIX = {
  // Every prefix of an agent name is itself a valid agent name.
  ':': new RegExp(`^${AGENT_NAME_BODY}$`, 'iu'),
  '&': /^[BFIC][0-9]{0,9}$/iu,
  // Case-sensitive, exactly as `ATTENTION_TOKEN` is: `!a3` is not a reference.
  '!': /^A(?:[1-9][0-9]*)?$/u,
  // Lowercase only, which is what keeps `$HOME` and `$PATH` out of the picker.
  $: new RegExp(`^${SKILL_NAME_BODY}$`, 'u'),
} as const satisfies { readonly [Sigil in DirectReferenceSigil]: RegExp };

/**
 * Could this partially typed query still grow into a complete token for `sigil`?
 *
 * An empty query answers `true` — a bare sigil is the prefix of every token in
 * its family. Whether a picker should OPEN there is a different question, and
 * one the composer owns: opening on a bare `:` would put a menu over `note: `.
 */
export function acceptsDirectReferenceQuery(sigil: DirectReferenceSigil, query: string): boolean {
  return query === '' || DIRECT_SIGIL_PREFIX[sigil].test(query);
}

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

const surfaceKind = (value: string): value is SurfaceKind => (SURFACE_KINDS as readonly string[]).includes(value);

function validSurfaceReference(reference: SurfaceReference): boolean {
  return surfaceKind(reference.surface) && SURFACE_KEY.test(reference.key);
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
  const agent = raw.match(AGENT_TOKEN);
  if (agent?.[1]) return { kind: 'agent', name: agent[1].toLowerCase() };

  const task = raw.match(TASK_TOKEN);
  if (task?.[1]) return { kind: 'task', id: task[1].toUpperCase() };

  const attention = raw.match(ATTENTION_TOKEN);
  if (attention?.[1]) return { kind: 'attention', id: attention[1] as AttentionId };

  const surface = raw.match(SURFACE_TOKEN);
  // The KIND is case-folded, exactly as an agent callsign is. The KEY is not: it
  // is an owner-issued identity, and case-folding one would let `%terminal:AB…`
  // and `%terminal:ab…` claim to be the same surface when the owner says they are
  // two.
  if (surface?.[1] && surface[2])
    return { kind: 'surface', surface: surface[1].toLowerCase() as SurfaceKind, key: surface[2] };

  const skill = raw.match(SKILL_TOKEN);
  if (skill?.[1]) return { kind: 'skill', name: skill[1] };

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
    const raw = match[2];
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

/** What a live surface owner answers with: the daemon AND the session it proved. */
export interface ResolvedSurface {
  readonly daemonId: DaemonId;
  readonly sessionId: string;
  readonly surface: SurfaceKind;
  readonly key: string;
}

/**
 * THREE ANSWERS, NOT TWO — this is the whole reason surfaces have their own
 * resolver shape.
 *
 *   `open`    the owner holds this surface right now.
 *   `closed`  the owner holds an AUTHORITATIVE list that does not contain it, so
 *             it demonstrably no longer exists.
 *   nothing   no evidence either way: no list yet, a failed request, a token for
 *             another session. Fail closed — never a link, and never a tombstone
 *             either, because "I could not ask" is not "it is gone".
 */
export type SurfaceProof = ({ readonly state: 'open' } & ResolvedSurface) | { readonly state: 'closed' };

export type SurfaceReferenceResolver = (lookup: SurfaceReference) => SurfaceProof | null | undefined;

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
  readonly surface?: SurfaceReferenceResolver;
  readonly skill?: SkillReferenceResolver;
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
    case 'surface':
      if (!validSurfaceReference(reference)) throw new TypeError('invalid surface reference');
      return `%${reference.surface}:${reference.key}`;
    case 'skill':
      // `/name` over `$name`: it is the form the shipped harness invokes and the
      // one the composer's `/` trigger inserts. `$name` remains a valid AUTHORED
      // alias — this is the canonical rendering, not a rewrite of what a reader
      // typed.
      if (!SKILL_NAME.test(reference.name)) throw new TypeError('invalid skill reference');
      return `/${reference.name}`;
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
 * Re-checks an owner's answer against the grammar before it becomes a link.
 *
 * A resolver is an injected port, and one that answers with a blank session or a
 * key it never minted has told us nothing usable. The answer's own key must also
 * be the key that was asked for: a resolver that quietly substitutes a
 * neighbouring surface is the exact bug this family exists to prevent, and it
 * would otherwise be invisible — the link would open a real terminal.
 */
function resolvedSurface(
  asked: SurfaceReference,
  value: SurfaceProof | null | undefined,
): ResolvedSurfaceReference | null {
  if (value?.state !== 'open') return null;
  if (typeof value.daemonId !== 'string' || value.daemonId.trim() === '') return null;
  if (!safeSessionId(value.sessionId)) return null;
  if (value.surface !== asked.surface || value.key !== asked.key) return null;
  const resolved: ResolvedSurfaceReference = {
    kind: 'surface',
    daemonId: value.daemonId,
    sessionId: value.sessionId,
    surface: value.surface,
    key: value.key,
  };
  return validSurfaceReference(resolved) ? resolved : null;
}

/**
 * Whether a surface token is PROVED GONE, as opposed to merely unproved.
 *
 * The transform paints a tombstone only for this, so an offline daemon or an
 * absent resolver leaves the token as plain prose rather than announcing the
 * death of a terminal that may be perfectly alive.
 */
export function surfaceReferenceClosed(reference: SurfaceReference, resolvers: ReferenceResolvers): boolean {
  if (!validSurfaceReference(reference)) return false;
  try {
    return resolvers.surface?.(reference)?.state === 'closed';
  } catch {
    return false;
  }
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
      case 'surface':
        return validSurfaceReference(reference) && resolvers.surface
          ? resolvedSurface(reference, resolvers.surface(reference))
          : null;
      case 'skill':
        return resolvers.skill?.(reference.name) ? reference : null;
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
    case 'surface':
      if (resolvedSurface(reference, { state: 'open', ...reference }) === null)
        throw new TypeError('invalid resolved surface reference');
      // BOTH the daemon and the session travel with the link. A terminal id is
      // only meaningful inside its own session, and a bare id would let a
      // reference open whichever session happens to be in front of the reader.
      query.set('daemon', reference.daemonId);
      query.set('session', reference.sessionId);
      query.set('surface', reference.surface);
      query.set('key', reference.key);
      break;
    case 'skill':
      if (!SKILL_NAME.test(reference.name)) throw new TypeError('invalid resolved skill reference');
      query.set('name', reference.name);
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
  if (kind === 'surface') {
    if (!exactKeys(query, ['kind', 'daemon', 'session', 'surface', 'key'])) return null;
    const daemon = one(query, 'daemon');
    const sessionId = one(query, 'session');
    const surface = one(query, 'surface');
    const key = one(query, 'key');
    if (!daemon || !sessionId || !surface || !key || !surfaceKind(surface)) return null;
    const asked: SurfaceReference = { kind: 'surface', surface, key };
    return resolvedSurface(asked, { state: 'open', daemonId: daemon as DaemonId, sessionId, surface, key });
  }
  if (kind === 'skill') {
    if (!exactKeys(query, ['kind', 'name'])) return null;
    const name = one(query, 'name');
    return name && SKILL_NAME.test(name) ? { kind: 'skill', name } : null;
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
    case 'surface':
      // Identity is (daemon, session, kind, key) — the same four facts the
      // envelope carries, and nothing that a rename can move.
      return `surface:${reference.daemonId}:${reference.sessionId}:${reference.surface}:${reference.key}`;
    case 'skill':
      return `skill:${reference.name}`;
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
      case 'surface': {
        const current = resolvers.surface ? resolvedSurface(reference, resolvers.surface(reference)) : null;
        // Identity is (daemon, session, kind, key). A reader whose foreground
        // daemon or session moved holds a resolver for the NEW scope, and it must
        // not re-prove a link painted for the old one merely because both have a
        // terminal with that id.
        return current?.daemonId === reference.daemonId && current.sessionId === reference.sessionId ? current : null;
      }
      case 'skill':
        return resolvers.skill?.(reference.name) ? reference : null;
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
    case 'surface':
      return `Open this session's ${reference.surface} ${reference.key}`;
    case 'skill':
      return `Open the /${reference.name} skill`;
  }
}

/** The tombstone's own hover text. It names the SESSION, because that is the
 *  scope in which the surface no longer exists. */
function closedSurfaceTitle(reference: SurfaceReference): string {
  return `This ${reference.surface} (${reference.key}) is no longer open in this session`;
}

/** The attribute a tombstone carries, so a test — and a reader's inspector — can
 *  tell a proved-closed surface from prose that merely looks struck through. */
export const REFERENCE_CLOSED_ATTRIBUTE = 'data-fy-reference-closed';

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
// inside them is content, not a destination. CODE IS IN THIS SET FOR A DIFFERENT
// REASON — a fence's content is not mdast children at all, so it is decorated by
// the renderer through `code-span-references.ts` instead, which can slice code
// text without an mdast round trip that would re-escape it.
const SKIP_CHILDREN = new Set(['link', 'linkReference', 'code', 'inlineCode', 'html']);

/** One proved reference and the exact bytes of the token that proved it. */
export interface ProvenReference {
  readonly reference: ResolvedReference;
  readonly raw: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Scan and prove in one pass, for a surface that can only ever paint a LINK.
 *
 * The code-span renderer uses this rather than the prose walk below, because a
 * code span has no room for the tombstone: striking a token through inside a
 * snippet would misrepresent the code as containing a `<del>`. A closed surface
 * therefore stays literal inside code, exactly like an unproved one.
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
  for (const match of findReferences(value)) {
    // An escaped token is prose the author asked for, so it is not a link and not
    // a tombstone either: the reader wrote the bytes on purpose.
    if (match.start >= alignment.limit || alignment.escaped.has(match.start)) continue;
    const resolved = resolveReference(match.reference, resolvers);
    // A surface the owner proved GONE is the one case where absence is itself
    // evidence worth painting. It is a `delete` node, so it is inert by
    // construction: there is no href to forge and nothing to click.
    if (!resolved && match.reference.kind === 'surface' && surfaceReferenceClosed(match.reference, resolvers)) {
      if (match.start > cursor) output.push({ type: 'text', value: value.slice(cursor, match.start) });
      output.push({
        type: 'delete',
        data: {
          hProperties: {
            [REFERENCE_CLOSED_ATTRIBUTE]: `${match.reference.surface}:${match.reference.key}`,
            title: closedSurfaceTitle(match.reference),
          },
        },
        children: [{ type: 'text', value: match.raw }],
      });
      cursor = match.end;
      changed = true;
      continue;
    }
    if (!resolved) continue;
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
