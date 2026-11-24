/**
 * Step `sign-in`: does Codex have a login that works here? Yes: skipped. A login that needs signing in: Logins' own Codex
 * sign-in (the link first, a code behind it), mounted for that login. A login still being checked: said so, with a retry. No login that can be
 * signed in (none at all, only switched-off ones, or ones that cannot be signed in from here): Logins' add-login panel locked to Codex (`harness:codex`). The page reads the logins
 * again when one changes, and ends the moment one is ready. It draws no credential: the logins list has status words only.
 */
import { Button, PanelSlot, daemonOfClient } from '@ferretry/app';
import type { StepHost } from './onboarding-api.ts';
import { LoginChanged } from '@ferretry/plugin-logins/contract';
import { SIGNED_LOGIN_KEY, StepActions, StepBody, StepLine } from '@ferretry/plugin-runtimes/import-kit';
import { useCallback, useEffect, useState } from 'react';
import { type OnboardingClient, type SignInFacts, readSignIn, refusalWords } from './onboarding-api.ts';

type View =
  | { readonly kind: 'reading' }
  | { readonly kind: 'facts'; readonly facts: SignInFacts }
  | { readonly kind: 'failed'; readonly words: string };

const SLOT = 'settings';

/**
 * The subject that locks Logins' add-login panel to Codex (`harnessOfSubject`): this page is ABOUT Codex, so the panel
 * never offers the Claude Code / Codex chooser or a provider grid (r11 owner line 6, "why in codex' segment, it ask you to
 * use claude code?"). A login that needs signing in is mounted with its own id instead.
 */
const ADD_SUBJECT = 'harness:codex';

/** The Logins panel this page mounts for what it found, and the subject it mounts it with: one rule, so a test can mount the same. */
export const signInPanelFor = (
  facts: Extract<SignInFacts, { state: 'needs-sign-in' | 'no-login' }>,
): { readonly panel: 'codex-login' | 'add-login'; readonly subject: string } =>
  facts.state === 'needs-sign-in'
    ? { panel: 'codex-login', subject: facts.login.id }
    : { panel: 'add-login', subject: ADD_SUBJECT };

const KEPT_ADD = { panel: 'add-login', subject: ADD_SUBJECT } as const;

export function SignInPage({ client, step }: { readonly client: OnboardingClient; readonly step: StepHost }) {
  const [view, setView] = useState<View>({ kind: 'reading' });
  const [shown, setShown] = useState(false);
  /**
   * The add-login panel makes the login AND starts its sign-in in one press (Logins' `HarnessSignInEmbed`), and the daemon
   * publishes `LoginChanged` for the new login BEFORE it answers the add. A page that swapped the add panel for the
   * login's own panel the moment the login appeared would unmount the panel that is about to start (or has just started)
   * the sign-in. So once the add panel was drawn it stays, until the page is signed in.
   */
  const [keepAdd, setKeepAdd] = useState(false);

  const read = useCallback(
    async (first: boolean): Promise<void> => {
      try {
        const facts = await readSignIn(client);
        if (facts.state === 'signed-in') {
          // The login handled is kept for the Ready page, which names THAT login's runtime (run memory, never stored).
          step.remember({ [SIGNED_LOGIN_KEY]: facts.id });
          if (first) {
            step.skip('not-needed');
            return;
          }
          step.done();
        }
        if (facts.state === 'no-login') setKeepAdd(true);
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
  const INTRO = <StepLine>Sign in to Codex on this machine.</StepLine>;
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
  if (facts.state === 'checking' && !keepAdd)
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
  const { panel, subject } = keepAdd || facts.state === 'checking' ? KEPT_ADD : signInPanelFor(facts);
  return (
    <StepBody step="codex.sign-in" label="Sign in to Codex" data-codex-step="sign-in">
      {INTRO}
      {daemon === undefined ? null : (
        <PanelSlot
          daemon={daemon}
          slot={SLOT}
          include={ref => ref.plugin === 'logins' && ref.id === panel}
          subject={subject}
        />
      )}
    </StepBody>
  );
}
