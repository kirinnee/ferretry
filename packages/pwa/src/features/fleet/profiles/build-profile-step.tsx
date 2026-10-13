/**
 * Build a profile, and Edit layers (docs/design/account-model.md §4.5, E18, E19): the body of each
 * step, rendered inside the shell's `MachineStepper`, which owns Back, Cancel, the progress and the
 * offline pause.
 *
 * Eight steps, one decision each: **Start from → Instructions → MCP → Skills → Settings → Model set →
 * Review layers → Name.** A missing component is created in place ("Create new …", then "Save and use
 * it") and comes back picked; everything made inside the flow is saved for reuse, so a Cancel lists it
 * and keeps it (E17).
 *
 * The same body is the sub-stepper Add runtime opens from "+ Build a new profile": when the profile is
 * saved the flow returns to its parent and hands over the new profile's name, so the parent step shows
 * it picked. Render this at ONE stable position while the top flow is {@link BUILD_PROFILE_FLOW_KIND}:
 * the draft lives in this component's own state, for exactly the life of the flow.
 *
 * Review layers asks the daemon what the draft resolves to, so the conflicts it shows are the ones the
 * saved profile will have — never a second reading of the layering rules in the browser.
 */

import type { FleetComponentKind, FleetMachineView, FleetProfileDraftView } from '@ferretry/protocol';
import { ArrowDown, ArrowUp, Lock } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { Button } from '../../../shell/primitives.tsx';
import { previewFleetProfileDraft } from '../catalog-api.ts';
import { type AccountCatalog, allComponents, useAccountCatalog } from '../components/account-catalog.ts';
import {
  AddRow,
  CatalogNote,
  ComponentBadges,
  Hint,
  PickRow,
  Prose,
  ReadFailed,
  RowList,
  Section,
} from '../components/catalog-ui.tsx';
import { ComponentForm } from '../components/component-form.tsx';
import {
  blankDraft,
  type ComponentDraft,
  componentBadges,
  componentChange,
  counted,
  draftProblem,
  KIND_MANY,
  KIND_ONE,
  reuseLabel,
} from '../components/component-model.ts';
import type { FleetClientFactory } from '../fleet-client.ts';
import { ChangeApplyPanel, useAccountChanges } from '../shell/apply-change-panel.tsx';
import { currentFlow, returnToParent, type StepperState, saveForReuse, stepForward } from '../shell/stepper-model.ts';
import { ConflictList, LayerStack } from './layer-stack.tsx';
import {
  type BuildKind,
  draftFromProfile,
  draftLayers,
  emptyProfileDraft,
  moveBase,
  type ProfileDraft,
  partCount,
  profileChange,
  profileNameProblem,
  stackConflicts,
  toggleBase,
  togglePick,
} from './profile-model.ts';

export interface BuildProfileStepProps {
  /** The whole stack; the top flow is Build a profile. */
  readonly state: StepperState;
  /** A step move inside this flow (Next, saved for reuse). */
  readonly onChange: (next: StepperState) => void;
  /**
   * The profile was saved. This flow has already ended: `next` is the parent flow on top, the new
   * profile ready to pick — or `null` when Build a profile was the only flow.
   */
  readonly onBuilt: (profileName: string, next: StepperState | null) => void;
  readonly machineName: string;
  /** The machine the profile is built on. */
  readonly machine: FleetMachineView | null;
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  /** The credential's harness, when opened from Add runtime. */
  readonly harness?: 'claude' | 'codex';
  /** Shows "You go back to choosing a profile, with this one picked." on the Name step. */
  readonly openedFromAddRuntime?: boolean;
  /** Edit layers: the profile being edited. */
  readonly editing?: string;
}

const STEP_HELP: Readonly<Record<BuildKind, string>> = {
  instructions: 'What should every session know?',
  mcp: 'Which tools can the agent call?',
  skills: 'Which skills should it have?',
  settings: 'Any harness settings? Flags and environment live here.',
  modelSets: 'Which models, and which one by default?',
};

export function BuildProfileStep(props: BuildProfileStepProps) {
  const { read, reload } = useAccountCatalog(props.connection, props.createClient);
  const [draft, setDraft] = useState<ProfileDraft | undefined>(
    props.editing === undefined ? emptyProfileDraft() : undefined,
  );

  // Edit layers starts from the profile as the daemon has it, once that has been read.
  useEffect(() => {
    if (draft !== undefined || read.kind !== 'ready') return;
    const profile = read.catalog.profiles.profiles.find(candidate => candidate.name === props.editing);
    setDraft(profile === undefined ? emptyProfileDraft() : draftFromProfile(profile));
  }, [draft, read, props.editing]);

  if (read.kind === 'failed') return <ReadFailed reason={read.reason} onRetry={() => void reload()} />;
  if (read.kind === 'loading' || draft === undefined)
    return (
      <p className="m-0 text-cell text-muted" role="status">
        Reading {props.machineName}’s profiles and components…
      </p>
    );
  return <Steps {...props} catalog={read.catalog} reload={reload} draft={draft} setDraft={setDraft} />;
}

interface StepsProps extends BuildProfileStepProps {
  readonly catalog: AccountCatalog;
  readonly reload: ReturnType<typeof useAccountCatalog>['reload'];
  readonly draft: ProfileDraft;
  readonly setDraft: (next: ProfileDraft) => void;
}

function Steps(props: StepsProps) {
  const at = currentFlow(props.state).at;
  if (at === 'base') return <BaseStep {...props} />;
  if (at === 'review') return <ReviewStep {...props} />;
  if (at === 'name') return <NameStep {...props} />;
  return <PickStep key={at} {...props} kind={at as BuildKind} />;
}

function NextButton({ label, onNext, disabled = false }: { label: string; onNext: () => void; disabled?: boolean }) {
  return (
    <Button type="button" variant="primary" className="w-full" data-build-next="" disabled={disabled} onClick={onNext}>
      {label}
    </Button>
  );
}

function BaseStep({ catalog, draft, setDraft, state, onChange, editing }: StepsProps) {
  const name = useId();
  const profiles = catalog.profiles.profiles;
  const edited = profiles.find(profile => profile.name === editing);
  const loops = new Set(edited?.wouldIncludeItself ?? (editing === undefined ? [] : [editing]));
  return (
    <div className="flex min-w-0 flex-col gap-3" data-build-step="base">
      <Prose>
        Start from existing profiles, or from nothing. When two layers set the same thing, the later one wins.
      </Prose>
      {profiles.length === 0 ? (
        <Hint>No profiles yet. Start from nothing.</Hint>
      ) : (
        <RowList label="Profiles">
          {profiles.map(profile => {
            const loop = loops.has(profile.name);
            return (
              <PickRow
                key={profile.name}
                type="checkbox"
                name={name}
                checked={draft.bases.includes(profile.name)}
                disabled={loop}
                title={profile.name}
                sub={counted(partCount(profile), 'part')}
                extra={
                  loop ? (
                    <span className="inline-flex items-center gap-1 text-cell text-muted" data-build-loop="">
                      <Lock size={12} aria-hidden="true" /> Would include itself
                    </span>
                  ) : undefined
                }
                onChange={on => setDraft(toggleBase(draft, profile.name, on))}
                data={{ 'data-build-base': profile.name }}
              />
            );
          })}
        </RowList>
      )}
      {draft.bases.length === 0 ? null : <BaseOrder draft={draft} setDraft={setDraft} />}
      <NextButton
        label={draft.bases.length > 0 ? 'Next' : 'Next, start from nothing'}
        onNext={() => onChange(stepForward(state))}
      />
    </div>
  );
}

function BaseOrder({ draft, setDraft }: { draft: ProfileDraft; setDraft: (next: ProfileDraft) => void }) {
  return (
    <Section title="Layer order · later wins">
      <ol className="kt-panel m-0 flex min-w-0 list-none flex-col divide-y divide-border p-0" data-build-order="">
        {draft.bases.map((base, index) => (
          <li key={base} className="flex min-w-0 items-center gap-3 px-panel py-1">
            <span className="w-5 shrink-0 text-right font-mono text-cell text-muted">{index + 1}</span>
            <span className="min-w-0 flex-1 break-words text-row text-fg">
              {base}
              {index === draft.bases.length - 1 && draft.bases.length > 1 ? (
                <span className="text-muted"> · wins</span>
              ) : null}
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`Move ${base} earlier`}
              disabled={index === 0}
              onClick={() => setDraft(moveBase(draft, index, -1))}
            >
              <ArrowUp size={14} aria-hidden="true" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`Move ${base} later`}
              disabled={index === draft.bases.length - 1}
              onClick={() => setDraft(moveBase(draft, index, 1))}
            >
              <ArrowDown size={14} aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function PickStep(props: StepsProps & { kind: BuildKind }) {
  const { kind, catalog, draft, setDraft, state, onChange, machineName, connection, createClient } = props;
  const name = useId();
  const [form, setForm] = useState<ComponentDraft | undefined>(undefined);
  const changes = useAccountChanges({ connection, createClient });
  const list = catalog.components.kinds.find(group => group.kind === kind)?.components ?? [];
  const single = kind === 'modelSets';
  const picks = draft.picks[kind];
  const problem = form === undefined ? undefined : draftProblem(form, allComponents(catalog));

  const saveNew = () => {
    if (form === undefined) return;
    void changes.apply(componentChange(form, true)).then(async result => {
      if (result.kind !== 'applied') return;
      const created = form.name.trim();
      await props.reload();
      setDraft(togglePick(draft, kind as FleetComponentKind, `${kind}/${created}`, true));
      onChange(saveForReuse(state, reuseLabel(kind, created)));
      setForm(undefined);
    });
  };

  return (
    <div className="flex min-w-0 flex-col gap-3" data-build-step={kind}>
      <Prose>{STEP_HELP[kind]} Pick existing, create new, or skip.</Prose>
      <RowList label={KIND_MANY[kind]}>
        {single ? (
          <PickRow
            type="radio"
            name={name}
            checked={picks.length === 0}
            title="No model set"
            sub="Use the one from a base layer, or the harness default."
            onChange={() => setDraft(togglePick(draft, kind, null, true))}
            data={{ 'data-build-pick': '' }}
          />
        ) : null}
        {list.map(component => (
          <PickRow
            key={component.reference}
            type={single ? 'radio' : 'checkbox'}
            name={name}
            checked={picks.includes(component.reference)}
            title={<span className={kind === 'mcp' ? 'font-mono' : undefined}>{component.name}</span>}
            extra={<ComponentBadges badges={componentBadges(component, machineName)} />}
            onChange={on => setDraft(togglePick(draft, kind, component.reference, on))}
            data={{ 'data-build-pick': component.reference }}
          />
        ))}
        {form === undefined ? (
          <AddRow
            label={`Create new ${KIND_ONE[kind].toLowerCase()}`}
            onAdd={() => setForm(blankDraft(kind))}
            data={{ 'data-build-create': kind }}
          />
        ) : null}
      </RowList>
      {form === undefined ? null : (
        <CatalogNote tone="info" spot="create" title={`New ${KIND_ONE[kind].toLowerCase()}`}>
          <ComponentForm draft={form} onChange={setForm} editing={false} {...(problem ? { problem } : {})} />
          <ChangeApplyPanel
            machineName={machineName}
            authority={changes.authority}
            busy={changes.busy}
            refusal={changes.refusal}
            submitLabel="Save and use it"
            busyLabel="Saving…"
            disabled={problem !== undefined}
            onSubmit={saveNew}
          >
            <Button type="button" variant="ghost" data-build-create-cancel="" onClick={() => setForm(undefined)}>
              Cancel
            </Button>
          </ChangeApplyPanel>
        </CatalogNote>
      )}
      <NextButton
        label={picks.length > 0 ? 'Next' : `Skip, add no ${KIND_MANY[kind].toLowerCase()}`}
        disabled={form !== undefined}
        onNext={() => onChange(stepForward(state))}
      />
    </div>
  );
}

type Preview =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly view: FleetProfileDraftView }
  | { readonly kind: 'failed' };

function ReviewStep({ catalog, draft, state, onChange, machineName, connection, createClient, editing }: StepsProps) {
  const layers = draftLayers(draft);
  const key = layers.join('\n');
  const [preview, setPreview] = useState<Preview>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // One read per draft and per Try again: the attempt is part of what is asked for.
  const ask = `${attempt}\n${key}`;
  useEffect(() => {
    const [, ...asked] = ask.split('\n');
    if (asked.join('') === '') return;
    let live = true;
    setPreview({ kind: 'loading' });
    void (async () => {
      try {
        const client = await createClient(connection);
        const view = await previewFleetProfileDraft(client, {
          layers: asked,
          ...(editing === undefined ? {} : { editing }),
        });
        if (live) setPreview({ kind: 'ready', view });
      } catch {
        if (live) setPreview({ kind: 'failed' });
      }
    })();
    return () => {
      live = false;
    };
  }, [ask, editing, connection, createClient]);

  if (layers.length === 0)
    return (
      <div className="flex min-w-0 flex-col gap-3" data-build-step="review">
        <CatalogNote tone="warn" spot="empty" title="This profile has no layers yet">
          Go back and pick a starting profile or at least one part.
        </CatalogNote>
        <NextButton label="Next" disabled onNext={() => undefined} />
      </div>
    );
  return (
    <div className="flex min-w-0 flex-col gap-3" data-build-step="review">
      <Prose>This is the stack, newest on top. A newer layer wins when two set the same thing.</Prose>
      <LayerStack
        layers={layers}
        components={allComponents(catalog)}
        profiles={catalog.profiles.profiles}
        machineName={machineName}
      />
      <Section title="Conflicts" spot="conflicts">
        {preview.kind === 'loading' ? (
          <Hint>Checking what overrides what…</Hint>
        ) : preview.kind === 'failed' ? (
          <ReadFailed
            reason={`${machineName} did not answer, so the conflicts cannot be shown yet.`}
            onRetry={() => setAttempt(attempt + 1)}
          />
        ) : preview.view.refusal === undefined ? (
          <ConflictList conflicts={stackConflicts(preview.view.harnesses)} />
        ) : (
          <CatalogNote tone="warn" spot="refused" title={preview.view.refusal} />
        )}
      </Section>
      <NextButton
        label="Next"
        disabled={preview.kind === 'ready' && preview.view.refusal !== undefined}
        onNext={() => onChange(stepForward(state))}
      />
    </div>
  );
}

function NameStep(props: StepsProps) {
  const { catalog, draft, setDraft, state, machineName, connection, createClient, editing } = props;
  const id = useId();
  const changes = useAccountChanges({ connection, createClient });
  const problem = editing === undefined ? profileNameProblem(draft.name, catalog.profiles.profiles) : undefined;
  const save = () =>
    void changes.apply(profileChange(draft, editing)).then(result => {
      if (result.kind !== 'applied') return;
      const saved = editing ?? draft.name.trim();
      props.onBuilt(saved, returnToParent(editing === undefined ? saveForReuse(state, `Profile ${saved}`) : state));
    });
  return (
    <div className="flex min-w-0 flex-col gap-3" data-build-step="name">
      {editing === undefined ? (
        <label className="flex min-w-0 flex-col gap-1" htmlFor={id}>
          <span className="text-cell font-medium text-fg">Profile name</span>
          <input
            id={id}
            className="kt-input"
            value={draft.name}
            autoComplete="off"
            aria-invalid={problem !== undefined && draft.name !== ''}
            data-build-name=""
            onChange={event => setDraft({ ...draft, name: event.currentTarget.value })}
          />
          {problem !== undefined && draft.name !== '' ? (
            <span className="text-cell text-err">{problem}</span>
          ) : (
            <span className="text-cell text-muted">For example Review, Agent or Docs.</span>
          )}
        </label>
      ) : (
        <Prose>
          Saving the new layers of <span className="font-semibold">{editing}</span>.
        </Prose>
      )}
      <Hint>
        {counted(draftLayers(draft).length, 'layer')}.
        {props.openedFromAddRuntime ? ' You go back to choosing a profile, with this one picked.' : ''}
      </Hint>
      <ChangeApplyPanel
        machineName={machineName}
        authority={changes.authority}
        busy={changes.busy}
        refusal={changes.refusal}
        submitLabel={editing === undefined ? 'Save profile' : 'Save changes'}
        busyLabel="Saving…"
        disabled={problem !== undefined}
        onSubmit={save}
      />
    </div>
  );
}
