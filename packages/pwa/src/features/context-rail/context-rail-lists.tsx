/**
 * Skills and Instructions: two plain lists.
 *
 * A skill row inserts the skill into the composer — the harness's own spelling, `/name` for Claude and
 * `$name` for Codex (`skillInsertText`) — and nothing else: there is deliberately no send. It says where
 * the skill comes from (Project, User or Ferretry) and, when a same-named one of another scope wins, which
 * one; Open reads its SKILL.md. An instruction row asks the host to open the file in a Files tab.
 */

import type { SessionSkillsInventory, SkillEntry, SkillFile } from '@ferretry/protocol';
import { useCallback, useId, useState } from 'react';
import { Markdown } from '../../components/markdown.tsx';
import {
  CatalogRowTools,
  type CatalogRowsHost,
  InstallFromFileButton,
  useCatalogInstalls,
} from '../catalogs/catalog-row-tools.tsx';
import { cn } from '../../lib/class-names.ts';
import { BottomSheet } from '../../shell/bottom-sheet.tsx';
import { Button } from '../../shell/primitives.tsx';
import { SKILL_SCOPE_LABEL, SKILL_SCOPE_TITLE, skillOverride, sortedSkills } from '../mcp/mcp-model.ts';
import { skillHarnessLabel, skillInsertText } from '../skills/skills-catalog.ts';
import {
  CONTEXT_RAIL_SEARCH_LABEL,
  type ContextDoc,
  contextEmptyCopy,
  type DocChip,
  docChips,
  docSize,
  type SkillChip,
  skillChips,
  visibleDocs,
  visibleSkills,
} from './context-rail-model.ts';
import {
  ContextFailure,
  ContextFilterBar,
  ContextNote,
  type ContextRead,
  useContextRead,
} from './context-rail-parts.tsx';

const ROW =
  'flex min-h-row w-full min-w-0 flex-col items-start gap-0.5 rounded-control px-xs py-xs text-left hover:bg-surface-2 focus-visible:bg-surface-2';

interface ListPanelProps<T, K extends string> {
  readonly read: ContextRead<T>;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly chip: K;
  readonly onChipChange: (chip: K) => void;
  readonly searchDebounceMs?: number;
}

// ── Skills ───────────────────────────────────────────────────────────────────────────────────────

/** Reads one listed skill's SKILL.md, for Open. */
export type SkillFileLoader = (path: string, signal: AbortSignal) => Promise<SkillFile>;

export interface ContextSkillsPanelProps extends ListPanelProps<SessionSkillsInventory, SkillChip> {
  /** Receives `/name` or `$name`, to put in the composer draft. */
  readonly onInsertSkill: (invocation: string) => void;
  /** Reads a SKILL.md for Open. Without it, rows offer no Open. */
  readonly loadSkillFile?: SkillFileLoader;
  /** The machine's own name, for a failure said in words. */
  readonly machineName: string;
  /** Lets rows offer "Add to catalog…", say where an installed skill came from, and install from a file. */
  readonly catalogs?: CatalogRowsHost;
}

export function ContextSkillsPanel({
  read,
  query,
  onQueryChange,
  chip,
  onChipChange,
  searchDebounceMs,
  onInsertSkill,
  loadSkillFile,
  machineName,
  catalogs,
}: ContextSkillsPanelProps) {
  const [opened, setOpened] = useState<SkillEntry | null>(null);
  const installed = useCatalogInstalls(catalogs);
  const { load, reload } = read;
  if (load.kind === 'failed')
    return (
      <ContextFailure
        machineName={machineName}
        what="read this ferret’s skills"
        reason={load.reason}
        {...(load.outdated === undefined ? {} : { outdated: load.outdated, showing: 'skills' })}
        onRetry={reload}
      />
    );
  if (load.kind !== 'ready') return <ContextNote>Reading skills…</ContextNote>;

  const { harness } = load.value;
  const skills = sortedSkills(load.value.skills);
  const chips = skillChips(skills, query);
  // A chip this ferret has no skill for (Project, outside a project) reads as All.
  const active = chips.some(entry => entry.key === chip) ? chip : 'all';
  const visible = visibleSkills(skills, query, active);
  const chipLabel = chips.find(entry => entry.key === active)?.label ?? 'All';
  const total = visibleSkills(skills, '', active).length;

  return (
    <div className="flex min-w-0 flex-col gap-sm">
      <ContextFilterBar
        searchLabel={CONTEXT_RAIL_SEARCH_LABEL.skills}
        query={query}
        onQueryChange={onQueryChange}
        chips={chips}
        chip={active}
        onChipChange={onChipChange}
        {...(searchDebounceMs === undefined ? {} : { debounceMs: searchDebounceMs })}
      />
      <div className="flex min-w-0 items-center justify-between gap-sm">
        <p className="m-0 text-2xs text-faint">
          {skillHarnessLabel(harness)}
          {load.value.truncated ? ' · the list was cut short' : ''}
        </p>
        {catalogs === undefined ? null : <InstallFromFileButton host={catalogs} />}
      </div>
      {visible.length === 0 ? (
        <ContextNote>{contextEmptyCopy('skills', total, query, chipLabel)}</ContextNote>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0" data-context-list="skills">
          {visible.map(skill => {
            const invocation = skillInsertText(harness, skill.name);
            const override = skillOverride(skill);
            return (
              <li
                key={skill.path}
                className={cn('flex min-w-0 flex-col', override !== undefined && 'opacity-70')}
                data-context-skill-scope={skill.scope}
              >
                <div className="flex min-w-0 items-start gap-xs">
                  <button
                    type="button"
                    className={ROW}
                    aria-label={`Use ${invocation} in chat`}
                    onClick={() => onInsertSkill(invocation)}
                    data-context-skill={skill.name}
                  >
                    <span className="flex max-w-full min-w-0 flex-wrap items-center gap-x-xs gap-y-0.5">
                      <span className="min-w-0 truncate font-mono text-cell text-fg">{invocation}</span>
                      <span
                        className="fy-info-chip"
                        data-tone={skill.scope === 'project' ? 'accent' : 'muted'}
                        title={SKILL_SCOPE_TITLE[skill.scope]}
                      >
                        {SKILL_SCOPE_LABEL[skill.scope]}
                      </span>
                    </span>
                    <span className="line-clamp-2 text-meta text-muted">{skill.description}</span>
                    {override === undefined ? null : (
                      <span className="text-meta text-faint" data-context-skill-override="">
                        {override}
                      </span>
                    )}
                  </button>
                  {loadSkillFile === undefined ? null : (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="mt-xs shrink-0"
                      aria-label={`Open ${skill.name}’s SKILL.md`}
                      onClick={() => setOpened(skill)}
                      data-context-skill-open={skill.name}
                    >
                      Open
                    </Button>
                  )}
                </div>
                {catalogs === undefined ? null : (
                  <div className="px-xs pb-xs">
                    <CatalogRowTools
                      host={catalogs}
                      kind="skill"
                      name={skill.name}
                      source={{ kind: 'skill', skill: skill.path }}
                      read={installed}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {opened === null || loadSkillFile === undefined ? null : (
        <SkillFileSheet skill={opened} load={loadSkillFile} machineName={machineName} onClose={() => setOpened(null)} />
      )}
    </div>
  );
}

/** A SKILL.md's YAML front matter, and the Markdown after it. */
export const splitFrontMatter = (content: string): { readonly frontMatter: string | null; readonly body: string } => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(content);
  return match === null
    ? { frontMatter: null, body: content }
    : { frontMatter: match[1] ?? '', body: content.slice(match[0].length) };
};

/** The front matter as the lines it is, then the body as the document it is. */
function SkillDocument({ content }: { readonly content: string }) {
  const { frontMatter, body } = splitFrontMatter(content);
  return (
    <div className="flex min-w-0 flex-col gap-sm overflow-auto">
      {frontMatter === null || frontMatter.trim() === '' ? null : (
        <pre
          className="m-0 whitespace-pre-wrap break-words rounded-control bg-surface-2 p-xs font-mono text-2xs text-muted"
          data-context-skill-front-matter=""
        >
          {frontMatter}
        </pre>
      )}
      <Markdown text={body} />
    </div>
  );
}

/** One SKILL.md, read when opened and shown as the document it is. */
function SkillFileSheet({
  skill,
  load,
  machineName,
  onClose,
}: {
  readonly skill: SkillEntry;
  readonly load: SkillFileLoader;
  readonly machineName: string;
  readonly onClose: () => void;
}) {
  const titleId = useId();
  const reader = useCallback((signal: AbortSignal) => load(skill.path, signal), [load, skill.path]);
  const file = useContextRead(reader, true);
  return (
    <BottomSheet id={`skill-file-${titleId}`} open onClose={onClose} labelledBy={titleId} closeLabel="Close SKILL.md">
      <div className="flex min-w-0 flex-col gap-sm p-panel" data-context-skill-file={skill.name}>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 id={titleId} className="m-0 font-mono text-row text-fg">
            {skill.name}
          </h3>
          <p className="m-0 break-all font-mono text-2xs text-faint">{skill.path}</p>
        </div>
        {file.load.kind === 'failed' ? (
          <ContextFailure
            machineName={machineName}
            what={`open ${skill.name}’s SKILL.md`}
            reason={file.load.reason}
            {...(file.load.outdated === undefined ? {} : { outdated: file.load.outdated, showing: 'this SKILL.md' })}
            onRetry={file.reload}
          />
        ) : file.load.kind === 'ready' ? (
          <SkillDocument content={file.load.value.content} />
        ) : (
          <ContextNote>Reading SKILL.md…</ContextNote>
        )}
      </div>
    </BottomSheet>
  );
}

// ── Instructions ─────────────────────────────────────────────────────────────────────────────────────────

export interface ContextDocsPanelProps extends ListPanelProps<readonly ContextDoc[], DocChip> {
  /** Opens one file, by its path relative to the agent's folder, in a Files tab. */
  readonly onOpenFile: (path: string) => void;
  /** The machine's own name, for a failure said in words. */
  readonly machineName: string;
}

export function ContextDocsPanel({
  read,
  query,
  onQueryChange,
  chip,
  onChipChange,
  searchDebounceMs,
  onOpenFile,
  machineName,
}: ContextDocsPanelProps) {
  const { load, reload } = read;
  if (load.kind === 'failed')
    return (
      <ContextFailure
        machineName={machineName}
        what="list this folder’s instructions"
        reason={load.reason}
        onRetry={reload}
      />
    );
  if (load.kind !== 'ready') return <ContextNote>Reading instructions…</ContextNote>;

  const docs = load.value;
  const chips = docChips(docs, query);
  const visible = visibleDocs(docs, query, chip);
  const chipLabel = chips.find(entry => entry.key === chip)?.label ?? 'All';
  const total = visibleDocs(docs, '', chip).length;

  return (
    <div className="flex min-w-0 flex-col gap-sm">
      <ContextFilterBar
        searchLabel={CONTEXT_RAIL_SEARCH_LABEL.docs}
        query={query}
        onQueryChange={onQueryChange}
        chips={chips}
        chip={chip}
        onChipChange={onChipChange}
        {...(searchDebounceMs === undefined ? {} : { debounceMs: searchDebounceMs })}
      />
      {visible.length === 0 ? (
        <ContextNote>{contextEmptyCopy('docs', total, query, chipLabel)}</ContextNote>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0" data-context-list="docs">
          {visible.map(doc => (
            <li key={doc.path}>
              <button
                type="button"
                className={ROW}
                aria-label={`Open ${doc.path} in a Files tab`}
                onClick={() => onOpenFile(doc.path)}
                data-context-doc={doc.path}
              >
                <span className="max-w-full truncate font-mono text-cell text-fg">{doc.name}</span>
                <span className="text-meta text-muted">
                  {[docSize(doc), 'opens in a Files tab'].filter(part => part !== '').join(' · ')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
