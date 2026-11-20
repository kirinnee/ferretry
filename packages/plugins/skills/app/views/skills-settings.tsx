/**
 * Settings › Skills: every skill on this machine — each runtime account's own folder and each registered project's — with
 * Open for its SKILL.md, and the copies this machine made from itself with Remove (only the files that copy wrote).
 *
 * It is the machine's inventory (`GET /v1/skills`, docs/skills-inventory.md), not one ferret's: a skill another one of the
 * same name hides (`shadowedBy`) is still listed here, because a person may open it on purpose.
 */
import { SettingGroup } from '@ferretry/app';
import { Button, ContextFailure, Loading, type ReadPress, useContextRead } from '@ferretry/app/ui';
import type { AppComponent, PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import { type ReactNode, useCallback, useState } from 'react';
import type { SkillEntry } from '../../contract/index.ts';
import { readMachineSkills, readSkillFile } from '../lib/client.ts';
import { SKILL_SCOPE_LABEL, skillOverride, sortedSkills } from '../lib/skills-model.ts';
import './skills-settings.css';
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
    <div className="min-w-0" data-skills-group={title}>
      <SettingGroup label={title}>
        {skills.length === 0 ? (
          <li className="py-3 pl-panel pr-1 text-meta text-muted">No skills here.</li>
        ) : (
          <li className="min-w-0">
            <ul className="fy-sk-list">
              {sortedSkills(skills).map(skill => (
                <li
                  key={skill.path}
                  className="flex min-w-0 flex-col gap-0.5 py-2 pl-panel pr-1"
                  data-skills-row={skill.path}
                >
                  <div className="flex min-h-[44px] min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 break-words font-mono text-row text-fg">{skill.name}</span>
                    <span className="fy-info-chip" data-tone="muted">
                      {SKILL_SCOPE_LABEL[skill.scope]}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      className="ml-auto"
                      onClick={() => onOpen(skill)}
                      data-skills-open=""
                    >
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
          </li>
        )}
      </SettingGroup>
    </div>
  );
}

/** One daemon's Skills settings tab: built once per client. */
export function createSkillsSettings(client: Pick<PluginClient, 'call'>): AppComponent<SettingsProps> {
  return function SkillsSettings(): ReactNode {
    const loader = useCallback((_signal: AbortSignal, press: ReadPress) => readMachineSkills(client, press), []);
    const read = useContextRead(loader, true);
    const [opened, setOpened] = useState<SkillEntry | null>(null);
    const loadFile = useCallback(
      async (path: string, _signal: AbortSignal, press: ReadPress) =>
        await readSkillFile(client, path, undefined, press),
      [],
    );
    if (read.load.kind === 'failed')
      return (
        <ContextFailure
          machineName={MACHINE}
          what="read this machine’s skills"
          reason={read.load.reason}
          onRetry={read.reload}
        />
      );
    if (read.load.kind !== 'ready') return <Loading kind="page" label="Reading skills…" />;
    const inventory = read.load.value;
    return (
      <section className="fy-sk flex min-w-0 flex-col" aria-label="Skills" data-settings="skills">
        <p className="m-0 mb-6 text-meta text-muted">
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
