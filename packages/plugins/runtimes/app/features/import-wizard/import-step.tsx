/**
 * The first run's "Bring your setup" step: Claude Code, then Codex, one page each (`tool-page.tsx`). It is the body of the
 * onboarding step `runtimes.import`; the person can leave either tool out, and a copy from another machine stays its own
 * step (`runtimes.start`).
 */
import { Loading } from '@ferretry/app/ui';
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import { useState } from 'react';
import type { AppComponent, SettingsProps } from '@ferretry/kernel/manifest';
import type { LiveRuntimesClient } from '../../lib/client.ts';
import { machineSettingsView } from '../../views/machine-settings-host.tsx';
import { Badge, Button } from '../../ui.ts';
import { HARNESS_LABEL } from './mapping-words.ts';
import { HARNESSES } from './model.ts';
import { ToolPage } from './tool-page.tsx';
import { useImportWizard } from './use-import-wizard.ts';

function Progress({
  at,
  onPick,
  state,
}: {
  readonly at: number;
  readonly onPick: (index: number) => void;
  readonly state: (harness: HarnessKey) => string;
}) {
  return (
    <ol
      className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2"
      aria-label="Tools to bring in"
      data-import-progress=""
    >
      {HARNESSES.map((harness, index) => (
        <li key={harness} className="min-w-0">
          <button
            type="button"
            aria-current={index === at ? 'step' : undefined}
            data-import-tab={harness}
            onClick={() => onPick(index)}
            className="kt-panel flex min-h-[44px] w-full cursor-pointer items-center gap-2 px-3 text-row font-semibold text-fg aria-[current=step]:border-accent aria-[current=step]:bg-accent-soft"
          >
            <span className="text-muted">{index + 1}</span>
            {HARNESS_LABEL[harness]}
            <Badge tone={state(harness) === 'Done' ? 'ok' : 'pend'}>{state(harness)}</Badge>
          </button>
        </li>
      ))}
    </ol>
  );
}

export function ImportStep({
  client,
  machineName,
}: {
  readonly client: LiveRuntimesClient;
  readonly machineName: string;
}) {
  const wizard = useImportWizard(client);
  const [at, setAt] = useState(0);
  const [finished, setFinished] = useState(false);

  if (wizard.read.kind === 'reading' || wizard.models === null)
    return wizard.read.kind === 'failed' ? (
      <div className="flex flex-wrap items-center gap-2" data-import-unreadable="">
        <p role="alert" className="m-0 text-cell leading-base text-warn">
          {wizard.read.sentence}
        </p>
        <Button type="button" size="sm" onClick={() => void wizard.rescan()}>
          Try again
        </Button>
      </div>
    ) : (
      <Loading kind="page" compact label="Looking at what is on this machine…" />
    );

  const stateOf = (harness: HarnessKey): string => {
    const end = wizard.ends[harness];
    return end === undefined ? 'To do' : end.kind === 'imported' ? 'Done' : 'Left out';
  };
  const last = at === HARNESSES.length - 1;
  const harness = HARNESSES[at] as HarnessKey;
  const model = wizard.models[harness];

  return (
    <div className="flex min-w-0 flex-col gap-4" data-onboarding-step-body="import" data-import-wizard="">
      <p className="m-0 text-cell leading-base text-muted">
        Bring your Claude Code and Codex setup over. Ferretry reads them; it never changes them.
      </p>
      <Progress
        at={at}
        onPick={index => {
          setFinished(false);
          setAt(index);
        }}
        state={stateOf}
      />
      {finished ? (
        <div className="kt-panel flex min-w-0 flex-col gap-1 p-panel" role="status" data-import-finished="">
          <p className="m-0 text-row font-semibold text-fg">That’s both tools.</p>
          <p className="m-0 text-cell text-muted">
            {HARNESSES.map(item => `${HARNESS_LABEL[item]}: ${stateOf(item).toLowerCase()}`).join(' · ')}
          </p>
        </div>
      ) : (
        <ToolPage
          key={harness}
          model={model}
          wizard={wizard}
          machineName={machineName}
          nextLabel={last ? 'Finish' : `Next: ${HARNESS_LABEL[HARNESSES[at + 1] as HarnessKey]}`}
          onNext={() => (last ? setFinished(true) : setAt(at + 1))}
        />
      )}
    </div>
  );
}

export const createImportStep = (client: LiveRuntimesClient): AppComponent<SettingsProps> =>
  machineSettingsView(client, ({ client: machineClient, machineName }) => (
    <ImportStep client={machineClient} machineName={machineName} />
  ));
