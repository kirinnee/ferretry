/**
 * The one place a side-pane tab icon NAME becomes a glyph.
 *
 * kteam's model held `LucideIcon` component references directly. Splitting the
 * name from the glyph keeps the tab model a plain data module — it is imported
 * by state code and by tests that never render — while every icon stays exactly
 * the one the original chose.
 */

import {
  Cable,
  ChartNoAxesCombined,
  FileCode2,
  FolderGit2,
  GitFork,
  Globe2,
  ListTodo,
  type LucideIcon,
  Sparkles,
  SquareTerminal,
} from 'lucide-react';
import type { SidePaneTabIconName } from './side-pane-tab-model.ts';

export const SIDE_PANE_TAB_ICONS: Readonly<Record<SidePaneTabIconName, LucideIcon>> = {
  tasks: ListTodo,
  skills: Sparkles,
  lineage: GitFork,
  mcp: Cable,
  analytics: ChartNoAxesCombined,
  browser: Globe2,
  files: FolderGit2,
  terminal: SquareTerminal,
  file: FileCode2,
};

export const sidePaneTabIcon = (name: SidePaneTabIconName): LucideIcon => SIDE_PANE_TAB_ICONS[name];
