/**
 * The canonical reference grammar — the lexical half of it.
 *
 * References are authored as plain sigil tokens:
 *   `:agent`  `@file[:line[-end]]`  `&task`  `!attention`
 *
 * Ported from kteam's `src/lib/references.ts`. **Syntax is never existence
 * proof**: `findReferences` reports lexical candidates and nothing more. The
 * resolver half of the original module (live agent/file/task lookups, the
 * remark plugin, and the reserved-href envelope a rendered link is re-proved
 * against) is deliberately not here — it belongs with the markdown *renderer*,
 * which is not ported yet. The composer's highlight overlay only ever needs the
 * lexical reading: it colours what the reader typed, and colour is not a claim
 * that the target exists.
 */

import type { AttentionId } from '@ferretry/protocol';

interface AgentReference {
  readonly kind: 'agent';
  readonly name: string;
}

interface CodeReference {
  /** Session-root-relative path after resolution. */
  readonly path: string;
  /** 1-based source line. Absent means "open this file". */
  readonly line?: number;
  /** Inclusive 1-based range end. */
  readonly endLine?: number;
}

interface FileReference extends CodeReference {
  readonly kind: 'file';
}

interface TaskReference {
  readonly kind: 'task';
  readonly id: string;
}

interface AttentionReference {
  readonly kind: 'attention';
  readonly id: AttentionId;
}

export type Reference = AgentReference | FileReference | TaskReference | AttentionReference;

export interface ReferenceMatch {
  readonly reference: Reference;
  readonly raw: string;
  /** Offset of the sigil in the scanned string; the prefix character is not part of the match. */
  readonly start: number;
  readonly end: number;
}

const INTEGER = /^[1-9][0-9]*$/u;
const FILE_TOKEN = /^@(?!@)([/.\p{L}\p{N}_+@#-]*[\p{L}\p{N}_+@#-])(?::([1-9][0-9]*)(?:-([1-9][0-9]*))?)?$/u;

// Each alternative owns its right boundary. A colon may naturally follow
// agent/task/attention prose, but it cannot terminate a file candidate because
// it could be the start of a malformed location suffix.
const REFERENCE_CANDIDATE =
  /(^|[\s([{"'`<>=—–])(?:(:[a-z][a-z0-9-]{0,31})(?=$|[\s)\]}"'`,;!?<>:.=—–])|(&[BFIC][0-9]{1,9})(?=$|[\s)\]}"'`,;!?<>:.=—–])|(!A[1-9][0-9]*)(?=$|[\s)\]}"'`,;!?<>:.=—–])|(@(?!@)[/.\p{L}\p{N}_+@#-]*[\p{L}\p{N}_+@#-](?::[1-9][0-9]*(?:-[1-9][0-9]*)?)?)(?=$|[\s)\]}"'`,;!?<>.=—–]))/giu;

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

function validCodeReference(reference: CodeReference): boolean {
  if (!validPath(reference.path)) return false;
  if (reference.line === undefined) return reference.endLine === undefined;
  return reference.endLine === undefined || reference.endLine >= reference.line;
}

/** Parse one complete canonical token. No legacy sigils or implicit paths. */
export function parseReferenceToken(raw: string): Reference | null {
  const agent = raw.match(/^:([a-z][a-z0-9-]{0,31})$/iu);
  if (agent?.[1]) return { kind: 'agent', name: agent[1].toLowerCase() };

  const task = raw.match(/^&([BFIC][0-9]{1,9})$/iu);
  if (task?.[1]) return { kind: 'task', id: task[1].toUpperCase() };

  const attention = raw.match(/^!(A[1-9][0-9]*)$/u);
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
