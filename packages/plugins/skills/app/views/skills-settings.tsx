/**
 * Settings › Skills: every skill on this machine — each runtime account's own folder and each registered project's — with
 * Open for its SKILL.md, and the copies this machine made from itself with Remove (only the files that copy wrote).
 *
 * It is the machine's inventory (`GET /v1/skills`, docs/skills-inventory.md), not one ferret's: a skill another one of the
 * same name hides (`shadowedBy`) is still listed here, because a person may open it on purpose.
 */
import { Button, ContextFailure, ContextNote, useContextRead } from '@ferretry/app/ui';
import type { AppComponent, PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import { type ReactNode, useCallback, useState } from 'react';
import type { SkillEntry } from '../../contract/index.ts';
import { readMachineSkills, readSkillFile } from '../lib/client.ts';
import { SKILL_SCOPE_LABEL, skillOverride, sortedSkills } from '../lib/skills-model.ts';
import { SkillFileSheet } from './skill-file-sheet.tsx';

const MACHINE = 'This machine';

function Group({
  title,
  skills,
  onOpen,
}: {
  readonly title: string;
  readonly skills: readonly SkillEntry[];
  readonly onOpen: (skill: SkillEntry) => void;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-xs" aria-label={title} data-skills-group={title}>
      <h3 className="m-0 break-words text-cell font-semibold text-fg">{title}</h3>
      {skills.length === 0 ? (
        <p className="m-0 text-meta text-muted">No skills here.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-xs p-0">
          {sortedSkills(skills).map(skill => (
            <li key={skill.path} className="flex min-w-0 flex-col gap-0.5" data-skills-row={skill.path}>
              <div className="flex min-w-0 flex-wrap items-center gap-xs">
                <span className="min-w-0 break-words font-mono text-row text-fg">{skill.name}</span>
                <span className="fy-info-chip" data-tone="muted">
                  {SKILL_SCOPE_LABEL[skill.scope]}
                </span>
                <Button type="button" size="sm" onClick={() => onOpen(skill)} data-skills-open="">
                  Open<span className="sr-only"> {skill.name}</span>
                </Button>
              </div>
              <p className="m-0 break-words text-meta text-muted">{skill.description}</p>
              {skillOverride(skill) === undefined ? null : (
                <p className="m-0 text-meta text-faint">{skillOverride(skill)}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One daemon's Skills settings tab: built once per client. */
export function createSkillsSettings(client: Pick<PluginClient, 'call'>): AppComponent<SettingsProps> {
  return function SkillsSettings(): ReactNode {
    const loader = useCallback((_signal: AbortSignal) => readMachineSkills(client), []);
    const read = useContextRead(loader, true);
    const [opened, setOpened] = useState<SkillEntry | null>(null);
    const loadFile = useCallback(async (path: string, _signal: AbortSignal) => await readSkillFile(client, path), []);
    if (read.load.kind === 'failed')
      return (
        <ContextFailure
          machineName={MACHINE}
          what="read this machine’s skills"
          reason={read.load.reason}
          onRetry={read.reload}
        />
      );
    if (read.load.kind !== 'ready') return <ContextNote>Reading skills…</ContextNote>;
    const inventory = read.load.value;
    return (
      <section className="flex min-w-0 flex-col gap-sm" aria-label="Skills" data-settings="skills">
        <p className="m-0 text-meta text-muted">
          Every skill on this machine, by runtime account and by project. Open reads a skill’s SKILL.md.
        </p>
        {inventory.homes.map(home => (
          <Group
            key={`${home.runtime}:${home.harness}`}
            title={`${home.runtime} account`}
            skills={home.skills}
            onOpen={setOpened}
          />
        ))}
        {inventory.projects.map(project => (
          <Group key={project.root} title={`Project ${project.name}`} skills={project.skills} onOpen={setOpened} />
        ))}
        {inventory.truncated ? (
          <p className="m-0 text-meta text-muted" data-skills-truncated="">
            This machine has more skills than the list holds, so some are not shown.
          </p>
        ) : null}
        {opened === null ? null : (
          <SkillFileSheet skill={opened} load={loadFile} machineName={MACHINE} onClose={() => setOpened(null)} />
        )}
      </section>
    );
  };
}
