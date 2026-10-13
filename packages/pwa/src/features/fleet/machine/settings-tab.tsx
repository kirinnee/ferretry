/**
 * The Settings tab (docs/design/account-model.md §4.2, §3.6 F4–F5, §4.3, §4.7, E32): what this
 * machine does for every runtime on it.
 *
 * - **Agent permissions** — Auto mode or Skip all permission checks, each with a plain sentence. It
 *   applies to new sessions; with sessions running, the tab says how many keep the old mode (E32).
 * - **Tools on <machine>** — Claude Code and Codex, installed or not, with **Install**.
 * - **Setup** — **Set up <machine>** while it is not set up, otherwise **Import again**; **Clone from
 *   another machine**.
 * - **Machine** — its name, whether it answers, how many runtimes it has, and its format.
 *
 * Each flow is a linkable address under this tab (`settings-route.ts`), so the Runtimes tab's
 * "Set up <machine>" link lands straight in the first run.
 */

import type { FleetMachineView } from '@ferretry/protocol';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { DaemonConnectionRecord } from '../../../lib/connections.ts';
import { useConnectionSnapshot } from '../../../lib/store.tsx';
import { Button } from '../../../shell/primitives.tsx';
import { CloneMachine } from '../setup/clone.tsx';
import { MachineFirstRun } from '../setup/first-run.tsx';
import { InstallTool } from '../setup/install-flow.tsx';
import { type SettingsFlow, useSettingsFlow } from '../setup/settings-route.ts';
import { type SetupAccess, useSetupAccess } from '../setup/setup-access.ts';
import { RadioChoices, SetupNote, SetupRow, SetupSection } from '../setup/setup-ui.tsx';
import { countWords } from '../setup/setup-words.ts';
import { ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import type { MachineTabProps } from '../shell/machines-surface.tsx';

type AgentPermissions = FleetMachineView['agentPermissions'];

export const AGENT_PERMISSION_WORDS: Readonly<Record<AgentPermissions, string>> = {
  auto: 'Auto mode',
  skip: 'Skip all permission checks',
};

/** E32: what happens to sessions already running when the mode changes. */
export const runningSessionsSentence = (running: number, old: AgentPermissions): string =>
  `${countWords(running, 'running session')} ${running === 1 ? 'keeps' : 'keep'} the old mode (${AGENT_PERMISSION_WORDS[old]}) until restarted.`;

const FORMAT_WORDS: Readonly<Record<FleetMachineView['format'], string>> = {
  none: 'Not set up yet',
  'version-2': 'The new account format',
};

export interface MachineSettingsTabProps extends MachineTabProps {
  /** Every OTHER paired machine, for Clone. */
  readonly sources: readonly DaemonConnectionRecord[];
  /** Supplied in tests. */
  readonly browser?: Window;
}

function NavRow({
  title,
  detail,
  onClick,
  name,
}: {
  readonly title: string;
  readonly detail: string;
  readonly onClick: () => void;
  readonly name: string;
}) {
  return (
    <button
      type="button"
      data-settings-action={name}
      onClick={onClick}
      className="kt-panel flex min-h-control w-full min-w-0 items-center gap-3 p-panel text-left transition-colors hover:border-accent"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="[overflow-wrap:anywhere] text-row font-semibold text-fg">{title}</span>
        <span className="[overflow-wrap:anywhere] text-cell text-muted">{detail}</span>
      </span>
      <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-muted" />
    </button>
  );
}

function AgentPermissionsSection({
  machine,
  machineName,
  access,
  onSaved,
}: {
  readonly machine: FleetMachineView;
  readonly machineName: string;
  readonly access: SetupAccess;
  readonly onSaved: () => void;
}) {
  const { changes } = access;
  const [draft, setDraft] = useState<AgentPermissions>(machine.agentPermissions);
  const [changedFrom, setChangedFrom] = useState<AgentPermissions | null>(null);
  const current = machine.agentPermissions;
  const pending = draft !== current;
  const old = pending ? current : changedFrom;
  const save = (): void => {
    void changes.apply({ kind: 'machine.settings', agentPermissions: draft }).then(result => {
      if (result.kind === 'refused') return;
      setChangedFrom(current);
      onSaved();
    });
  };
  return (
    <SetupSection title="Agent permissions" name="agent-permissions">
      <RadioChoices
        legend="Agent permissions"
        legendHidden
        name="agent-permissions"
        value={draft}
        onChoose={value => {
          setDraft(value);
          changes.clear();
        }}
        options={[
          {
            id: 'auto',
            title: AGENT_PERMISSION_WORDS.auto,
            detail: 'Agents work on their own and stop to ask before anything that looks risky.',
          },
          {
            id: 'skip',
            title: AGENT_PERMISSION_WORDS.skip,
            detail: `Agents never stop to ask. They can change any file and run any command on ${machineName}.`,
          },
        ]}
      />
      {old !== null && old !== draft && machine.runningSessions > 0 ? (
        <SetupNote tone="warn" name="agent-permissions-running" title="Applies to new sessions.">
          <span>{runningSessionsSentence(machine.runningSessions, old)}</span>
        </SetupNote>
      ) : (
        <p className="m-0 text-meta leading-base text-muted" data-agent-permissions-hint="">
          Applies to new sessions. Agent runtimes get this through Ferretry’s fixed layer.
        </p>
      )}
      {pending ? (
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={changes.busy}
          refusal={changes.refusal}
          submitLabel="Save agent permissions"
          onSubmit={save}
        >
          <Button type="button" data-agent-permissions-undo="" onClick={() => setDraft(current)}>
            Keep {AGENT_PERMISSION_WORDS[current]}
          </Button>
        </ChangeApplyPanel>
      ) : null}
    </SetupSection>
  );
}

export function MachineSettingsTab(props: MachineSettingsTabProps) {
  const { machine, machineName, online, checking, connection, createClient, onRetry, sources, browser } = props;
  const route = useSettingsFlow(machineName, browser);
  const access = useSetupAccess({ connection, createClient });
  const leave = (): void => route.open(null);
  const toRuntimes = (): void => route.goTo('runtimes');
  const flow: SettingsFlow | null = route.flow;

  if (flow === 'setup' || flow === 'import')
    return <MachineFirstRun key={flow} {...props} mode={flow} onDone={toRuntimes} onLeave={leave} />;
  if (flow === 'clone') return <CloneMachine {...props} sources={sources} onDone={toRuntimes} onLeave={leave} />;
  if (flow === 'install-claude' || flow === 'install-codex')
    return (
      <InstallTool key={flow} {...props} harness={flow === 'install-claude' ? 'claude' : 'codex'} onLeave={leave} />
    );

  if (machine === null)
    return (
      <p role="status" className="m-0 text-cell text-muted" data-machine-settings-waiting="">
        {checking ? `Checking ${machineName}…` : `${machineName}’s settings show once it answers.`}
      </p>
    );

  return (
    <div className="flex min-w-0 flex-col gap-5" data-machine-settings="">
      <AgentPermissionsSection
        key={machine.agentPermissions}
        machine={machine}
        machineName={machineName}
        access={access}
        onSaved={onRetry}
      />

      <SetupSection title={`Tools on ${machineName}`} name="tools">
        {machine.tools.map(tool => (
          <SetupRow
            key={tool.harness}
            name={`tool-${tool.harness}`}
            status={tool.installed ? 'ready' : 'needs_sign_in'}
            statusLabel={tool.installed ? 'Installed' : 'Not installed'}
            title={tool.label}
            detail={tool.installed ? 'Installed' : 'Not installed'}
          >
            {tool.installed ? null : (
              <Button
                type="button"
                size="sm"
                data-tool-install={tool.harness}
                disabled={!online}
                onClick={() => route.open(tool.harness === 'claude' ? 'install-claude' : 'install-codex')}
              >
                Install
              </Button>
            )}
          </SetupRow>
        ))}
      </SetupSection>

      <SetupSection title="Setup" name="setup">
        {machine.setUp ? (
          <NavRow
            name="import"
            title="Import again"
            detail={`Read Claude Code and Codex on ${machineName} again and add anything new.`}
            onClick={() => route.open('import')}
          />
        ) : (
          <NavRow
            name="setup"
            title={`Set up ${machineName}`}
            detail="Check the tools, then bring in your Claude Code and Codex setup."
            onClick={() => route.open('setup')}
          />
        )}
        <NavRow
          name="clone"
          title="Clone from another machine"
          detail="Copy components, model sets, profiles and runtimes once. Logins and history stay behind."
          onClick={() => route.open('clone')}
        />
      </SetupSection>

      <SetupSection title="Machine" name="facts">
        <dl className="m-0 grid min-w-0 grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-cell">
          <dt className="text-muted">Name</dt>
          <dd className="m-0 min-w-0 break-all font-mono text-fg">{machine.name}</dd>
          <dt className="text-muted">Status</dt>
          <dd className="m-0 text-fg">{online ? 'Online' : 'Offline'}</dd>
          <dt className="text-muted">Runtimes</dt>
          <dd className="m-0 text-fg">{machine.setUp ? String(machine.runtimeCount) : 'Not set up yet'}</dd>
          <dt className="text-muted">Format</dt>
          <dd className="m-0 text-fg">{FORMAT_WORDS[machine.format]}</dd>
        </dl>
      </SetupSection>
    </div>
  );
}

/** The tab as the composition root mounts it: the other paired machines come from the app's store. */
export function MachineSettingsSurface(props: MachineTabProps) {
  const { connections } = useConnectionSnapshot();
  const sources = connections.filter(record => record.daemonId !== props.connection.daemonId);
  return <MachineSettingsTab {...props} sources={sources} />;
}
