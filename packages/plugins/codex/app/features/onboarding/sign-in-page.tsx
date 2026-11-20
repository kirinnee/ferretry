/**
 * Step `sign-in`: does Codex have a login that works here? Yes: skipped. A login that needs signing in: Logins' own Codex
 * sign-in (the device code), mounted for that login. A login still being checked: said so, with a retry. No login that can be
 * signed in (none at all, only switched-off ones, or ones that cannot be signed in from here): Logins' add-login panel. The page reads the logins
 * again when one changes, and ends the moment one is ready. It draws no credential: the logins list has status words only.
 */
import { Button, PanelSlot, daemonOfClient } from '@ferretry/app';
import type { StepHost } from './onboarding-api.ts';
import { LoginChanged } from '@ferretry/plugin-logins/contract';
import { StepActions, StepBody, StepLine } from '@ferretry/plugin-runtimes/import-kit';
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
  const INTRO = (
    <StepLine>Sign in to your Codex account on this machine. Ferretry never sees the sign-in: Codex keeps it.</StepLine>
  );
  if (view.kind === 'failed')
    return (
      <StepBody step="codex.sign-in" label="Sign in to Codex" data-codex-step="sign-in">
        {INTRO}
        <StepLine role="alert">{view.words}</StepLine>
      </StepBody>
    );
  const { facts } = view;
  if (facts.state === 'signed-in')
    return (
      <StepBody step="codex.sign-in" label="Sign in to Codex" data-codex-step="sign-in" data-codex-signed-in="">
        <StepLine role="status">Signed in as {facts.who}.</StepLine>
      </StepBody>
    );
  if (facts.state === 'checking')
    return (
      <StepBody step="codex.sign-in" label="Sign in to Codex" data-codex-step="sign-in">
        {INTRO}
        <StepActions>
          <StepLine data-codex-checking="">Checking whether your Codex login is signed in…</StepLine>
          <Button data-codex-retry="" onClick={() => void read(false)}>
            Check again
          </Button>
        </StepActions>
      </StepBody>
    );
  const daemon = daemonOfClient(client);
  const panel = facts.state === 'needs-sign-in' ? 'codex-login' : 'add-login';
  return (
    <StepBody step="codex.sign-in" label="Sign in to Codex" data-codex-step="sign-in">
      {INTRO}
      {facts.state === 'needs-sign-in' ? null : (
        <StepLine>
          There is no Codex login on this machine that can be signed in yet. Add one here, or later in Settings ›
          Logins.
        </StepLine>
      )}
      {daemon === undefined ? null : (
        <PanelSlot
          daemon={daemon}
          slot={SLOT}
          include={ref => ref.plugin === 'logins' && ref.id === panel}
          {...(facts.state === 'needs-sign-in' ? { subject: facts.login.id } : {})}
        />
      )}
    </StepBody>
  );
}
