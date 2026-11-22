/**
 * `fy agenda patch` and `fy agenda show --yaml` (&F957; docs/agenda.md § Patch: the item as one document).
 *
 * The item is ONE editable document. `agendaPatchDocument` prints it with its revision; `composeAgendaPatch` reads a
 * patch against the item as it stands — refusing one written against an older revision (read before write) — and
 * composes the ONE `edit` request that carries what differs. So a patch is the edit action, with its route, validation,
 * read-cold lint, governance and hand-back rules, never a second write path. Pure.
 */
import {
  AGENDA_PATCH_KEYS,
  type AgendaClearableField,
  type AgendaEditRequestSchema,
  type AgendaItem,
  type AgendaPatch,
  AgendaPatchSchema,
  type AgendaTabEdit,
  agendaItemRevision,
  findAgendaTab,
} from '@ferretry/core-asks/contract';
import type { z } from 'zod';
import { patchProblems, readPatchText, samePatchValue } from './patch-document.ts';

type AgendaEditRequest = z.input<typeof AgendaEditRequestSchema>;

/** The patch keys whose wire name differs. */
const WIRE_NAME: Readonly<Partial<Record<keyof AgendaPatch, string>>> = { summary: 'subject' };

type CopiedKey = Exclude<keyof AgendaPatch, 'revision' | 'tabs' | 'blockingNow' | 'neededBy'>;

/** The keys whose value is copied to the request as it is when it differs from the item's. */
const COPIED = AGENDA_PATCH_KEYS.filter(
  (key): key is CopiedKey => key !== 'revision' && key !== 'tabs' && key !== 'blockingNow' && key !== 'neededBy',
);

/**
 * The shape fields an edit that REPLACES the ask would otherwise drop (the daemon's `REPLACED_SHAPE`): when the edit
 * carries a kind, ask or answers, every one the patch gives is sent again, equal to the item's or not.
 */
const REPLACED_SHAPE = ['ask', 'answers', 'questions', 'optionDetails', 'fields', 'steps'] as const;

/** The item's value for a patch key, as it is stored. */
const stored = (item: AgendaItem, key: keyof AgendaPatch): unknown =>
  (item as unknown as Record<string, unknown>)[WIRE_NAME[key] ?? key];

/**
 * The item as the document `patch` takes back: its revision first, then every field a ferret may change that the item
 * has, in the order a reader meets them, tabs as name → Markdown. Read-only fields (state, history, versions, who
 * raised it) are not in it.
 */
export function agendaPatchDocument(item: AgendaItem): Record<string, unknown> {
  const document: Record<string, unknown> = {};
  for (const key of AGENDA_PATCH_KEYS) {
    if (key === 'revision') {
      document.revision = agendaItemRevision(item);
      continue;
    }
    if (key === 'tabs') {
      const tabs = item.tabs ?? [];
      if (tabs.length > 0) document.tabs = Object.fromEntries(tabs.map(tab => [tab.name, tab.body]));
      continue;
    }
    const value = stored(item, key);
    if (value === undefined || value === null) continue;
    document[key] = value;
  }
  return document;
}

/** What a patch asks of the daemon: the edit to send, nothing (nothing differs), or a refusal (read it again). */
export type AgendaPatchPlan =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'edit'; readonly request: AgendaEditRequest };

/** A patch's text, parsed: the document, or every problem in it, one line each. */
export function parseAgendaPatch(
  text: string,
  source: string,
): { readonly ok: true; readonly patch: AgendaPatch } | { readonly ok: false; readonly problems: readonly string[] } {
  const read = readPatchText(text, source);
  if (!read.ok) return { ok: false, problems: [read.problem] };
  if (!('revision' in read.value)) {
    return {
      ok: false,
      problems: [
        'revision: required — read the whole item first (agenda show <id> --yaml prints it), so no part is left out of date',
      ],
    };
  }
  const parsed = AgendaPatchSchema.safeParse(read.value);
  if (!parsed.success) return { ok: false, problems: patchProblems(parsed.error, AGENDA_PATCH_KEYS) };
  const { revision: _revision, ...fields } = parsed.data;
  if (Object.values(fields).every(value => value === undefined)) {
    return { ok: false, problems: [`${source} names no field to change: a patch changes at least one`] };
  }
  return { ok: true, patch: parsed.data };
}

/**
 * The ONE edit a patch is, against `item` as it stands. A patch written against another revision is `stale` (the item
 * changed since it was read). A value equal to the item's is left out (so a document written back as it was read sends
 * nothing, and an unchanged `kind` never re-asks the owner), except that when the ask is replaced the shape the patch
 * keeps (`questions`, `optionDetails`, `fields`, `steps`) is sent again, since the daemon drops what an edit does not
 * re-give. `null` clears, tabs become tab operations by name.
 * `neededBy` resolves a typed time ("in 3h") to an instant.
 */
export function composeAgendaPatch(
  item: AgendaItem,
  patch: AgendaPatch,
  neededBy: (typed: string) => string,
): AgendaPatchPlan {
  if (patch.revision !== agendaItemRevision(item)) return { kind: 'stale' };
  const fields: Record<string, unknown> = {};
  const clear: AgendaClearableField[] = [];
  const clearing = (field: AgendaClearableField): void => {
    if ((item as unknown as Record<string, unknown>)[field] !== undefined) clear.push(field);
  };
  for (const key of COPIED) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) {
      clearing(key as AgendaClearableField);
      continue;
    }
    if (!samePatchValue(value, stored(item, key))) fields[WIRE_NAME[key] ?? key] = value;
  }
  if (fields.kind !== undefined || fields.ask !== undefined || fields.answers !== undefined) {
    for (const key of REPLACED_SHAPE) {
      const given = patch[key];
      if (given !== undefined && given !== null) fields[key] = given;
    }
  }
  if (patch.blockingNow === true && item.blockingNow !== true) fields.blockingNow = true;
  if (patch.blockingNow === false || patch.blockingNow === null) clearing('blockingNow');
  if (patch.neededBy === null) clearing('neededBy');
  if (typeof patch.neededBy === 'string') {
    const when = neededBy(patch.neededBy);
    if (when !== item.neededBy) fields.neededBy = when;
  }
  const tabEdits = tabOperations(item, patch.tabs);
  if (Object.keys(fields).length === 0 && clear.length === 0 && tabEdits.length === 0) return { kind: 'unchanged' };
  return {
    kind: 'edit',
    request: {
      action: 'edit',
      id: item.id,
      revision: patch.revision,
      ...fields,
      ...(clear.length === 0 ? {} : { clear }),
      ...(tabEdits.length === 0 ? {} : { tabEdits }),
    } as AgendaEditRequest,
  };
}

/** The patch's tabs as operations: a new or changed body makes or rewrites, `null` removes; an unchanged one is left. */
function tabOperations(item: AgendaItem, tabs: AgendaPatch['tabs']): readonly AgendaTabEdit[] {
  if (tabs === undefined) return [];
  const own = item.tabs ?? [];
  return Object.entries(tabs).flatMap(([name, body]): AgendaTabEdit[] => {
    const at = findAgendaTab(own, name);
    const existing = at < 0 ? undefined : own[at];
    if (body === null) return existing === undefined ? [] : [{ tab: name, remove: true }];
    return existing?.body === body ? [] : [{ tab: name, body }];
  });
}
