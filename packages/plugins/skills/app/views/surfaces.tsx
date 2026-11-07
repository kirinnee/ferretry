/**
 * EVERY SURFACE SKILLS DRAWS, built once per daemon from the generated client: the Skills tab of a ferret's "This folder"
 * context (`ferret.side`), the Settings tab (the machine's inventory and the copies made from it) and the two reference
 * renderers (`/name` and `$name`, one skill).
 */
import type { AppComponent, PanelProps, PluginClient, RendererProps, SettingsProps } from '@ferretry/kernel/manifest';
import { createSkillReference } from './skill-reference.tsx';
import { createSkillsPanel } from './skills-panel.tsx';
import { createSkillsSettings } from './skills-settings.tsx';

export interface SkillsSurfaces {
  readonly panels: { readonly skills: AppComponent<PanelProps> };
  readonly settings: { readonly skills: AppComponent<SettingsProps> };
  readonly renderers: {
    readonly 'reference:/': AppComponent<RendererProps>;
    readonly 'reference:$': AppComponent<RendererProps>;
  };
}

export const createSurfaces = (client: PluginClient): SkillsSurfaces => ({
  panels: { skills: createSkillsPanel(client) },
  settings: { skills: createSkillsSettings(client) },
  renderers: {
    'reference:/': createSkillReference(client, '/'),
    'reference:$': createSkillReference(client, '$'),
  },
});
