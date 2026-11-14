/**
 * THE PHONE FERRET PAGE'S VOCABULARY (pure): which tabs it offers, in what order, under what names, and what "+" opens.
 *
 * On a desktop the ferret page draws the chat beside the `ferret.side` column, every panel at once. A phone has no room
 * beside a chat, so v4's PhoneWorkspace showed ONE thing at a time behind a row of chips: Chat, Console, Processes, then
 * the workspace tabs (terminals, browser pages, files), and a "+" that opened New terminal / New browser / Open file.
 * 5.0 keeps that reach with the SAME providers: every panel the layout places in `ferret.side` is one chip (a panel is a
 * plugin's, so its name and its place in the row are said here, once), and "+" is a request to the panel that owns
 * the act (`PanelIntent`), never a second terminal list or a second browser.
 */

import type { PanelRef } from '../layout/engine.ts';

/** The chat's own chip: always first, always there. */
export const CHAT_TAB = 'chat';

export interface PhoneTab {
  /** `chat`, or a panel's `<plugin>.<id>`. */
  readonly key: string;
  readonly label: string;
}

/** A panel's key: the plugin that provides it and its id, as `PanelSlot` marks it (`data-panel`). */
export const panelKey = (panel: Pick<PanelRef, 'plugin' | 'id'>): string => `${panel.plugin}.${panel.id}`;

/** What v4's chips were called, in v4's order: Chat, Console, Processes, then terminals, browser pages, files. */
const KNOWN: Readonly<Record<string, { readonly label: string; readonly rank: number }>> = {
  console: { label: 'Console', rank: 1 },
  processes: { label: 'Processes', rank: 2 },
  terminals: { label: 'Terminals', rank: 3 },
  browser: { label: 'Browser', rank: 4 },
  files: { label: 'Files', rank: 5 },
  'ferret-agenda': { label: 'Agenda', rank: 6 },
  queue: { label: 'Queue', rank: 6 },
  'cards-of-ferret': { label: 'Cards', rank: 6 },
  'ferret-warden': { label: 'Warden', rank: 6 },
  'mcp-servers': { label: 'MCP', rank: 6 },
  helpers: { label: 'Helpers', rank: 6 },
  skills: { label: 'Skills', rank: 6 },
  usage: { label: 'Usage', rank: 6 },
  insights: { label: 'Insights', rank: 6 },
};

/** A panel nobody named here: its id, in words ("my-panel" → "My panel"). */
const titleOf = (id: string): string => {
  const words = id.replaceAll('-', ' ').trim();
  return words === '' ? id : words.charAt(0).toUpperCase() + words.slice(1);
};

/** The chip row: Chat first, then the panels the layout placed, v4's own first and the rest in the layout's order. */
export function phoneTabs(panels: readonly PanelRef[]): readonly PhoneTab[] {
  const ranked = panels.map((panel, index) => ({
    index,
    rank: KNOWN[panel.id]?.rank ?? 6,
    tab: { key: panelKey(panel), label: KNOWN[panel.id]?.label ?? titleOf(panel.id) },
  }));
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return [{ key: CHAT_TAB, label: 'Chat' }, ...ranked.map(entry => entry.tab)];
}

/** What "+" can open: a panel's own act. `action` is what the panel is asked (absent: showing the panel is the act). */
export interface NewTabChoice {
  readonly id: 'new-terminal' | 'new-browser' | 'open-file';
  readonly label: string;
  /** The panel that owns the act. */
  readonly panel: string;
  readonly action?: PanelAction;
}

/** The acts a host may ask a panel for. A panel answers the ones it owns and ignores the rest. */
type PanelAction = 'new-terminal' | 'new-page';

const CHOICES: readonly {
  readonly id: NewTabChoice['id'];
  readonly label: string;
  readonly panelId: string;
  readonly action?: PanelAction;
}[] = [
  { id: 'new-terminal', label: 'New terminal', panelId: 'terminals', action: 'new-terminal' },
  { id: 'new-browser', label: 'New browser', panelId: 'browser', action: 'new-page' },
  { id: 'open-file', label: 'Open file', panelId: 'files' },
];

/** v4's "+" menu, minus whatever the layout did not place: New terminal, New browser, Open file. */
export function newTabChoices(panels: readonly PanelRef[]): readonly NewTabChoice[] {
  const choices: NewTabChoice[] = [];
  for (const choice of CHOICES) {
    const panel = panels.find(candidate => candidate.id === choice.panelId);
    if (panel === undefined) continue;
    choices.push({
      id: choice.id,
      label: choice.label,
      panel: panelKey(panel),
      ...(choice.action === undefined ? {} : { action: choice.action }),
    });
  }
  return choices;
}

/** The tab a chip key names, or Chat when it names nothing now (a panel the layout no longer places). */
export const tabOrChat = (tabs: readonly PhoneTab[], key: string): string =>
  tabs.some(tab => tab.key === key) ? key : CHAT_TAB;

/** WAI-ARIA tab keys over the chips. No wrap: the row has two real ends. */
export function nextTab(tabs: readonly PhoneTab[], current: string, key: string): string | null {
  const index = tabs.findIndex(tab => tab.key === current);
  if (index === -1) return null;
  const at = (target: number): string | null => tabs[target]?.key ?? null;
  switch (key) {
    case 'ArrowRight':
      return at(index + 1);
    case 'ArrowLeft':
      return at(index - 1);
    case 'Home':
      return at(0);
    case 'End':
      return at(tabs.length - 1);
    default:
      return null;
  }
}
