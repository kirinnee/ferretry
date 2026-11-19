/**
 * Step `sign-in`: does Codex have a login that works here? Yes: skipped. A login that needs signing in: Logins' own Codex
 * sign-in (the device code), mounted for that login. No login at all: Logins' add-login panel. The page reads the logins
 * again when one changes, and ends the moment one is ready. It draws no credential: the logins list has status words only.
 */
import { PanelSlot, daemonOfClient } from '@ferretry/app';
import type { StepHost } from './onboarding-api.ts';
import { LoginChanged } from '@ferretry/plugin-logins/contract';
import { useCallback, useEffect, useState } from 'react';
import { type OnboardingClient, type SignInFacts, readSignIn, refusalWords } from './onboarding-api.ts';

type View =
  | { readonly kind: 'reading' }
  | { readonly kind: 'facts'; readonly facts: SignInFacts }
  | { readonly kind: 'failed'; readonly words: string };

const SLOT = 'settings';

export function SignInPage({ client, step }: { readonly client: OnboardingClient; readonly step: StepHost }) {
  const [view, setView] = useState<View>({ kind: 'reading' });
  const [shown, setShown] = useState(false);

  const read = useCallback(
    async (first: boolean): Promise<void> => {
      try {
        const facts = await readSignIn(client);
        if (facts.state === 'signed-in') {
          if (first) {
            step.skip('not-needed');
            return;
          }
          step.done();
        }
        setView({ kind: 'facts', facts });
      } catch (cause) {
        setView({ kind: 'failed', words: refusalWords(cause) });
      }
      if (first) {
        setShown(true);
        step.ready();
      }
    },
    [client, step],
  );

  useEffect(() => {
    void read(true);
    return client.subscribe(LoginChanged, () => {
      void read(false);
    });
  }, [client, read]);

  if (!shown || view.kind === 'reading') return null;
  if (view.kind === 'failed')
    return (
      <p role="alert" className="m-0 text-cell text-warn" data-codex-step="sign-in">
        {view.words}
      </p>
    );
  const { facts } = view;
  if (facts.state === 'signed-in')
    return (
      <p className="m-0 text-ui text-fg" data-codex-step="sign-in" data-codex-signed-in="">
        Signed in as {facts.who}.
      </p>
    );
  const daemon = daemonOfClient(client);
  const panel = facts.state === 'needs-sign-in' ? 'codex-login' : 'add-login';
  return (
    <section aria-label="Sign in to Codex" className="flex max-w-xl flex-col gap-3" data-codex-step="sign-in">
      <p className="m-0 text-cell text-muted">
        {facts.state === 'needs-sign-in'
          ? 'Codex needs you to sign in on this machine. You can do it later in Settings › Logins.'
          : 'There is no Codex login on this machine yet. You can add one later in Settings › Logins.'}
      </p>
      {daemon === undefined ? null : (
        <PanelSlot
          daemon={daemon}
          slot={SLOT}
          include={ref => ref.plugin === 'logins' && ref.id === panel}
          {...(facts.state === 'needs-sign-in' ? { subject: facts.login.id } : {})}
        />
      )}
    </section>
  );
}
