/**
 * The Shells onboarding step's BODY: ONE page, and only when it has something to say. Nix on the machine means there is
 * nothing to ask, so the page skips itself (`not-needed`) before anything is drawn. Without nix it says what ferrets use
 * instead and where to get it. The shell owns the frame (title, progress, Back / Next, Later), so the page draws none of
 * them and never calls `next()`: nothing here is a decision, and a deferral is the shell's to record. A failed check
 * proves nothing about nix, so it says "Couldn't check" and offers a retry.
 */
import type { StepHost } from '@ferretry/kernel/contract';
import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../ui.ts';
import { shellsClient } from '../../lib/shells-client.ts';
import { type NixCheck, shellsStepView } from './shells-step-model.ts';

interface ShellsStepProps {
  readonly step: StepHost;
  readonly check: () => Promise<NixCheck>;
}

export function ShellsStep({ step, check }: ShellsStepProps) {
  const [found, setFound] = useState<NixCheck | undefined>();
  const [looking, setLooking] = useState(true);
  // The read this page makes: the one it was given, replaced by a fresh one (a new identity) each time "Check again" is pressed.
  const [read, setRead] = useState(() => check);
  useEffect(() => {
    let live = true;
    const settled = (result: NixCheck): void => {
      if (!live) return;
      setFound(result);
      setLooking(false);
    };
    setLooking(true);
    read().then(settled, () => settled({ kind: 'unreadable' }));
    return () => {
      live = false;
    };
  }, [read]);
  const retry = useCallback(() => setRead(() => () => check()), [check]);
  const view = found === undefined ? undefined : shellsStepView(found);
  const decision = view === undefined ? undefined : view.kind;
  useEffect(() => {
    if (decision === 'hide') step.skip('not-needed');
    else if (decision === 'show') step.ready();
  }, [decision, step]);
  if (view === undefined || view.kind === 'hide') return null;
  return (
    <div data-testid="shells-step" data-outcome={view.outcome} className="grid gap-2 text-ui">
      <p className="m-0">{view.line}</p>
      {view.consequence === '' ? null : <p className="m-0">{view.consequence}</p>}
      <p className="m-0 text-muted">{view.remedy}</p>
      {view.outcome === 'unreadable' ? (
        <div>
          <Button size="sm" disabled={looking} onClick={retry} data-shells-step-retry="">
            Check again
          </Button>
        </div>
      ) : null}
    </div>
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
