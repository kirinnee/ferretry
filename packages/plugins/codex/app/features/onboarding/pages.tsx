/**
 * The Codex onboarding pages by step id. `stepBody(id, client)` is the body of one step; the plugin's `app/index.ts` mounts
 * one panel per declared step (`step-<id>`, wrapped in `forSubject` so it draws only for its own `codex.<id>` subject).
 * A step this plugin declares but has no page for yet (the import pages, `import/*`) skips itself at once, so a declared
 * step never hangs the flow under its loading cover. No host (the panel drawn outside the setup flow) draws nothing.
 */
import type { AppComponent, PanelProps } from '@ferretry/kernel/manifest';
import { createElement, type ReactElement, useEffect, useState } from 'react';
import { ImportChoicePage, rememberedImportMode } from './import-choice-page.tsx';
import { IMPORT_PAGES } from './import/index.ts';
import { InstalledPage } from './installed-page.tsx';
import type { OnboardingClient, StepHost } from './onboarding-api.ts';
import { PermissionPage } from './permission-page.tsx';
import { SignInPage } from './sign-in-page.tsx';

type Page = (client: OnboardingClient, step: StepHost) => ReactElement;

/** Step id → page. The import pages are spread in from `import/`. */
const PAGES: Readonly<Record<string, Page>> = {
  ...IMPORT_PAGES,
  installed: (client, step) => createElement(InstalledPage, { client, step }),
  'sign-in': (client, step) => createElement(SignInPage, { client, step }),
  'import-choice': (_client, step) => createElement(ImportChoicePage, { step }),
  permission: (client, step) => createElement(PermissionPage, { client, step }),
};

function NoPageYet({ step }: { readonly step: StepHost }) {
  useEffect(() => {
    step.skip('not-needed');
  }, [step]);
  return null;
}

/** The steps that act on the person's answer at `import-choice`: every `import-*` step but the choice itself. */
const readsImportChoice = (id: string): boolean => id.startsWith('import-') && id !== 'import-choice';

/**
 * An import step with no remembered `importMode` (a reload since the choice was answered) brings the choice back before
 * anything else: it neither runs, skips, nor is answered by default until the person has chosen. Once they have, the step's own
 * body takes over.
 */
function AfterChoice({ step, body }: { readonly step: StepHost; readonly body: () => ReactElement }) {
  const [chosen, setChosen] = useState(() => rememberedImportMode(step) !== undefined);
  if (chosen) return body();
  return createElement(ImportChoicePage, { step, returned: { onChosen: () => setChosen(true) } });
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
      draw: host => {
        const body = (): ReactElement => PAGES[id]?.(client, host) ?? createElement(NoPageYet, { step: host });
        return readsImportChoice(id) ? createElement(AfterChoice, { step: host, body }) : body();
      },
    });
