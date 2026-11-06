/**
 * The Machine tab (docs/design/account-model.md §4.2, §3.6 F4–F5, §4.3, §4.7, E32), and the agent
 * settings the Agents tab draws (`agents-tab.tsx`).
 *
 * The Machine tab holds what is about the computer itself, in sections a person looks for:
 * - **Devices & access**, **Health**, **Tools** (the agent CLIs' panel) and **Advanced** — the paired daemon's
 *   own panels, one titled list each (`machine-panels.ts` says which panel is where).
 * - **Tools** — Claude Code and Codex, installed or not, with **Install**, then the agent tools panel: one
 *   section, the panel's row at the end of the same list.
 * - **Setup** — **Set up <machine>** while it is not set up, otherwise **Import again**; **Copy settings
 *   from another machine**; **Export settings**.
 * - **About** — this machine's name, whether it answers, how many runtimes it has and its format, then the
 *   version and updates panel's row.
 *
 * Every row on the tab starts with an icon, the same size and spacing, so the lists read as one.
 *
 * The agent settings — permissions, what agents may control, auto-resume, agenda mode and conversations —
 * are written here and drawn by the Agents tab. Two choices become an inline segmented pick; on/off
 * settings are one-line switches. Each saves through the same preview-and-apply panel as before.
 *
 * The shared browser (mode, proxy, "Test proxy") is the Browser tab's, not this one's (`browser-tab.tsx`).
 *
 * Each flow is a linkable address under this tab (`settings-route.ts`), so the Runtimes tab's
 * "Set up <machine>" link lands straight in the first run.
 */

import type { FleetAgentControl, FleetMachineView } from '@ferretry/protocol';
import { ChevronRight, Code, Copy, FolderInput, Rocket, Sparkles, Upload } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { cn } from '../../../lib/class-names.ts';
import type { DaemonConnectionRecord } from '../../../lib/connections.ts';
import { useConfigChangeCounter, useConnectionSnapshot } from '../../../lib/store.tsx';
import { Button } from '../../../shell/primitives.tsx';
import { readConfigFile, writeConfigFile } from '../../config-files/config-files-api.ts';
import { Segmented } from '../conversations/conversation-picker.tsx';
import { CloneMachine } from '../setup/clone.tsx';
import { ExportSettings } from '../setup/export-settings.tsx';
import { InstallTool } from '../setup/install-flow.tsx';
import { type SettingsFlow, useSettingsFlow } from '../setup/settings-route.ts';
import type { SetupAccess } from '../setup/setup-access.ts';
import { SetupNote, SetupSection } from '../setup/setup-ui.tsx';
import { countWords } from '../setup/setup-words.ts';
import { ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import { type PanelGroupId, panelGroup } from '../shell/machine-panels.ts';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
import { KEEP_IN_SYNC_EXPLANATION, MACHINE_FILE, readKeepInSync, withKeepInSync } from './conversations-setting.ts';
import { machineSettings } from './machine-settings.ts';
import { SwitchList, SwitchRow } from './switch-row.tsx';

type AgentPermissions = FleetMachineView['agentPermissions'];
type AgentControlKind = keyof FleetAgentControl;

const AGENT_PERMISSION_WORDS: Readonly<Record<AgentPermissions, string>> = {
  auto: 'Auto mode',
  skip: 'Skip all permission checks',
};

/** "What agents may control" (T): each switch's label and what it covers — the fourth, Ferretry settings,
 *  is the `config.*` tools (docs/config-files.md); the fifth, Page scripts, is `browser.eval`. */
const AGENT_CONTROL_WORDS: Readonly<
  Record<AgentControlKind, { readonly title: string; readonly hint?: string; readonly detail: string }>
> = {
  terminals: { title: 'Terminals', detail: 'Open, read and type into session terminals.' },
  browsers: { title: 'Browsers', detail: 'Open, navigate and read the session browser.' },
  files: { title: 'Files', detail: "Read and change files in the session's project." },
  ferretrySettings: {
    title: 'Ferretry settings',
    hint: 'Lets agents use config tools',
    detail:
      "Read and edit this machine's configuration files (the config tools). Off by default; an agent's edit that loosens anything still waits for you.",
  },
  pageScripts: {
    title: 'Page scripts',
    hint: 'Can read site sign-ins',
    detail:
      'Let agents run their own JavaScript in pages they drive. A script can read what a page holds — on the shared agent profile, that includes your sign-ins to every site you signed it in to. Off by default; turn it on only if you need it.',
  },
};

export { machineSettings } from './machine-settings.ts';

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

/** The icon slot every row on the tab starts with: the panel frame's own size and width, so the lists line up. */
function RowIcon({ children }: { readonly children: ReactNode }) {
  return (
    <span className="flex w-5 shrink-0 justify-center text-muted" data-row-icon="" aria-hidden="true">
      {children}
    </span>
  );
}

const TOOL_ICONS: Readonly<Record<FleetMachineView['tools'][number]['harness'], ReactNode>> = {
  claude: <Sparkles size={16} aria-hidden="true" />,
  codex: <Code size={16} aria-hidden="true" />,
};

/** One compact row in a list of ways in: its name, a chevron, and the longer explanation on hover. */
function NavRow({
  icon,
  title,
  detail,
  onClick,
  name,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly detail: string;
  readonly onClick: () => void;
  readonly name: string;
}) {
  return (
    <li>
      <button
        type="button"
        data-settings-action={name}
        title={detail}
        onClick={onClick}
        className="kt-grouprow items-center"
      >
        <RowIcon>{icon}</RowIcon>
        <span className="min-w-0 flex-1 truncate text-ui font-semibold text-fg">{title}</span>
        <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-muted" />
      </button>
    </li>
  );
}

/** The words on each segment of the permissions pick; the full name is its tooltip. */
const AGENT_PERMISSION_SEGMENTS: Readonly<Record<AgentPermissions, string>> = {
  auto: 'Auto mode',
  skip: 'Skip all checks',
};

export function AgentPermissionsSection({
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
    void changes.apply(machineSettings(machine, { agentPermissions: draft })).then(result => {
      if (result.kind === 'refused') return;
      setChangedFrom(current);
      onSaved();
    });
  };
  return (
    <SetupSection title="Agent permissions" name="agent-permissions">
      <Segmented
        label="Agent permissions"
        name="agent-permissions"
        value={draft}
        onChoose={value => {
          setDraft(value);
          changes.clear();
        }}
        options={(['auto', 'skip'] as const).map(id => ({
          id,
          label: AGENT_PERMISSION_SEGMENTS[id],
          title: AGENT_PERMISSION_WORDS[id],
        }))}
      />
      <p className="m-0 text-cell leading-base text-muted" data-agent-permissions-detail="">
        {draft === 'auto'
          ? 'Agents work on their own and stop to ask before anything that looks risky.'
          : `Agents never stop to ask. They can change any file and run any command on ${machineName}.`}
      </p>
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

const AGENT_CONTROL_KINDS: readonly AgentControlKind[] = [
  'terminals',
  'browsers',
  'files',
  'ferretrySettings',
  'pageScripts',
];

export function AgentControlSection({
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
  const current = machine.agentControl;
  const [draft, setDraft] = useState<FleetAgentControl>(current);
  const pending = AGENT_CONTROL_KINDS.some(kind => draft[kind] !== current[kind]);
  const save = (): void => {
    void changes.apply(machineSettings(machine, { agentControl: draft })).then(result => {
      if (result.kind === 'refused') return;
      onSaved();
    });
  };
  return (
    <SetupSection title="What agents may control" name="agent-control">
      <ul className="kt-groupcard m-0 list-none p-0" aria-label="What agents may control" data-agent-control="">
        {AGENT_CONTROL_KINDS.map(kind => (
          <SwitchRow
            key={kind}
            checked={draft[kind]}
            label={AGENT_CONTROL_WORDS[kind].title}
            {...(AGENT_CONTROL_WORDS[kind].hint === undefined ? {} : { hint: AGENT_CONTROL_WORDS[kind].hint })}
            explanation={AGENT_CONTROL_WORDS[kind].detail}
            onChange={on => {
              setDraft({ ...draft, [kind]: on });
              changes.clear();
            }}
          />
        ))}
      </ul>
      <p className="m-0 text-meta leading-base text-muted" data-agent-control-hint="">
        Applies to an agent’s next action on {machineName}; nothing already running is interrupted.
      </p>
      {pending ? (
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={changes.busy}
          refusal={changes.refusal}
          submitLabel="Save what agents may control"
          onSubmit={save}
        >
          <Button type="button" data-agent-control-undo="" onClick={() => setDraft(current)}>
            Undo
          </Button>
        </ChangeApplyPanel>
      ) : null}
    </SetupSection>
  );
}

type KeepInSyncSave = 'applied' | 'broken' | 'held';

/** Settings › Machine › Conversations: whether Continue lists this computer's own CLI conversations. */
export function ConversationsSection({
  daemonId,
  access,
}: {
  readonly daemonId: DaemonConnectionRecord['daemonId'];
  readonly access: SetupAccess;
}) {
  const { read, act } = access;
  const [on, setOn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ readonly tone: 'warn' | 'err'; readonly text: string } | null>(null);
  const moved = useConfigChangeCounter(daemonId, ['machine']);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `moved` is the re-read trigger
  useEffect(() => {
    let live = true;
    void read(client => readConfigFile(client, MACHINE_FILE)).then(result => {
      const kept = result.kind === 'done' ? readKeepInSync(result.value.text) : null;
      if (live && kept !== null) setOn(kept);
    });
    return () => {
      live = false;
    };
  }, [read, moved]);

  const toggle = (): void => {
    const next = !on;
    setBusy(true);
    setNote(null);
    void act<KeepInSyncSave>(async client => {
      const file = await readConfigFile(client, MACHINE_FILE);
      const edited = withKeepInSync(file.text, next);
      if (edited === null) return 'broken';
      const written = await writeConfigFile(client, MACHINE_FILE, edited, file.etag);
      return written.outcome === 'pending' ? 'held' : 'applied';
    }).then(result => {
      setBusy(false);
      if (result.kind === 'refused') return setNote({ tone: 'err', text: result.sentence });
      if (result.value === 'broken') {
        return setNote({ tone: 'err', text: 'machine.yaml has a problem; fix it in the Files panel first.' });
      }
      setOn(next);
      if (result.value === 'held') setNote({ tone: 'warn', text: 'Saved, but not in effect until you confirm it.' });
    });
  };

  return (
    <SetupSection title="Conversations" name="conversations">
      <SwitchList label="Conversations">
        <SwitchRow
          checked={on}
          label="Keep in sync"
          explanation={KEEP_IN_SYNC_EXPLANATION}
          disabled={busy}
          onChange={toggle}
        />
      </SwitchList>
      {note === null ? null : (
        <p
          role="status"
          className={cn('m-0 text-meta leading-base', note.tone === 'err' ? 'text-err' : 'text-warn')}
          data-keep-in-sync-note=""
        >
          {note.text}
        </p>
      )}
    </SetupSection>
  );
}

/** "Auto-resume after restart": each choice's words. */
const AUTO_RESUME_WORDS: Readonly<Record<'on' | 'off', { readonly title: string; readonly detail: string }>> = {
  on: {
    title: 'On',
    detail:
      'When this machine restarts, ferrets that were running pick up where they left off, with their conversation intact. Ones you stopped stay stopped.',
  },
  off: {
    title: 'Off',
    detail: 'Nothing restarts by itself. Resume each ferret yourself when you want it back.',
  },
};

/** The summary of the last pass, as the sentence the row leads with. */
const autoResumeSentence = (resumed: number): string =>
  `Resumed ${resumed} ${resumed === 1 ? 'ferret' : 'ferrets'} after restart`;

export function AutoResumeSection({
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
  const current = machine.autoResume === false ? 'off' : 'on';
  const [draft, setDraft] = useState<'on' | 'off'>(current);
  const pending = draft !== current;
  const last = machine.lastAutoResume ?? null;
  const save = (): void => {
    void changes.apply(machineSettings(machine, { autoResume: draft === 'on' })).then(result => {
      if (result.kind === 'refused') return;
      onSaved();
    });
  };
  // A daemon that predates the setting does not resume anything and cannot be asked to.
  if (machine.autoResume === undefined) return null;
  return (
    <SetupSection title="Auto-resume after restart" name="auto-resume">
      <SwitchList label="Auto-resume after restart">
        <SwitchRow
          checked={draft === 'on'}
          label="Resume ferrets after a restart"
          explanation={AUTO_RESUME_WORDS[draft].detail}
          onChange={on => {
            setDraft(on ? 'on' : 'off');
            changes.clear();
          }}
        />
      </SwitchList>
      {last === null ? null : (
        <div className="flex min-w-0 flex-col gap-1" data-auto-resume-summary="">
          <p className="m-0 text-ui font-semibold text-fg">{autoResumeSentence(last.resumed)}</p>
          {last.skipped.map(item => (
            <p key={item.sessionId} className="m-0 text-meta leading-base text-warn" data-auto-resume-skipped="">
              Couldn’t auto-resume {item.sessionId}: {item.reason}
            </p>
          ))}
        </div>
      )}
      {pending ? (
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={changes.busy}
          refusal={changes.refusal}
          submitLabel="Save auto-resume"
          onSubmit={save}
        >
          <Button type="button" data-auto-resume-undo="" onClick={() => setDraft(current)}>
            Keep {AUTO_RESUME_WORDS[current].title}
          </Button>
        </ChangeApplyPanel>
      ) : null}
    </SetupSection>
  );
}

/** "Agenda mode" for new ferrets: each choice's words. */
const AGENDA_MODE_WORDS: Readonly<Record<'on' | 'off', { readonly title: string; readonly detail: string }>> = {
  on: {
    title: 'On',
    detail:
      'New ferrets keep an agenda: what only you can decide or do becomes an item you answer from the Inbox. A ferret you already have keeps its own switch.',
  },
  off: {
    title: 'Off',
    detail:
      'New ferrets send plain notices only. Turn Agenda mode on for one ferret from its Actions menu; a ferret you already have keeps its own switch.',
  },
};

export function AgendaModeSection({
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
  const current = machine.agendaMode === false ? 'off' : 'on';
  const [draft, setDraft] = useState<'on' | 'off'>(current);
  const pending = draft !== current;
  const save = (): void => {
    void changes.apply(machineSettings(machine, { agendaMode: draft === 'on' })).then(result => {
      if (result.kind === 'refused') return;
      onSaved();
    });
  };
  // A daemon that predates the default starts every ferret off and cannot be asked to do otherwise.
  if (machine.agendaMode === undefined) return null;
  return (
    <SetupSection title="Agenda mode" name="agenda-mode">
      <SwitchList label="Agenda mode">
        <SwitchRow
          checked={draft === 'on'}
          label="Agenda mode for new ferrets"
          explanation={AGENDA_MODE_WORDS[draft].detail}
          onChange={on => {
            setDraft(on ? 'on' : 'off');
            changes.clear();
          }}
        />
      </SwitchList>
      {pending ? (
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={changes.busy}
          refusal={changes.refusal}
          submitLabel="Save agenda mode"
          onSubmit={save}
        >
          <Button type="button" data-agenda-mode-undo="" onClick={() => setDraft(current)}>
            Keep {AGENDA_MODE_WORDS[current].title}
          </Button>
        </ChangeApplyPanel>
      ) : null}
    </SetupSection>
  );
}

/** Sections side by side from the desktop width, one column on a phone. */
const MACHINE_COLUMNS = 'grid min-w-0 grid-cols-1 items-start gap-x-6 gap-y-5 lg:grid-cols-2';

/** The tool rows: Claude Code and Codex, whether each is installed, and Install for one that is missing. */
function toolRows(machine: FleetMachineView, online: boolean, open: (flow: SettingsFlow) => void): ReactNode {
  return machine.tools.map(tool => (
    <li key={tool.harness} data-setup-row={`tool-${tool.harness}`}>
      <div className="kt-grouprow items-center">
        <RowIcon>{TOOL_ICONS[tool.harness]}</RowIcon>
        <span className="min-w-0 flex-1 truncate text-ui font-semibold text-fg">{tool.label}</span>
        <span className="shrink-0 text-meta text-muted">{tool.installed ? 'Installed' : 'Not installed'}</span>
        {tool.installed ? null : (
          <Button
            type="button"
            size="sm"
            data-tool-install={tool.harness}
            disabled={!online}
            onClick={() => open(tool.harness === 'claude' ? 'install-claude' : 'install-codex')}
          >
            Install
          </Button>
        )}
      </div>
    </li>
  ));
}

/** This machine's name, whether it answers, how many runtimes it has and its format: the head of About's list. */
function factsRow(machine: FleetMachineView, online: boolean): ReactNode {
  return (
    <li data-about-facts="">
      <dl className="m-0 grid min-w-0 grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-panel py-3 text-cell">
        <dt className="text-muted">Name</dt>
        <dd className="m-0 min-w-0 break-all font-mono text-fg">{machine.name}</dd>
        <dt className="text-muted">Status</dt>
        <dd className="m-0 text-fg">{online ? 'Online' : 'Offline'}</dd>
        <dt className="text-muted">Runtimes</dt>
        <dd className="m-0 text-fg">{machine.setUp ? String(machine.runtimeCount) : 'Not set up yet'}</dd>
        <dt className="text-muted">Format</dt>
        <dd className="m-0 text-fg">{FORMAT_WORDS[machine.format]}</dd>
      </dl>
    </li>
  );
}

export function MachineSettingsTab(props: MachineSettingsTabProps) {
  const { machine, machineName, online, checking, connection, createClient, sources, browser } = props;
  const route = useSettingsFlow(machineName, browser);
  const leave = (): void => route.open(null);
  const toRuntimes = (): void => route.goTo('runtimes');
  const flow: SettingsFlow | null = route.flow;
  const { daemonPanels } = props;
  const group = (id: PanelGroupId, lead?: ReactNode): ReactNode => daemonPanels?.(undefined, route.openPanel, id, lead);

  // Tools and About are the panel frame's groups with this tab's rows at their head; with no frame (a test, a
  // harness) the tab draws the same one section itself, so the facts and the tools are never missing.
  const inGroup = (id: PanelGroupId, lead: ReactNode): ReactNode =>
    daemonPanels === undefined ? (
      <section className="flex min-w-0 flex-col gap-2" data-setup-section={id}>
        <h4 className="m-0 text-meta font-semibold uppercase text-muted">{panelGroup(id).label}</h4>
        <ul
          className="kt-groupcard m-0 list-none p-0"
          aria-label={`${machineName} ${panelGroup(id).label.toLowerCase()}`}
        >
          {lead}
        </ul>
      </section>
    ) : (
      group(id, lead)
    );

  // New machine setup is a full screen of its own; an old in-tab address points there.
  if (flow === 'setup' || flow === 'import')
    return (
      <SetupNote name="setup-moved" title="Setup is a full screen now">
        <span>
          {flow === 'import' ? 'Import again is' : 'New machine setup is'} the Claude Code and Codex steps of{' '}
          {machineName}’s setup.
        </span>
        <div className="mt-2 flex flex-wrap gap-2">
          {props.onSetUp === undefined ? null : (
            <Button
              type="button"
              variant="primary"
              data-setup-moved-open=""
              onClick={() => props.onSetUp?.(flow === 'import' ? 'claude' : undefined)}
            >
              Open {machineName}’s setup
            </Button>
          )}
          <Button type="button" data-setup-moved-back="" onClick={leave}>
            Back
          </Button>
        </div>
      </SetupNote>
    );
  if (flow === 'clone') return <CloneMachine {...props} sources={sources} onDone={toRuntimes} onLeave={leave} />;
  if (flow === 'export')
    return (
      <ExportSettings connection={connection} machineName={machineName} createClient={createClient} onLeave={leave} />
    );
  if (flow === 'install-claude' || flow === 'install-codex')
    return (
      <InstallTool key={flow} {...props} harness={flow === 'install-claude' ? 'claude' : 'codex'} onLeave={leave} />
    );
  // A daemon panel is a page of its own, so a link to one shows it even while the machine is not answering:
  // Host checks and removing a pairing matter most exactly then.
  if (route.panel !== null && daemonPanels !== undefined) return daemonPanels(route.panel, route.openPanel);

  if (machine === null)
    return (
      <div className="flex min-w-0 flex-col gap-5">
        <p role="status" className="m-0 text-cell text-muted" data-machine-settings-waiting="">
          {checking ? `Checking ${machineName}…` : `${machineName}’s settings show once it answers.`}
        </p>
        <div className={MACHINE_COLUMNS}>
          {group('devices-access')}
          {group('health')}
        </div>
      </div>
    );

  return (
    <div className={cn(MACHINE_COLUMNS, 'gap-y-5')} data-machine-settings="">
      {group('devices-access')}
      {group('health')}

      {/* One Tools list: Claude Code and Codex first, then the agent tools panel's own row. */}
      {inGroup('tools', toolRows(machine, online, route.open))}

      <section className="flex min-w-0 flex-col gap-2" data-setup-section="setup">
        <h4 className="m-0 text-meta font-semibold uppercase text-muted">Setup</h4>
        <ul className="kt-groupcard m-0 list-none p-0" aria-label={`Set up ${machineName}`}>
          {/* New machine setup is revisitable: every step skipped the first time is one tap away here. */}
          <NavRow
            name="setup"
            icon={<Rocket size={16} aria-hidden="true" />}
            title={machine.setUp ? 'New machine setup' : `Set up ${machineName}`}
            detail={
              machine.setUp
                ? 'Walk through Claude Code, Codex, speed-ups, voice, the Warden, learning and agent controls again.'
                : 'Pair, start fresh or copy another machine, then Claude Code, Codex, speed-ups and the Warden.'
            }
            // The setup is a full screen of its own: one rail, every step on it.
            onClick={() => (props.onSetUp === undefined ? route.open('setup') : props.onSetUp())}
          />
          {machine.setUp ? (
            <NavRow
              name="import"
              icon={<FolderInput size={16} aria-hidden="true" />}
              title="Import again"
              detail={`Read Claude Code and Codex on ${machineName} again and add anything new.`}
              onClick={() => (props.onSetUp === undefined ? route.open('import') : props.onSetUp('claude'))}
            />
          ) : null}
          <NavRow
            name="clone"
            icon={<Copy size={16} aria-hidden="true" />}
            title="Copy settings from another machine…"
            detail="Warden, learning, voice, agent controls, profiles and runtimes, copied once. Secrets come only when you pick them; logins never travel."
            onClick={() => route.open('clone')}
          />
          <NavRow
            name="export"
            icon={<Upload size={16} aria-hidden="true" />}
            title="Export settings"
            detail="A zip of this machine’s configuration files, without secrets."
            onClick={() => route.open('export')}
          />
        </ul>
      </section>

      {group('advanced')}

      {inGroup('about', factsRow(machine, online))}
    </div>
  );
}

/** The tab as the composition root mounts it: the other paired machines come from the app's store. */
export function MachineSettingsSurface(props: MachineTabProps) {
  const { connections } = useConnectionSnapshot();
  const sources = connections.filter(record => record.daemonId !== props.connection.daemonId);
  return <MachineSettingsTab {...props} sources={sources} />;
}
