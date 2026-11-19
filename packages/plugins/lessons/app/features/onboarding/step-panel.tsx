/** The first-run panel's container: it gives the page this plugin's client for the daemon on screen. */

import type { PanelProps } from '@ferretry/kernel/manifest';
import { LessonsStep } from './lessons-step.tsx';
import type { LessonsConnection } from '../../src/api.ts';

/** The panel for `lessons.lessons`; the host the shell put on the props (`PanelProps.step`) goes straight to the page. */
export const lessonsStepPanel =
  (connection: LessonsConnection) =>
  ({ step }: PanelProps) => <LessonsStep connection={connection} step={step} />;
