/**
 * The Skills tab of a ferret's "This folder" context (`ferret.side`, subject = the ferret id).
 *
 * The list is what THIS FERRET CAN USE, and its header says so in words ("16 active in this ferret"). A skill row puts the
 * skill into the composer — the harness's own spelling, `/name` for Claude and `$name` for Codex (`skillInsertText`) —
 * and nothing else: there is deliberately no send. It says where the skill came from (This project, This account or
 * Ferretry) and, when a same-named one elsewhere wins, that it is not active; Open reads its SKILL.md.
 * The header offers the `skills.add` slot (contract/slots.ts): a plugin that knows another place skills come from puts
 * its "+ Add skills" there.
 */
import {
  type ComposerQuoteTarget,
  composerQuoteTarget,
  daemonFerretScope,
  daemonOfClient,
  PanelSlot,
} from '@ferretry/app';
import {
  Button,
  type ContextRead,
  ContextFailure,
  ContextFilterBar,
  ContextNote,
  contextEmptyCopy,
  useContextRead,
} from '@ferretry/app/ui';
import type { AppComponent, PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import {
  SKILLS_ADD_SLOT,
  type FerretSkillsInventory,
  type SkillEntry,
  type SkillsAddSlotProps,
} from '../../contract/index.ts';
import { readFerretSkillsInventory, readSkillFile } from '../lib/client.ts';
import {
  activeSkillsLine,
  appendSkillInvocation,
  NO_SKILLS,
  SKILLS_SEARCH_LABEL,
  SKILL_SCOPE_LABEL,
  SKILL_SCOPE_TITLE,
  type SkillChip,
  skillChips,
  skillInsertText,
  skillOverride,
  sortedSkills,
  visibleSkills,
} from '../lib/skills-model.ts';
import { SkillFileSheet } from './skill-file-sheet.tsx';

/** This machine's own words for a failure: the panel is drawn per daemon and the daemon's name is the shell's. */
const MACHINE = 'This machine';

/** Puts one invocation at the end of this ferret's draft. `false` when no composer is mounted for it. */
function insertIntoComposer(
  target: Pick<ComposerQuoteTarget, 'draft' | 'replaceDraft'> | null,
  invocation: string,
): boolean {
  if (target === null) return false;
  target.replaceDraft(appendSkillInvocation(target.draft(), invocation));
  return true;
}

function SkillRow({
  skill,
  invocation,
  onUse,
  onOpen,
}: {
  readonly skill: SkillEntry;
  readonly invocation: string;
  readonly onUse: () => void;
  readonly onOpen: () => void;
}) {
  const override = skillOverride(skill);
  return (
    <li
      className="flex min-w-0 flex-col gap-0.5 rounded-control px-xs py-xs"
      data-context-skill-scope={skill.scope}
      data-dimmed={override === undefined ? undefined : ''}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-xs">
        <button
          type="button"
          className="min-h-row min-w-0 max-w-full truncate bg-transparent p-0 text-left font-mono text-row text-fg"
          onClick={onUse}
          data-context-skill-use=""
        >
          {invocation}
          <span className="sr-only"> — put in the chat box</span>
        </button>
        <span
          className="fy-info-chip"
          title={SKILL_SCOPE_TITLE[skill.scope]}
          data-tone={skill.scope === 'project' ? 'accent' : 'muted'}
        >
          {SKILL_SCOPE_LABEL[skill.scope]}
        </span>
        <Button type="button" size="sm" onClick={onOpen} data-context-skill-open="">
          Open<span className="sr-only"> {skill.name}</span>
        </Button>
      </div>
      <p className="m-0 break-words text-meta text-muted" title={skill.description}>
        {skill.description}
      </p>
      {override === undefined ? null : <p className="m-0 text-meta text-faint">{override}</p>}
    </li>
  );
}

function SkillsList({
  read,
  query,
  onQueryChange,
  chip,
  onChipChange,
  onUse,
  onOpen,
  addSlot,
  searchDebounceMs,
}: {
  readonly read: ContextRead<FerretSkillsInventory>;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly chip: SkillChip;
  readonly onChipChange: (chip: SkillChip) => void;
  readonly onUse: (invocation: string) => void;
  readonly onOpen: (skill: SkillEntry) => void;
  readonly addSlot?: ReactNode;
  readonly searchDebounceMs?: number;
}): ReactNode {
  const { load, reload } = read;
  if (load.kind === 'failed')
    return (
      <ContextFailure machineName={MACHINE} what="read this ferret’s skills" reason={load.reason} onRetry={reload} />
    );
  if (load.kind !== 'ready') return <ContextNote>Reading skills…</ContextNote>;

  const inventory = load.value;
  const skills = sortedSkills(inventory.skills);
  const chips = skillChips(skills, query);
  // A chip this ferret has no skill for (Project, outside a project) reads as All.
  const active = chips.some(entry => entry.key === chip) ? chip : 'all';
  const visible = visibleSkills(skills, query, active);
  const chipLabel = chips.find(entry => entry.key === active)?.label ?? 'All';
  const total = visibleSkills(skills, '', active).length;

  return (
    <div className="flex min-w-0 flex-col gap-sm">
      <ContextFilterBar
        searchLabel={SKILLS_SEARCH_LABEL}
        query={query}
        onQueryChange={onQueryChange}
        chips={chips}
        chip={active}
        onChipChange={onChipChange}
        {...(searchDebounceMs === undefined ? {} : { debounceMs: searchDebounceMs })}
      />
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-xs">
        <p className="m-0 min-w-0 text-2xs text-faint" data-context-skills-active="">
          {activeSkillsLine(inventory)}
        </p>
        {addSlot}
      </div>
      {visible.length === 0 ? (
        <ContextNote>{contextEmptyCopy(NO_SKILLS, total, query, chipLabel)}</ContextNote>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0" data-context-list="skills">
          {visible.map(skill => (
            <SkillRow
              key={skill.path}
              skill={skill}
              invocation={skillInsertText(inventory.harness, skill.name)}
              onUse={() => onUse(skillInsertText(inventory.harness, skill.name))}
              onOpen={() => onOpen(skill)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One daemon's Skills panel: built once per client, drawn for whichever ferret the shell names. */
export function createSkillsPanel(client: Pick<PluginClient, 'call'>): AppComponent<PanelProps> {
  return function SkillsPanel({ subject }: PanelProps): ReactNode {
    if (subject === undefined) return <ContextNote>Pick a ferret to see its skills.</ContextNote>;
    return <FerretSkills client={client} ferretId={subject} />;
  };
}

function FerretSkills({
  client,
  ferretId,
}: {
  readonly client: Pick<PluginClient, 'call'>;
  readonly ferretId: string;
}) {
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState<SkillChip>('all');
  const [opened, setOpened] = useState<SkillEntry | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const loader = useCallback((_signal: AbortSignal) => readFerretSkillsInventory(client, ferretId), [client, ferretId]);
  const read = useContextRead(loader, true);
  const loadFile = useCallback(
    async (path: string, _signal: AbortSignal) => await readSkillFile(client, path, ferretId),
    [client, ferretId],
  );
  const scope = useMemo(() => {
    const daemonId = daemonOfClient(client);
    return daemonId === undefined ? null : daemonFerretScope({ daemonId }, ferretId);
  }, [client, ferretId]);

  const daemon = daemonOfClient(client);
  const inventory = read.load.kind === 'ready' ? read.load.value : undefined;
  const addSlot =
    daemon === undefined || inventory === undefined ? undefined : (
      <PanelSlot
        daemon={daemon}
        slot={SKILLS_ADD_SLOT}
        subject={ferretId}
        props={
          {
            ferret: ferretId,
            folder: inventory.folder,
            harness: inventory.harness,
            ...(inventory.runtime === undefined ? {} : { runtime: inventory.runtime }),
            scopes: [...new Set(inventory.skills.map(skill => skill.scope))],
          } satisfies SkillsAddSlotProps
        }
      />
    );

  const use = (invocation: string): void => {
    const delivered = insertIntoComposer(scope === null ? null : composerQuoteTarget(scope), invocation);
    setNote(delivered ? `Put ${invocation} in the chat box.` : `Open this ferret’s chat to use ${invocation}.`);
  };

  return (
    <>
      <SkillsList
        read={read}
        query={query}
        onQueryChange={setQuery}
        chip={chip}
        onChipChange={setChip}
        onUse={use}
        onOpen={setOpened}
        addSlot={addSlot}
      />
      {note === null ? null : (
        <p className="m-0 py-xs text-meta text-muted" role="status" data-context-skill-note="">
          {note}
        </p>
      )}
      {opened === null ? null : (
        <SkillFileSheet skill={opened} load={loadFile} machineName={MACHINE} onClose={() => setOpened(null)} />
      )}
    </>
  );
}
