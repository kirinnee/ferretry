/**
 * The Agents tab (today's v4 Agents tab): how agents behave on this machine, in the order a person reaches for it —
 * what they may do (permissions, what they may control), then how they come back (auto-resume, agenda mode,
 * conversations). The Warden, learning and pack settings are their own plugins' tabs here.
 *
 * Every setting but "Keep in sync" is one `machine.settings` change (`machine-settings.ts`: the wire carries them all
 * together, so a section that edits one never clobbers the rest), applied through the same preview-and-apply panel as
 * every Machines change. Whether a caller may save, and whether a loosening waits for the owner, is the daemon's answer
 * (`machine.authority`, `changes.authority`): this screen asks, it does not decide. "Keep in sync" is
 * `conversation.yaml`, written through the kernel's config file routes.
 */

import { Segmented, SettingRow, SettingSwitch } from '@ferretry/app';
import { useCallback, useEffect, useState } from 'react';
import type { AgentControl, MachineView } from '../../../../contract/index.ts';
import { useConfigFileChanges } from '../../../hooks/use-config-file-changes.ts';
import type { LiveRuntimesClient } from '../../../lib/client.ts';
import { CONVERSATION_FILE, readKeepInSyncDocument, saveKeepInSync } from '../../../lib/conversation-file.ts';
import { reasonOf } from '../../../lib/config-files.ts';
import { Button, cn } from '../../../ui.ts';
import { type AccountChanges, ChangeApplyPanel, useAccountChanges } from '../shell/apply-change-panel.tsx';
import type { MachineTabProps } from '../shell/machine-tab.ts';
import {
  AGENDA_MODE_WORDS,
  AGENT_CONTROL_KINDS,
  AGENT_CONTROL_WORDS,
  AGENT_PERMISSION_SEGMENTS,
  AGENT_PERMISSION_WORDS,
  type AgentPermissions,
  agentPermissionDetail,
  AUTO_RESUME_WORDS,
  autoResumeSentence,
  HELD_CHANGE_SENTENCE,
  KEEP_IN_SYNC_EXPLANATION,
  runningSessionsSentence,
} from './agents-words.ts';
import { machineSettings } from './machine-settings.ts';

function Section({
  title,
  name,
  children,
}: {
  readonly title: string;
  readonly name: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2" data-setup-section={name}>
      <h4 className="m-0 text-meta font-semibold uppercase text-muted">{title}</h4>
      {children}
    </section>
  );
}

interface SectionProps {
  readonly machine: MachineView;
  readonly machineName: string;
  readonly changes: AccountChanges;
  readonly onSaved: () => void;
}

/** One on/off row in the compact kit: the title and a switch on one line, the long explanation behind the (i). */
function SwitchRow({
  checked,
  onChange,
  label,
  hint,
  explanation,
  disabled = false,
}: {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly label: string;
  readonly hint?: string;
  readonly explanation: string;
  readonly disabled?: boolean;
}) {
  return (
    <SettingRow
      name={label}
      {...(hint === undefined ? {} : { hint })}
      explanation={explanation}
      control={labelId => (
        <SettingSwitch checked={checked} onChange={onChange} labelledBy={labelId} disabled={disabled} />
      )}
    />
  );
}

function SwitchList({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <ul className="kt-groupcard m-0 list-none p-0" aria-label={label}>
      {children}
    </ul>
  );
}

function AgentPermissionsSection({ machine, machineName, changes, onSaved }: SectionProps) {
  const current = machine.agentPermissions;
  const [draft, setDraft] = useState<AgentPermissions>(current);
  const [changedFrom, setChangedFrom] = useState<AgentPermissions | null>(null);
  const pending = draft !== current;
  const old = pending ? current : changedFrom;
  const save = (): void => {
    void changes.apply(machineSettings(machine, { agentPermissions: draft })).then(result => {
      if (result.kind !== 'applied') return;
      setChangedFrom(current);
      onSaved();
    });
  };
  return (
    <Section title="Agent permissions" name="agent-permissions">
      <Segmented
        label="Agent permissions"
        value={draft}
        onChange={value => {
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
        {agentPermissionDetail(draft, machineName)}
      </p>
      {old !== null && old !== draft && machine.runningSessions > 0 ? (
        <p className="m-0 text-cell leading-base text-warn" data-agent-permissions-running="">
          Applies to new sessions. {runningSessionsSentence(machine.runningSessions, old)}
        </p>
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
    </Section>
  );
}

function AgentControlSection({ machine, machineName, changes, onSaved }: SectionProps) {
  const current = machine.agentControl;
  const [draft, setDraft] = useState<AgentControl>(current);
  const pending = AGENT_CONTROL_KINDS.some(kind => draft[kind] !== current[kind]);
  const save = (): void => {
    void changes.apply(machineSettings(machine, { agentControl: draft })).then(result => {
      if (result.kind !== 'applied') return;
      onSaved();
    });
  };
  return (
    <Section title="What agents may control" name="agent-control">
      <SwitchList label="What agents may control">
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
      </SwitchList>
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
    </Section>
  );
}

function AutoResumeSection({ machine, machineName, changes, onSaved }: SectionProps) {
  const current = machine.autoResume ? 'on' : 'off';
  const [draft, setDraft] = useState<'on' | 'off'>(current);
  const pending = draft !== current;
  const last = machine.lastAutoResume;
  const save = (): void => {
    void changes.apply(machineSettings(machine, { autoResume: draft === 'on' })).then(result => {
      if (result.kind !== 'applied') return;
      onSaved();
    });
  };
  return (
    <Section title="Auto-resume after restart" name="auto-resume">
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
    </Section>
  );
}

function AgendaModeSection({ machine, machineName, changes, onSaved }: SectionProps) {
  const current = machine.agendaMode ? 'on' : 'off';
  const [draft, setDraft] = useState<'on' | 'off'>(current);
  const pending = draft !== current;
  const save = (): void => {
    void changes.apply(machineSettings(machine, { agendaMode: draft === 'on' })).then(result => {
      if (result.kind !== 'applied') return;
      onSaved();
    });
  };
  return (
    <Section title="Agenda mode" name="agenda-mode">
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
    </Section>
  );
}

/** Settings › Agents › Conversations: whether Continue lists this computer's own CLI conversations. */
function ConversationsSection({ client }: { readonly client: LiveRuntimesClient }) {
  const [on, setOn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ readonly tone: 'warn' | 'err'; readonly text: string } | null>(null);

  const read = useCallback((): (() => void) => {
    let live = true;
    readKeepInSyncDocument(client).then(
      document => {
        if (live && document !== null) setOn(document.on);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client]);
  useEffect(read, [read]);
  useConfigFileChanges(client, CONVERSATION_FILE, () => void read(), 'conversation');

  const toggle = (): void => {
    const next = !on;
    setBusy(true);
    setNote(null);
    saveKeepInSync(client, next).then(
      result => {
        setBusy(false);
        if (result === 'broken')
          return setNote({ tone: 'err', text: 'conversation.yaml has a problem; fix it in the Files panel first.' });
        setOn(next);
        if (result === 'held') setNote({ tone: 'warn', text: HELD_CHANGE_SENTENCE });
      },
      (failure: unknown) => {
        setBusy(false);
        setNote({ tone: 'err', text: reasonOf(failure) });
      },
    );
  };

  return (
    <Section title="Conversations" name="conversations">
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
    </Section>
  );
}

export function AgentsTab({ client, machine, machineName, checking, onRetry, onRefresh }: MachineTabProps) {
  const changes = useAccountChanges({ client });
  const onSaved = onRefresh ?? onRetry;

  if (machine === null)
    return (
      <div className="flex min-w-0 flex-col gap-5">
        <p role="status" className="m-0 text-cell text-muted" data-agents-waiting="">
          {checking ? `Checking ${machineName}…` : `${machineName}’s agent settings show once it answers.`}
        </p>
      </div>
    );

  const props = { machine, machineName, changes, onSaved };
  return (
    <div className="flex min-w-0 flex-col gap-5" data-agents-tab="">
      <AgentPermissionsSection key={machine.agentPermissions} {...props} />
      <AgentControlSection key={Object.values(machine.agentControl).join(',')} {...props} />
      <AutoResumeSection key={`resume-${String(machine.autoResume)}`} {...props} />
      <AgendaModeSection key={`agenda-${String(machine.agendaMode)}`} {...props} />
      <ConversationsSection client={client} />
    </div>
  );
}
