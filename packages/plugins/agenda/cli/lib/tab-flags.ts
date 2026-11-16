/**
 * THE TAB FLAGS of `fy agenda add` and `edit` (&F923; docs/agenda.md § The tabs): the main tab from a file
 * (`--where-file`), and the ferret's own tabs (`--tab-file "Name=file"`, `--rename-tab "Old=New"`, `--move-tab
 * "Name=1"`, `--remove-tab Name`) as the request fields the daemon takes. Pure but for `read`, which reads a file (or
 * standard input for `-`).
 */

import {
  type AgendaItem,
  type AgendaTab,
  type AgendaTabEdit,
  agendaTabs,
  applyAgendaTabEdits,
  findAgendaTab,
} from '@ferretry/core-asks/contract';
import { agendaReference } from './reference.ts';

export interface TabFlags {
  /** `--where-file`: the main tab, "Where we are now", as a Markdown file; `-` reads standard input. */
  readonly whereFile?: string;
  /** `--tab-file "Name=file"`, repeated: makes or rewrites each tab. */
  readonly tabFile?: readonly string[];
  /** `--rename-tab "Old=New"`, repeated. */
  readonly renameTab?: readonly string[];
  /** `--move-tab "Name=position"`, repeated: 1 is the first of the ferret's own tabs. */
  readonly moveTab?: readonly string[];
  /** `--remove-tab Name`, repeated. */
  readonly removeTab?: readonly string[];
}

/** The request fields the tab flags give. */
export interface TabFields {
  readonly whereWeAre?: string;
  readonly tabEdits?: readonly AgendaTabEdit[];
}

/** `Name=value`, split at the first `=` (a tab name never holds one). */
const pair = (flag: string, given: string): readonly [string, string] => {
  const at = given.indexOf('=');
  const name = at < 0 ? '' : given.slice(0, at).trim();
  const value = at < 0 ? '' : given.slice(at + 1).trim();
  if (name === '' || value === '') throw new Error(`${flag} takes "Name=value", not "${given}"`);
  return [name, value];
};

const list = (values: readonly string[] | undefined): readonly string[] =>
  (values ?? []).filter(value => value.trim() !== '');

/**
 * The tab flags as request fields. `where` is the `--where` points: the main tab comes from one or the other, never
 * both. At most one file is read from standard input, `stdinTaken` counting the ones the command already reads.
 */
export const tabFieldsOf = async (
  flags: TabFlags,
  where: string | readonly string[] | undefined,
  read: (path: string) => Promise<string>,
  stdinTaken = 0,
): Promise<TabFields> => {
  const whereFile = flags.whereFile?.trim();
  const points = typeof where === 'string' ? where : (where ?? []).join('');
  if (whereFile !== undefined && whereFile !== '' && points.trim() !== '')
    throw new Error('the main tab comes from --where-file or --where points, not both');
  const files = list(flags.tabFile).map(given => pair('--tab-file', given));
  const stdin = [whereFile, ...files.map(([, path]) => path)].filter(path => path === '-').length + stdinTaken;
  if (stdin > 1) throw new Error('only one file can be read from standard input (-); give the others a file');
  const whereWeAre = whereFile === undefined || whereFile === '' ? undefined : (await read(whereFile)).trim();
  if (whereWeAre === '') throw new Error(`--where-file ${whereFile ?? ''} is empty`);
  const edits: AgendaTabEdit[] = [];
  for (const [tab, path] of files) {
    const body = (await read(path)).trim();
    if (body === '') throw new Error(`--tab-file ${tab}=${path} is empty`);
    edits.push({ tab, body });
  }
  for (const given of list(flags.renameTab)) {
    const [tab, rename] = pair('--rename-tab', given);
    edits.push({ tab, rename });
  }
  for (const given of list(flags.moveTab)) {
    const [tab, at] = pair('--move-tab', given);
    const position = Number(at);
    if (!Number.isInteger(position) || position < 1)
      throw new Error(`--move-tab ${tab}=${at}: the position counts from 1`);
    edits.push({ tab, position });
  }
  for (const tab of list(flags.removeTab)) edits.push({ tab: tab.trim(), remove: true });
  return {
    ...(whereWeAre === undefined ? {} : { whereWeAre }),
    ...(edits.length === 0 ? {} : { tabEdits: edits }),
  };
};

/** A new item's tabs, from its `--tab-file` flags: an add takes the list, in the order given. */
export const newItemTabs = (edits: readonly AgendaTabEdit[] | undefined): readonly AgendaTab[] | undefined => {
  if (edits === undefined) return undefined;
  if (edits.some(edit => edit.body === undefined))
    throw new Error('a new item takes --tab-file only: rename, move or remove a tab with `agenda edit`');
  const applied = applyAgendaTabEdits(undefined, edits);
  if (!applied.ok) throw new Error(applied.problem);
  return applied.tabs;
};

/**
 * `fy agenda show <id> --tab <name>`: one tab's words exactly as written, so a ferret can change them and write the tab
 * back whole. `main` (or its name) is what `--where-file` wrote; `body` (or its name) is the `--body-file`; any other
 * name or id is a tab of the ferret's own.
 */
export const tabText = (item: AgendaItem, ref: string): string => {
  const tabs = agendaTabs(item);
  // By name first, then by id: the same rule an edit names a tab by (`findAgendaTab`).
  const tab = tabs[findAgendaTab(tabs, ref)];
  if (tab === undefined) {
    const names = agendaTabs(item).map(each => `"${each.name}" (${each.id})`);
    throw new Error(
      names.length === 0
        ? `${agendaReference(item.id)} has no tabs yet`
        : `${agendaReference(item.id)} has no tab "${ref}": its tabs are ${names.join(', ')}`,
    );
  }
  if (tab.kind === 'main') return tab.whereWeAre ?? '';
  return tab.body;
};
