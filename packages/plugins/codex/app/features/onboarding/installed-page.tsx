/**
 * Step `installed`: is Codex on this machine? Found: skipped (nothing to ask). Missing: the exact command first, then an
 * Install button that runs exactly that command (the daemon's fixed-argv runner, no shell, no sudo; the shell asks the
 * passkey). The page is `busy` while it installs, and a failure says why and what to run by hand.
 */
import type { StepHost } from './onboarding-api.ts';
import { Button, StepDemo } from '@ferretry/app';
import { InstalledDemo, StepActions, StepBody, StepCommand, StepLine } from '@ferretry/plugin-runtimes/import-kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type InstallFacts,
  type OnboardingClient,
  factsOf,
  installCodex,
  planChanged,
  readInstallPlan,
  readUpdate,
  refusalWords,
} from './onboarding-api.ts';

/**
 * While Codex is not installed this page holds `busy`, so the shell's Next stays locked (Later and Skip stay): "not installed yet"
 * must not be recorded as done. `done()` is called only once Codex is found. The same hold as Claude Code's page.
 */
const HOLD = 'Install Codex to continue';

type View =
  | { readonly kind: 'reading' }
  | { readonly kind: 'found'; readonly facts: Extract<InstallFacts, { state: 'found' }> }
  | { readonly kind: 'missing'; readonly facts: Extract<InstallFacts, { state: 'missing' }>; readonly note?: string };

export function InstalledPage({ client, step }: { readonly client: OnboardingClient; readonly step: StepHost }) {
  const [view, setView] = useState<View>({ kind: 'reading' });
  const [installing, setInstalling] = useState(false);
  /** Codex turned up after the page opened (installed here, or by hand): the hold on Next is over. */
  const installed = useRef(false);

  /** Looks at this machine. `first` is the page opening: found means there is nothing to ask, so it is skipped. */
  const look = useCallback(
    async (first: boolean): Promise<void> => {
      try {
        const found = factsOf(await readUpdate(client));
        if (found !== null && found.state === 'found') {
          if (first) {
            step.skip('not-needed');
            return;
          }
          setView({ kind: 'found', facts: found });
          installed.current = true;
          step.busy(null);
          step.done();
          return;
        }
        setView({ kind: 'missing', facts: { state: 'missing', plan: await readInstallPlan(client, !first) } });
      } catch (cause) {
        const plan = await readInstallPlan(client, !first);
        setView({ kind: 'missing', facts: { state: 'missing', plan }, note: refusalWords(cause) });
      }
      if (first) {
        step.ready();
        step.busy(HOLD);
      }
    },
    [client, step],
  );

  useEffect(() => {
    void look(true);
  }, [look]);

  const install = async (): Promise<void> => {
    // Only the command on the screen can run: it travels with the request, and the daemon compares it with its own plan.
    if (view.kind !== 'missing' || view.facts.plan.kind !== 'runnable') return;
    const shown = view.facts.plan.command;
    setInstalling(true);
    step.busy('Installing Codex…');
    try {
      const result = await installCodex(client, shown);
      if (result.done) await look(false);
      else setView(current => (current.kind === 'missing' ? { ...current, note: result.words } : current));
    } catch (cause) {
      // The machine changed between the look and the press: show the command that would run now, for a fresh press.
      const plan = planChanged(cause) ? await readInstallPlan(client) : undefined;
      setView(current =>
        current.kind === 'missing'
          ? {
              ...current,
              ...(plan === undefined ? {} : { facts: { state: 'missing', plan } }),
              note: refusalWords(cause),
            }
          : current,
      );
    } finally {
      step.busy(installed.current ? null : HOLD);
      setInstalling(false);
    }
  };

  if (view.kind === 'reading') return null;
  if (view.kind === 'found')
    return (
      <StepBody step="codex.installed" label="Codex is installed" data-codex-step="installed">
        <StepLine role="status" data-codex-found="">
          Codex {view.facts.version === null ? 'is installed.' : `${view.facts.version} is installed.`}
        </StepLine>
        {view.facts.path === null ? null : <StepCommand>{view.facts.path}</StepCommand>}
      </StepBody>
    );
  const { plan } = view.facts;
  // The way out of a manual command: after a refused install, or when there is no package manager to run it.
  const canCheckAgain = plan.kind !== 'runnable' || view.note !== undefined;
  return (
    <StepBody step="codex.installed" label="Install Codex" data-codex-step="installed">
      <StepLine>Codex is not on this machine yet.</StepLine>
      {plan.kind === 'runnable' ? (
        <StepLine>Install runs exactly this:</StepLine>
      ) : (
        <StepLine data-install-reason="">{plan.reason} Run this yourself:</StepLine>
      )}
      <StepCommand>{plan.command}</StepCommand>
      {plan.kind === 'runnable' ? (
        <div className="ob-actions cx-actions--stretch">
          <Button variant="primary" disabled={installing} data-install-run="" onClick={() => void install()}>
            {installing ? 'Installing…' : 'Install Codex'}
          </Button>
        </div>
      ) : null}
      {view.note === undefined ? null : (
        <StepLine role="alert" data-install-note="">
          {view.note}
        </StepLine>
      )}
      {canCheckAgain ? (
        <StepActions>
          <Button disabled={installing} data-install-recheck="" onClick={() => void look(false)}>
            {installing ? 'Checking…' : 'Check again'}
          </Button>
        </StepActions>
      ) : null}
      <StepDemo>
        <InstalledDemo command="codex --version" answer="codex-cli 0.166.0" label="Codex" />
      </StepDemo>
    </StepBody>
  );
}
