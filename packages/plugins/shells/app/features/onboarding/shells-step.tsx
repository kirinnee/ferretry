/**
 * The Shells onboarding step: ONE page, and only when it has something to say. Nix on the machine means there is nothing
 * to ask, so the page skips itself (`not-needed`) before anything is drawn. Without nix it says what ferrets use instead
 * and where to get it, and "Later" moves on without recording an answer: nothing here is a decision.
 */
import { StepPageFrame } from '@ferretry/app';
import type { StepHost } from '@ferretry/kernel/contract';
import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { useEffect, useMemo, useState } from 'react';
import { shellsClient } from '../../lib/shells-client.ts';
import { type NixCheck, shellsStepView } from './shells-step-model.ts';

interface ShellsStepProps {
  readonly step: StepHost;
  readonly check: () => Promise<NixCheck>;
}

export function ShellsStep({ step, check }: ShellsStepProps) {
  const [found, setFound] = useState<NixCheck | undefined>();
  useEffect(() => {
    let live = true;
    check().then(
      result => live && setFound(result),
      () => live && setFound({ kind: 'unreadable' }),
    );
    return () => {
      live = false;
    };
  }, [check]);
  const view = found === undefined ? undefined : shellsStepView(found);
  const decision = view === undefined ? undefined : view.kind;
  useEffect(() => {
    if (decision === 'hide') step.skip('not-needed');
    else if (decision === 'show') step.ready();
  }, [decision, step]);
  if (view === undefined || view.kind === 'hide') return null;
  return (
    <StepPageFrame
      title={view.title}
      line={view.line}
      back={{ onClick: () => step.back() }}
      next={{ label: 'Later', onClick: () => step.next() }}
    >
      <div data-testid="shells-step" className="grid gap-2 text-ui">
        {view.consequence === '' ? null : <p className="m-0">{view.consequence}</p>}
        <p className="m-0 text-muted">{view.remedy}</p>
      </div>
    </StepPageFrame>
  );
}

/** The panel the shell mounts for `shells.nix`: it reads through Shells' own client and hands the page its host. */
export function createShellsStep(client: PluginClient) {
  return function ShellsStepPanel({ step }: PanelProps) {
    const check = useMemo(() => {
      const shells = shellsClient(client);
      return async (): Promise<NixCheck> => ({ kind: 'facts', facts: await shells.nix() });
    }, []);
    return step === undefined ? null : <ShellsStep step={step} check={check} />;
  };
}
