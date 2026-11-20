/**
 * One tool's page (Claude Code, then Codex): what is on this machine, install it, sign in, choose what to bring, name the
 * runtime, and import. After the import, the answer says each file written or refused (what the owners reported).
 */
import { Badge, Button } from '../../ui.ts';
import { useState } from 'react';
import type { ImportItemId } from '../../../contract/index.ts';
import { AddLoginSlot } from '../fleet/runtimes/add-runtime-login-slots.tsx';
import { ChangeApplyPanel } from '../fleet/shell/apply-change-panel.tsx';
import { FoundList } from '../import-kit/found-list.tsx';
import { ImportResultList } from '../import-kit/import-results.tsx';
import { counts, nameProblem, type ToolModel } from '../import-kit/model.ts';
import { plural, toolHeadline } from '../import-kit/mapping-words.ts';
import type { ImportWizard } from './use-import-wizard.ts';

function Header({ model, hideState = false }: { readonly model: ToolModel; readonly hideState?: boolean }) {
  const signedInAs = !model.installed ? 'unknown' : model.stage === 'needs-sign-in' ? 'none' : { email: model.email };
  return (
    <header className="flex min-w-0 flex-col gap-1" data-tool-header={model.harness}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 className="m-0 text-row font-semibold text-fg">{model.label}</h3>
        {hideState ? null : (
          <Badge tone={!model.installed || model.stage === 'needs-sign-in' ? 'warn' : 'ok'}>
            {!model.installed ? 'Not installed' : model.stage === 'ready' ? 'Ready' : 'Needs sign-in'}
          </Badge>
        )}
      </div>
      <p className="m-0 text-cell text-muted" data-tool-headline="">
        {toolHeadline({ installed: model.installed, version: model.version, signedInAs })}
      </p>
    </header>
  );
}

function InstallBlock({ model, wizard }: { readonly model: ToolModel; readonly wizard: ImportWizard }) {
  const busy = wizard.installing === model.harness;
  const note = wizard.installNote[model.harness];
  return (
    <section className="kt-panel flex min-w-0 flex-col gap-2 p-panel" data-tool-install={model.harness}>
      <p className="m-0 text-row font-semibold text-fg">{`Install ${model.label}`}</p>
      {model.install?.kind === 'runnable' ? (
        <>
          <p className="m-0 text-cell text-muted">
            Ferretry will run this, once you confirm. Never as an administrator.
          </p>
          <code
            className="block min-w-0 [overflow-wrap:anywhere] rounded-md bg-surface-2 p-2 text-cell"
            data-install-command=""
          >
            {model.install.command}
          </code>
          <div>
            <Button
              type="button"
              variant="primary"
              disabled={busy}
              data-install-run={model.harness}
              onClick={() => void wizard.install(model.harness)}
            >
              {busy ? 'Installing…' : `Install ${model.label}`}
            </Button>
          </div>
        </>
      ) : model.install?.kind === 'no-package-manager' ? (
        <>
          <p className="m-0 text-cell text-muted">{model.install.reason}</p>
          <p className="m-0 text-cell text-muted">Run this yourself, then check again:</p>
          <code
            className="block min-w-0 [overflow-wrap:anywhere] rounded-md bg-surface-2 p-2 text-cell"
            data-install-command=""
          >
            {model.install.manualCommand}
          </code>
        </>
      ) : null}
      {note === undefined ? null : (
        <p
          role="status"
          className="m-0 whitespace-pre-wrap text-cell leading-base text-fg [overflow-wrap:anywhere]"
          data-install-note=""
        >
          {note}
        </p>
      )}
      <div>
        <Button type="button" size="sm" data-install-recheck={model.harness} onClick={() => void wizard.look()}>
          Check again
        </Button>
      </div>
    </section>
  );
}

function SignInBlock({
  model,
  machineName,
  onSignedIn,
}: {
  readonly model: ToolModel;
  readonly machineName: string;
  readonly onSignedIn: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="flex min-w-0 flex-col gap-2" data-tool-sign-in={model.harness}>
      <p className="m-0 text-cell text-muted">
        {`You aren’t signed in to ${model.label} on this machine. Sign in now, or import first and sign in after.`}
      </p>
      <AddLoginSlot
        machineName={machineName}
        open={open}
        onOpenChange={setOpen}
        onAdded={() => {
          setOpen(false);
          onSignedIn();
        }}
      />
    </section>
  );
}

export interface ToolPageProps {
  readonly model: ToolModel;
  readonly wizard: ImportWizard;
  readonly machineName: string;
  /** The label of the button that leaves this page once it is done (Codex, or Finish). */
  readonly nextLabel: string;
  readonly onNext: () => void;
}

export function ToolPage({ model, wizard, machineName, nextLabel, onNext }: ToolPageProps) {
  const [signedHere, setSignedHere] = useState(false);
  const harness = model.harness;
  const left: ReadonlySet<ImportItemId> = wizard.left[harness];
  const name = wizard.nameOf(harness);
  // A runtime this setup already made is carried through a retry: no new name is asked for, so none is checked.
  const invalid = model.duplicateOf === null ? nameProblem(name) : null;
  const end = wizard.ends[harness];
  const taking = counts(model, left);
  const refreshing = model.updates.filter(update => !wizard.declined[harness].has(update.reference)).length;
  const stage = model.stage === 'needs-sign-in' && signedHere ? 'ready' : model.stage;

  if (end !== undefined)
    return (
      <div className="flex min-w-0 flex-col gap-3" data-tool-page={harness} data-tool-end={end.kind}>
        <Header model={model} hideState />
        {end.kind === 'skipped' ? (
          <p className="m-0 text-cell text-muted">{`You left ${model.label} out. Nothing was changed.`}</p>
        ) : (
          <div className="kt-panel flex min-w-0 flex-col gap-2 border-ok p-panel" role="status" data-import-answer="">
            <p className="m-0 text-row font-semibold text-fg">{`${model.label} is set up`}</p>
            {end.sentences.length === 0 ? (
              <p className="m-0 text-cell text-muted" data-import-answer-earlier="">
                It was brought in before this page was reloaded. What it wrote stays on this machine.
              </p>
            ) : (
              <ImportResultList sentences={end.sentences} />
            )}
            {end.unmarked ? (
              <p role="alert" className="m-0 text-cell text-warn" data-import-unmarked="">
                The import landed, but some first-run steps could not be marked done. Press Done on them in Setup.
              </p>
            ) : null}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="primary" data-tool-next={harness} onClick={onNext}>
            {nextLabel}
          </Button>
          <Button type="button" data-tool-reopen={harness} onClick={() => wizard.reopen(harness)}>
            Go back
          </Button>
        </div>
      </div>
    );

  return (
    <div className="flex min-w-0 flex-col gap-4" data-tool-page={harness} data-tool-stage={stage}>
      <Header model={model} />
      {stage === 'not-installed' ? <InstallBlock model={model} wizard={wizard} /> : null}
      {stage === 'needs-sign-in' ? (
        <SignInBlock
          model={model}
          machineName={machineName}
          onSignedIn={() => {
            setSignedHere(true);
            void wizard.look();
          }}
        />
      ) : null}
      {model.problems.length === 0 ? null : (
        <ul className="m-0 list-disc pl-5 text-cell text-warn" data-tool-problems="">
          {model.problems.map(problem => (
            <li key={problem} className="[overflow-wrap:anywhere]">
              {problem}
            </li>
          ))}
        </ul>
      )}
      <section className="flex min-w-0 flex-col gap-3" data-tool-found="">
        <h4 className="m-0 text-meta font-semibold uppercase text-muted">We found</h4>
        {model.empty ? (
          <p className="m-0 text-cell text-muted" data-found-empty="">
            {`Nothing of yours to bring from ${model.label}. You can still create its runtime.`}
          </p>
        ) : null}
        <FoundList
          harness={harness}
          groups={model.groups}
          left={left}
          leftAlone={model.leftAlone}
          onToggle={(id, on) => wizard.toggle(harness, id, on)}
          tickedEnv={wizard.tickedEnv[harness]}
          onTickEnv={(name, on) => wizard.tickEnv(harness, name, on)}
          updates={model.updates}
          declined={wizard.declined[harness]}
          onTakeUpdate={(reference, on) => wizard.takeUpdate(harness, reference, on)}
        />
      </section>
      <section className="flex min-w-0 flex-col gap-2" data-tool-name="">
        {model.duplicateOf === null ? (
          <label className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg">
            Runtime name
            <input
              type="text"
              className="min-h-control w-full min-w-0 max-w-[28rem] rounded-md border border-border bg-surface px-3 text-row text-fg"
              value={name}
              aria-invalid={invalid !== null}
              data-runtime-name={harness}
              onChange={event => wizard.setName(harness, event.currentTarget.value)}
            />
          </label>
        ) : null}
        {invalid === null ? null : (
          <p role="alert" className="m-0 text-cell text-warn">
            {invalid}
          </p>
        )}
        {model.duplicateOf === null ? null : (
          <p className="m-0 text-cell text-muted" data-duplicate-note="">
            {`A runtime named ${model.duplicateOf} already uses this setup, so no second one is added.`}
          </p>
        )}
      </section>
      {model.installed ? null : (
        <p className="m-0 text-cell font-semibold text-warn" data-import-needs-install="">
          {`Install ${model.label} first; the import needs it on this machine.`}
        </p>
      )}
      <ChangeApplyPanel
        machineName={machineName}
        authority={wizard.changes.authority}
        busy={wizard.changes.busy}
        refusal={wizard.changes.refusal}
        submitLabel="Import and create runtime"
        busyLabel="Importing…"
        disabled={invalid !== null || !model.installed}
        onSubmit={() => void wizard.bringIn(harness)}
      >
        <Button type="button" data-tool-skip={harness} onClick={() => wizard.skip(harness)}>
          {`Skip ${model.label}`}
        </Button>
      </ChangeApplyPanel>
      <p className="m-0 text-cell text-muted" data-import-count="">
        {[
          `Bringing ${plural(taking.taken, 'item')}`,
          refreshing === 0 ? null : `refreshing ${plural(refreshing, 'changed source')}`,
          taking.left === 0 ? null : `leaving out ${String(taking.left)}`,
        ]
          .filter(part => part !== null)
          .join(', ')}
        .
      </p>
    </div>
  );
}
