/**
 * The Codex onboarding pages by step id. `stepBody(id, client)` is the body of one step; the plugin's `app/index.ts` mounts
 * one panel per declared step (`step-<id>`, wrapped in `forSubject` so it draws only for its own `codex.<id>` subject).
 * A step this plugin declares but has no page for yet (the import pages, `import/*`) skips itself at once, so a declared
 * step never hangs the flow under its loading cover. No host (the panel drawn outside the setup flow) draws nothing.
 */
import type { AppComponent, PanelProps } from '@ferretry/kernel/manifest';
import { createElement, type ReactElement, useEffect } from 'react';
import { ImportChoicePage } from './import-choice-page.tsx';
import { IMPORT_PAGES } from './import/index.ts';
import { InstalledPage } from './installed-page.tsx';
import type { OnboardingClient, StepHost } from './onboarding-api.ts';
import { PermissionPage } from './permission-page.tsx';
import { RuntimeReadyPage } from '@ferretry/plugin-runtimes/import-kit';
import { SignInPage } from './sign-in-page.tsx';

type Page = (client: OnboardingClient, step: StepHost) => ReactElement;

/** Step id → page. The import pages are spread in from `import/`. */
const PAGES: Readonly<Record<string, Page>> = {
  ...IMPORT_PAGES,
  installed: (client, step) => createElement(InstalledPage, { client, step }),
  'sign-in': (client, step) => createElement(SignInPage, { client, step }),
  'import-choice': (_client, step) => createElement(ImportChoicePage, { step }),
  permission: (client, step) => createElement(PermissionPage, { client, step }),
  ready: (client, step) => createElement(RuntimeReadyPage, { client, harness: 'codex', label: 'Codex', step }),
};

function NoPageYet({ step }: { readonly step: StepHost }) {
  useEffect(() => {
    step.skip('not-needed');
  }, [step]);
  return null;
}

function WithHost({
  step,
  draw,
}: {
  readonly step: StepHost | undefined;
  readonly draw: (step: StepHost) => ReactElement;
}) {
  return step === undefined ? null : draw(step);
}

/** The body of one Codex step. */
export const stepBody =
  (id: string, client: OnboardingClient): AppComponent<PanelProps> =>
  ({ step }) =>
    createElement(WithHost, {
      step,
      draw: host => PAGES[id]?.(client, host) ?? createElement(NoPageYet, { step: host }),
    });
