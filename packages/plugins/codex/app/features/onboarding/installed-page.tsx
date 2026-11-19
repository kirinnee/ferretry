/**
 * Step `installed`: is Codex on this machine? Found: skipped (nothing to ask). Missing: the exact command first, then an
 * Install button that runs exactly that command (the daemon's fixed-argv runner, no shell, no sudo; the shell asks the
 * passkey). The page is `busy` while it installs, and a failure says why and what to run by hand.
 */
import type { StepHost } from './onboarding-api.ts';
import { Button } from '@ferretry/app';
import { useCallback, useEffect, useState } from 'react';
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

type View =
  | { readonly kind: 'reading' }
  | { readonly kind: 'found'; readonly facts: Extract<InstallFacts, { state: 'found' }> }
  | { readonly kind: 'missing'; readonly facts: Extract<InstallFacts, { state: 'missing' }>; readonly note?: string };

export function InstalledPage({ client, step }: { readonly client: OnboardingClient; readonly step: StepHost }) {
  const [view, setView] = useState<View>({ kind: 'reading' });
  const [installing, setInstalling] = useState(false);

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
          step.done();
          return;
        }
        setView({ kind: 'missing', facts: { state: 'missing', plan: await readInstallPlan(client) } });
      } catch (cause) {
        const plan = await readInstallPlan(client);
        setView({ kind: 'missing', facts: { state: 'missing', plan }, note: refusalWords(cause) });
      }
      if (first) step.ready();
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
      step.busy(null);
      setInstalling(false);
    }
  };

  if (view.kind === 'reading') return null;
  if (view.kind === 'found')
    return (
      <section aria-label="Codex is installed" className="flex flex-col gap-2" data-codex-step="installed">
        <p className="m-0 text-ui text-fg" data-codex-found="">
          Codex {view.facts.version === null ? 'is installed.' : `${view.facts.version} is installed.`}
        </p>
        {view.facts.path === null ? null : <code className="text-cell text-muted">{view.facts.path}</code>}
      </section>
    );
  const { plan } = view.facts;
  return (
    <section aria-label="Install Codex" className="flex max-w-xl flex-col gap-3" data-codex-step="installed">
      <p className="m-0 text-ui text-fg">Codex is not on this machine yet.</p>
      {plan.kind === 'runnable' ? (
        <p className="m-0 text-cell text-muted">Installing runs this one command, and nothing else:</p>
      ) : (
        <p className="m-0 text-cell text-muted" data-install-reason="">
          {plan.reason} Run this yourself, then check again:
        </p>
      )}
      <code
        className="block overflow-x-auto rounded-md bg-surface-2 px-3 py-2 text-cell text-fg"
        data-install-command=""
      >
        {plan.command}
      </code>
      <div className="flex flex-wrap gap-2">
        {plan.kind === 'runnable' ? (
          <Button
            type="button"
            variant="primary"
            disabled={installing}
            className="min-h-11 py-3"
            style={{ paddingInline: '1.25rem' }}
            data-install-run=""
            onClick={() => void install()}
          >
            Install Codex
          </Button>
        ) : null}
        <Button
          type="button"
          className="min-h-11 py-3"
          style={{ paddingInline: '1.25rem' }}
          disabled={installing}
          data-install-recheck=""
          onClick={() => void look(false)}
        >
          Check again
        </Button>
      </div>
      {view.note === undefined ? null : (
        <p role="alert" className="m-0 whitespace-pre-wrap text-cell text-warn" data-install-note="">
          {view.note}
        </p>
      )}
    </section>
  );
}
