/** The Codex import pages by step id: `pages.tsx` mounts them. One line per page, nothing else lives here. */
import { createElement, type ReactElement } from 'react';
import type { OnboardingClient, StepHost } from '../onboarding-api.ts';
import { ConversationsPage } from './conversations-page.tsx';
import { KIND_OF_STEP } from './import-memory.ts';
import { ImportRunPage } from './import-run-page.tsx';
import { KindPage } from './kind-page.tsx';

type Page = (client: OnboardingClient, step: StepHost) => ReactElement;

const kindPage = (stepId: string): Page => {
  const kind = KIND_OF_STEP[stepId];
  if (kind === undefined) throw new Error(`no import kind for ${stepId}`);
  return (client, step) => createElement(KindPage, { client, step, kind });
};

export const IMPORT_PAGES: Readonly<Record<string, Page>> = {
  'import-settings': kindPage('import-settings'),
  'import-model-set': kindPage('import-model-set'),
  'import-instructions': kindPage('import-instructions'),
  'import-skills': kindPage('import-skills'),
  'import-mcp': kindPage('import-mcp'),
  conversations: (client, step) => createElement(ConversationsPage, { client, step }),
  'import-run': (client, step) => createElement(ImportRunPage, { client, step }),
};
