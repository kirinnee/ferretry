/**
 * Skills and Docs: two plain lists whose rows each do one thing.
 *
 * A skill row inserts the skill into the composer — the harness's own spelling, `/name` for Claude and
 * `$name` for Codex (`skillInsertText`) — and nothing else: there is deliberately no send. A doc row
 * asks the host to open the file in a Files tab.
 */

import type { SkillsCatalog } from '../skills/skills-catalog.ts';
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
import { type ContextRead, ContextFailure, ContextFilterBar, ContextNote } from './context-rail-parts.tsx';

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

export interface ContextSkillsPanelProps extends ListPanelProps<SkillsCatalog, SkillChip> {
  /** Receives `/name` or `$name`, to put in the composer draft. */
  readonly onInsertSkill: (invocation: string) => void;
}

export function ContextSkillsPanel({
  read,
  query,
  onQueryChange,
  chip,
  onChipChange,
  searchDebounceMs,
  onInsertSkill,
}: ContextSkillsPanelProps) {
  const { load, reload } = read;
  if (load.kind === 'failed')
    return <ContextFailure title="Couldn’t read this agent’s skills" reason={load.reason} onRetry={reload} />;
  if (load.kind !== 'ready') return <ContextNote>Reading skills…</ContextNote>;

  const { harness, skills } = load.value;
  const chips = skillChips(skills, query);
  // A chip the catalog does not offer (Codex on a Claude agent) reads as All.
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
      <p className="m-0 text-2xs text-faint">{skillHarnessLabel(harness)}</p>
      {visible.length === 0 ? (
        <ContextNote>{contextEmptyCopy('skills', total, query, chipLabel)}</ContextNote>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0" data-context-list="skills">
          {visible.map(skill => {
            const invocation = skillInsertText(harness, skill.name);
            return (
              <li key={`${skill.scope}/${skill.name}`}>
                <button
                  type="button"
                  className={ROW}
                  aria-label={`Use ${invocation} in chat`}
                  onClick={() => onInsertSkill(invocation)}
                  data-context-skill={skill.name}
                >
                  <span className="max-w-full truncate font-mono text-cell text-fg">{invocation}</span>
                  <span className="line-clamp-2 text-meta text-muted">{skill.description}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Docs ─────────────────────────────────────────────────────────────────────────────────────────

export interface ContextDocsPanelProps extends ListPanelProps<readonly ContextDoc[], DocChip> {
  /** Opens one file, by its path relative to the agent's folder, in a Files tab. */
  readonly onOpenFile: (path: string) => void;
}

export function ContextDocsPanel({
  read,
  query,
  onQueryChange,
  chip,
  onChipChange,
  searchDebounceMs,
  onOpenFile,
}: ContextDocsPanelProps) {
  const { load, reload } = read;
  if (load.kind === 'failed')
    return <ContextFailure title="Couldn’t list this folder’s instructions" reason={load.reason} onRetry={reload} />;
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
