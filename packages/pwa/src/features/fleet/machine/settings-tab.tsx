/**
 * The Machine tab (docs/design/account-model.md §4.2, §3.6 F4–F5, §4.3, §4.7, E32): what this
 * machine does for every runtime on it.
 *
 * - **Agent permissions** — Auto mode or Skip all permission checks, each with a plain sentence. It
 *   applies to new sessions; with sessions running, the tab says how many keep the old mode (E32).
 * - **Auto-resume after restart** — On (the default) or Off, and what the last restart resumed.
 * - **Agenda mode** — On (the default) or Off for ferrets started from now on (docs/agenda.md).
 * - **Tools on <machine>** — Claude Code and Codex, installed or not, with **Install**.
 * - **Setup** — **Set up <machine>** while it is not set up, otherwise **Import again**; **Clone from
 *   another machine**.
 * - **Connection and security** — the paired daemon's own panels (Warden, Secrets, devices, security…),
 *   which used to be a separate Daemons section; one place per machine now.
 * - **About this machine** — its name, whether it answers, how many runtimes it has, and its format.
 *
 * The shared browser (mode, proxy, "Test proxy") is the Browser tab's, not this one's (`browser-tab.tsx`).
 *
 * Each flow is a linkable address under this tab (`settings-route.ts`), so the Runtimes tab's
 * "Set up <machine>" link lands straight in the first run.
 */

import type { FleetAgentControl, FleetMachineView } from '@ferretry/protocol';
import { ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '../../../lib/class-names.ts';
import type { DaemonConnectionRecord } from '../../../lib/connections.ts';
import { useConfigChangeCounter, useConnectionSnapshot } from '../../../lib/store.tsx';
import { Button } from '../../../shell/primitives.tsx';
import { readConfigFile, writeConfigFile } from '../../config-files/config-files-api.ts';
import { readFleetRuntimes } from '../catalog-api.ts';
import { CloneMachine } from '../setup/clone.tsx';
import { ExportSettings } from '../setup/export-settings.tsx';
import { InstallTool } from '../setup/install-flow.tsx';
import { type SettingsFlow, useSettingsFlow } from '../setup/settings-route.ts';
import { type SetupAccess, useSetupAccess } from '../setup/setup-access.ts';
import { CheckChoices, RadioChoices, SetupNote, SetupRow, SetupSection } from '../setup/setup-ui.tsx';
import { countWords } from '../setup/setup-words.ts';
import { ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
import { machineSettings } from './machine-settings.ts';
import { KEEP_IN_SYNC_EXPLANATION, MACHINE_FILE, readKeepInSync, withKeepInSync } from './conversations-setting.ts';

type AgentPermissions = FleetMachineView['agentPermissions'];
type AgentControlKind = keyof FleetAgentControl;

export const AGENT_PERMISSION_WORDS: Readonly<Record<AgentPermissions, string>> = {
  auto: 'Auto mode',
  skip: 'Skip all permission checks',
};

/** "What agents may control" (T): each switch's label and what it covers — the fourth, Ferretry settings,
 *  is the `config.*` tools (docs/config-files.md); the fifth, Page scripts, is `browser.eval`. */
export const AGENT_CONTROL_WORDS: Readonly<
  Record<AgentControlKind, { readonly title: string; readonly detail: string }>
> = {
  terminals: { title: 'Terminals', detail: 'Open, read and type into session terminals.' },
  browsers: { title: 'Browsers', detail: 'Open, navigate and read the session browser.' },
  files: { title: 'Files', detail: "Read and change files in the session's project." },
  ferretrySettings: {
    title: 'Ferretry settings',
    detail:
      "Read and edit this machine's configuration files (the config tools). Off by default; an agent's edit that loosens anything still waits for you.",
  },
  pageScripts: {
    title: 'Page scripts',
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

/** "Default runtime for new agents" (T): every agent runtime on this machine, read once for the
 *  picker. `null` while loading or on a read that failed — the section just stays hidden then,
 *  same as a machine with no agent runtime yet, because there is nothing useful to pick from. */
function useAgentRuntimeNames(machine: FleetMachineView, access: SetupAccess): readonly string[] | null {
  const [names, setNames] = useState<readonly string[] | null>(null);
  const { read } = access;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when the machine's own facts change, not on every render
  useEffect(() => {
    setNames(null);
    void read(client => readFleetRuntimes(client)).then(result => {
      if (result.kind !== 'done') return;
      setNames(result.value.runtimes.filter(runtime => runtime.agent).map(runtime => runtime.name));
    });
  }, [machine.name, machine.runtimeCount, read]);
  return names;
}

export function DefaultRuntimeSection({
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
  const runtimes = useAgentRuntimeNames(machine, access);
  const current = machine.defaultRuntime;
  const [draft, setDraft] = useState<string | null>(current);
  const pending = draft !== current && draft !== null;
  const save = (): void => {
    void changes.apply(machineSettings(machine, { defaultRuntime: draft })).then(result => {
      if (result.kind === 'refused') return;
      onSaved();
    });
  };
  if (runtimes === null) return null;
  if (runtimes.length === 0) {
    return (
      <SetupSection title="Default runtime for new agents" name="default-runtime">
        <p className="m-0 text-cell text-muted" data-default-runtime-empty="">
          {machineName} has no agent runtime yet. Add one on the Runtimes tab, then come back here to pick it.
        </p>
      </SetupSection>
    );
  }
  return (
    <SetupSection title="Default runtime for new agents" name="default-runtime">
      <RadioChoices
        legend="Default runtime for new agents"
        legendHidden
        name="default-runtime"
        value={draft}
        onChoose={value => {
          setDraft(value);
          changes.clear();
        }}
        options={runtimes.map(name => ({ id: name, title: name }))}
      />
      <p className="m-0 text-meta leading-base text-muted" data-default-runtime-hint="">
        A session started with no runtime named uses this one.
      </p>
      {pending ? (
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={changes.busy}
          refusal={changes.refusal}
          submitLabel="Save default runtime"
          onSubmit={save}
        >
          <Button type="button" data-default-runtime-undo="" onClick={() => setDraft(current)}>
            Keep {current ?? 'automatic'}
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
      <CheckChoices
        legend="What agents may control"
        legendHidden
        name="agent-control"
        values={AGENT_CONTROL_KINDS.filter(kind => draft[kind])}
        onToggle={(kind, on) => {
          setDraft({ ...draft, [kind]: on });
          changes.clear();
        }}
        options={AGENT_CONTROL_KINDS.map(kind => ({ id: kind, ...AGENT_CONTROL_WORDS[kind] }))}
      />
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
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={busy}
        data-keep-in-sync=""
        onClick={toggle}
        className={cn(
          'flex min-h-[44px] items-center justify-between gap-3 rounded-control border px-control-x py-2 text-left transition-colors',
          on ? 'border-accent bg-accent-soft text-accent' : 'border-border-strong bg-surface-2 text-fg',
        )}
      >
        <span className="text-ui font-semibold">Keep in sync</span>
        <span className="text-meta">{on ? 'On' : 'Off'}</span>
      </button>
      <p className="m-0 text-meta leading-base text-muted" data-keep-in-sync-hint="">
        {KEEP_IN_SYNC_EXPLANATION}
      </p>
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
export const AUTO_RESUME_WORDS: Readonly<Record<'on' | 'off', { readonly title: string; readonly detail: string }>> = {
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
export const autoResumeSentence = (resumed: number): string =>
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
      <RadioChoices
        legend="Auto-resume after restart"
        legendHidden
        name="auto-resume"
        value={draft}
        onChoose={value => {
          setDraft(value);
          changes.clear();
        }}
        options={(['on', 'off'] as const).map(choice => ({ id: choice, ...AUTO_RESUME_WORDS[choice] }))}
      />
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
export const AGENDA_MODE_WORDS: Readonly<Record<'on' | 'off', { readonly title: string; readonly detail: string }>> = {
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
      <RadioChoices
        legend="Agenda mode for new ferrets"
        legendHidden
        name="agenda-mode"
        value={draft}
        onChoose={value => {
          setDraft(value);
          changes.clear();
        }}
        options={(['on', 'off'] as const).map(choice => ({ id: choice, ...AGENDA_MODE_WORDS[choice] }))}
      />
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

export function MachineSettingsTab(props: MachineSettingsTabProps) {
  const { machine, machineName, online, checking, connection, createClient, onRetry, sources, browser } = props;
  // After a save here the machine is read again QUIETLY: a loud re-check swapped every section for
  // "Checking…" and back, which unmounted what the person was editing and moved the page under them.
  const onSaved = props.onRefresh ?? onRetry;
  const route = useSettingsFlow(machineName, browser);
  const access = useSetupAccess({ connection, createClient });
  const leave = (): void => route.open(null);
  const toRuntimes = (): void => route.goTo('runtimes');
  const flow: SettingsFlow | null = route.flow;
  const { daemonPanels } = props;
  const panels = daemonPanels === undefined ? null : daemonPanels(undefined, route.openPanel);

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
        {panels}
      </div>
    );

  return (
    <div className="flex min-w-0 flex-col gap-5" data-machine-settings="">
      <DefaultRuntimeSection
        key={machine.defaultRuntime}
        machine={machine}
        machineName={machineName}
        access={access}
        onSaved={onSaved}
      />

      <AgentPermissionsSection
        key={machine.agentPermissions}
        machine={machine}
        machineName={machineName}
        access={access}
        onSaved={onSaved}
      />

      <AgentControlSection
        key={AGENT_CONTROL_KINDS.map(kind => machine.agentControl[kind]).join(',')}
        machine={machine}
        machineName={machineName}
        access={access}
        onSaved={onSaved}
      />

      <AutoResumeSection
        key={String(machine.autoResume)}
        machine={machine}
        machineName={machineName}
        access={access}
        onSaved={onSaved}
      />
      <AgendaModeSection
        key={`agenda-${String(machine.agendaMode)}`}
        machine={machine}
        machineName={machineName}
        access={access}
        onSaved={onSaved}
      />
      <ConversationsSection daemonId={connection.daemonId} access={access} />

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
        {/* New machine setup is revisitable: every step skipped the first time is one tap away here. */}
        <NavRow
          name="setup"
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
            title="Import again"
            detail={`Read Claude Code and Codex on ${machineName} again and add anything new.`}
            onClick={() => (props.onSetUp === undefined ? route.open('import') : props.onSetUp('claude'))}
          />
        ) : null}
        <NavRow
          name="clone"
          title="Copy settings from another machine…"
          detail="Warden, learning, voice, agent controls, profiles and runtimes, copied once. Secrets come only when you pick them; logins never travel."
          onClick={() => route.open('clone')}
        />
        <NavRow
          name="export"
          title="Export settings"
          detail="A zip of this machine’s configuration files, without secrets."
          onClick={() => route.open('export')}
        />
      </SetupSection>

      {panels}

      <SetupSection title="About this machine" name="facts">
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
