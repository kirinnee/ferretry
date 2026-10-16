/**
 * The content of "This folder" without any chrome: the four sub-tabs, each with its search and chips,
 * and the list under them.
 *
 * The desktop rail wraps it with a title and a collapse control (`context-rail.tsx`); the phone's
 * context sheet puts it in a bottom sheet. Both show the same sub-tabs, the same filters and the same
 * rows because both render THIS — there is no second phone list to drift from the desktop one.
 *
 * Search text and the chosen chip are kept per sub-tab, and a sub-tab's rows are read the first time it
 * is shown and kept, so moving between sub-tabs neither forgets what the reader typed nor reads again.
 */

import { useId, useState } from 'react';
import { Badge } from '../../shell/primitives.tsx';
import { SheetTabs, sheetPanelId, sheetTabId } from '../../shell/sheet-tabs.tsx';
import type { SkillsCatalog } from '../skills/skills-catalog.ts';
import { ContextDocsPanel, ContextSkillsPanel } from './context-rail-lists.tsx';
import { type ContextMcpSignInHost, ContextMcpPanel } from './context-rail-mcp.tsx';
import {
  CONTEXT_RAIL_TAB_LABEL,
  CONTEXT_RAIL_TABS,
  type ContextDoc,
  type ContextMcpServer,
  type ContextRailTab,
  type DocChip,
  type McpChip,
  type SignalChip,
  type SkillChip,
} from './context-rail-model.ts';
import { useContextRead } from './context-rail-parts.tsx';
import type { ContextLoader, ContextSignalsPort } from './context-rail-ports.ts';
import { ContextSignalsPanel, useContextSignals } from './context-rail-signals.tsx';

export interface ContextRailBodyProps {
  /** The agent whose folder this is, for the line under a signal it raised. */
  readonly agentName: string;
  readonly signals: ContextSignalsPort;
  readonly loadMcp: ContextLoader<readonly ContextMcpServer[]>;
  readonly loadSkills: ContextLoader<SkillsCatalog>;
  readonly loadDocs: ContextLoader<readonly ContextDoc[]>;
  /** Puts `/name` (or `$name`) into this agent's composer draft. */
  readonly onInsertSkill: (invocation: string) => void;
  /** Opens a file, by its path relative to the agent's folder, in a Files tab. */
  readonly onOpenFile: (path: string) => void;
  /** Lets MCP rows sign in. Without it they say where each sign-in stands and offer nothing. */
  readonly mcpSignIn?: ContextMcpSignInHost;
  /** The shown sub-tab, when the host keeps it (the phone sheet remembers it between openings). */
  readonly tab?: ContextRailTab;
  readonly onTabChange?: (tab: ContextRailTab) => void;
  readonly now?: () => number;
  readonly searchDebounceMs?: number;
}

interface Filters {
  readonly signals: { readonly query: string; readonly chip: SignalChip };
  readonly mcp: { readonly query: string; readonly chip: McpChip };
  readonly skills: { readonly query: string; readonly chip: SkillChip };
  readonly docs: { readonly query: string; readonly chip: DocChip };
}

const INITIAL_FILTERS: Filters = {
  signals: { query: '', chip: 'open' },
  mcp: { query: '', chip: 'all' },
  skills: { query: '', chip: 'all' },
  docs: { query: '', chip: 'all' },
};

export function ContextRailBody({
  agentName,
  signals: port,
  loadMcp,
  loadSkills,
  loadDocs,
  onInsertSkill,
  onOpenFile,
  mcpSignIn,
  tab: shownTab,
  onTabChange,
  now = Date.now,
  searchDebounceMs,
}: ContextRailBodyProps) {
  const signalsRead = useContextSignals(port);
  const id = useId().replace(/:/gu, '');
  const [ownTab, setOwnTab] = useState<ContextRailTab>('signals');
  const tab = shownTab ?? ownTab;
  const [filters, setFilters] = useState<Filters>(INITIAL_FILTERS);
  const mcp = useContextRead(loadMcp, tab === 'mcp');
  const skills = useContextRead(loadSkills, tab === 'skills');
  const docs = useContextRead(loadDocs, tab === 'docs');

  const choose = (next: ContextRailTab): void => {
    setOwnTab(next);
    onTabChange?.(next);
  };
  const setQuery =
    <T extends ContextRailTab>(key: T) =>
    (query: string): void =>
      setFilters(previous => ({ ...previous, [key]: { ...previous[key], query } }));
  const setChip =
    <T extends ContextRailTab>(key: T) =>
    (chip: Filters[T]['chip']): void =>
      setFilters(previous => ({ ...previous, [key]: { ...previous[key], chip } }));

  const openCount = signalsRead.snapshot?.count ?? 0;
  const shared = searchDebounceMs === undefined ? {} : { searchDebounceMs };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-context-rail-body="">
      <SheetTabs
        sheetId={id}
        label="This folder"
        current={tab}
        order={CONTEXT_RAIL_TABS}
        onChange={choose}
        tabs={CONTEXT_RAIL_TABS.map(key => ({
          key,
          label: CONTEXT_RAIL_TAB_LABEL[key],
          ...(key === 'signals' && openCount > 0
            ? {
                badge: (
                  <Badge tone="warn" aria-label={`${openCount} open`} data-context-signals-count="">
                    {openCount}
                  </Badge>
                ),
              }
            : {}),
        }))}
      />
      <div
        role="tabpanel"
        id={sheetPanelId(id, tab)}
        aria-labelledby={sheetTabId(id, tab)}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto p-sm"
        data-context-panel={tab}
      >
        {tab === 'signals' ? (
          <ContextSignalsPanel
            port={port}
            read={signalsRead}
            agentName={agentName}
            query={filters.signals.query}
            onQueryChange={setQuery('signals')}
            chip={filters.signals.chip}
            onChipChange={setChip('signals')}
            now={now}
            {...shared}
          />
        ) : tab === 'mcp' ? (
          <ContextMcpPanel
            read={mcp}
            query={filters.mcp.query}
            onQueryChange={setQuery('mcp')}
            chip={filters.mcp.chip}
            onChipChange={setChip('mcp')}
            now={now}
            {...(mcpSignIn === undefined ? {} : { signIn: mcpSignIn })}
            {...shared}
          />
        ) : tab === 'skills' ? (
          <ContextSkillsPanel
            read={skills}
            query={filters.skills.query}
            onQueryChange={setQuery('skills')}
            chip={filters.skills.chip}
            onChipChange={setChip('skills')}
            onInsertSkill={onInsertSkill}
            {...shared}
          />
        ) : (
          <ContextDocsPanel
            read={docs}
            query={filters.docs.query}
            onQueryChange={setQuery('docs')}
            chip={filters.docs.chip}
            onChipChange={setChip('docs')}
            onOpenFile={onOpenFile}
            {...shared}
          />
        )}
      </div>
    </div>
  );
}
