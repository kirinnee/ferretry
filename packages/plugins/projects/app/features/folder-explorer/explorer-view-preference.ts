/** Which way the explorer lists folders, kept on this device (how this browser likes to read it; never daemon data). */
import { devicePreference, localKey } from '@ferretry/app';
import { EXPLORER_VIEW_CHOICES, type ExplorerViewChoice } from './explorer-model.ts';

export const explorerViewPreference = devicePreference<ExplorerViewChoice>(
  localKey('projects', 'explorer-view'),
  EXPLORER_VIEW_CHOICES,
  'auto',
);
