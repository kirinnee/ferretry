/**
 * The content of Context without any chrome: the four sub-tabs, each with its search and chips, and the
 * list under them.
 *
 * Info › Context draws it with the Files, Instructions, Skills and MCP sub-tabs, in Info's right panel on a desktop
 * and its bottom sheet on a phone. Both show the same sub-tabs, the same filters and the same rows because
 * both render THIS — there is no second phone list to drift from the desktop one.
 *
 * Search text and the chosen chip are kept per sub-tab, and a sub-tab's rows are read the first time it
 * is shown and kept, so moving between sub-tabs neither forgets what the reader typed nor reads again.
 */

import type { McpInventory, SessionSkillsInventory } from '@ferretry/protocol';
import { type ReactNode, useId, useState } from 'react';
import { Badge } from '../../shell/primitives.tsx';
import { SheetTabs, sheetPanelId, sheetTabId } from '../../shell/sheet-tabs.tsx';
import { ContextDocsPanel, ContextSkillsPanel, type SkillFileLoader } from './context-rail-lists.tsx';
import { ContextMcpPanel, type ContextMcpSignInHost } from './context-rail-mcp.tsx';
import {
  CONTEXT_RAIL_TAB_LABEL,
  CONTEXT_RAIL_TABS,
  type ContextDoc,
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
  /** Its session id: a Check reaches each MCP server as this ferret does. */
  readonly sessionId: string;
  /** The machine's own name, for a failure said in words. */
  readonly machineName: string;
  readonly signals: ContextSignalsPort;
  readonly loadMcp: ContextLoader<McpInventory>;
  readonly loadSkills: ContextLoader<SessionSkillsInventory>;
  /** Reads one SKILL.md for a skill row's Open. */
  readonly loadSkillFile?: SkillFileLoader;
  readonly loadDocs: ContextLoader<readonly ContextDoc[]>;
  /** Puts `/name` (or `$name`) into this agent's composer draft. */
  readonly onInsertSkill: (invocation: string) => void;
  /** Opens a file, by its path relative to the agent's folder, in a Files tab. */
  readonly onOpenFile: (path: string) => void;
  /** Lets MCP rows check and sign in. Without it they say where each server stands and offer nothing. */
  readonly mcpSignIn?: ContextMcpSignInHost;
  /** The shown sub-tab, when the host keeps it (the phone sheet remembers it between openings). */
  readonly tab?: ContextRailTab;
  readonly onTabChange?: (tab: ContextRailTab) => void;
  /** Which sub-tabs, in order. Default: the rail's Signals, MCP, Skills, Docs. */
  readonly tabs?: readonly ContextRailTab[];
  /** The tab strip's accessible name. */
  readonly label?: string;
  /** The Files sub-tab's body: the workspace's own Files picker, handed in by the host. */
  readonly renderFiles?: () => ReactNode;
  /** MCP's "Add…": opens Actions › Add MCP server. */
  readonly onAddMcp?: () => void;
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
  sessionId,
  machineName,
  signals: port,
  loadMcp,
  loadSkills,
  loadSkillFile,
  loadDocs,
  onInsertSkill,
  onOpenFile,
  mcpSignIn,
  tab: shownTab,
  onTabChange,
  tabs = CONTEXT_RAIL_TABS,
  label = 'Context',
  renderFiles,
  onAddMcp,
  now = Date.now,
  searchDebounceMs,
}: ContextRailBodyProps) {
  const signalsRead = useContextSignals(port);
  const id = useId().replace(/:/gu, '');
  const [ownTab, setOwnTab] = useState<ContextRailTab>(tabs[0] ?? 'signals');
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
    <T extends keyof Filters>(key: T) =>
    (query: string): void =>
      setFilters(previous => ({ ...previous, [key]: { ...previous[key], query } }));
  const setChip =
    <T extends keyof Filters>(key: T) =>
    (chip: Filters[T]['chip']): void =>
      setFilters(previous => ({ ...previous, [key]: { ...previous[key], chip } }));

  const openCount = signalsRead.snapshot?.count ?? 0;
  const shared = searchDebounceMs === undefined ? {} : { searchDebounceMs };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-context-rail-body="">
      <SheetTabs
        sheetId={id}
        label={label}
        current={tab}
        order={tabs}
        onChange={choose}
        tabs={tabs.map(key => ({
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
        {tab === 'files' ? (
          (renderFiles?.() ?? null)
        ) : tab === 'signals' ? (
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
            sessionId={sessionId}
            machineName={machineName}
            query={filters.mcp.query}
            onQueryChange={setQuery('mcp')}
            chip={filters.mcp.chip}
            onChipChange={setChip('mcp')}
            now={now}
            {...(mcpSignIn === undefined ? {} : { signIn: mcpSignIn })}
            {...(onAddMcp === undefined ? {} : { onAdd: onAddMcp })}
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
            machineName={machineName}
            {...(loadSkillFile === undefined ? {} : { loadSkillFile })}
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
            machineName={machineName}
            {...shared}
          />
        )}
      </div>
    </div>
  );
}
