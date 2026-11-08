/**
 * @ferretry/plugin-skills/contract — wire schemas, port + token, state and config declarations, words.
 * Skills owns the `skill` item kind (§4.9): inert packaged instructions, the inventory of every skill on the machine. It takes `launch.parts`.
 */
import type { Word } from '@ferretry/kernel/contract';
import { defineConfig, definePort, defineState, neverLoosens } from '@ferretry/kernel/contract';
import { configDef } from './config-def.ts';
import {
  type FerretSkills,
  type FerretSkillsInventory,
  type MachineSkillsInventory,
  SkillsItemSchema,
} from './wire.ts';

export * from './wire.ts';

export const SKILLS = 'skills' as const;

export const SKILLS_WORDS: readonly Word[] = [{ word: 'skill', means: 'packaged instructions a ferret can use' }];

// ─── port ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What others and the app may read. Skills reach a ferret through Ferrets' `launch.parts` hook. */
export interface SkillsApi {
  /** Every runtime home's and registered project's skills. */
  inventory(): Promise<MachineSkillsInventory>;
  /** Exactly what one ferret sees. `undefined` when there is no such ferret. */
  ferretInventory(ferret: string): Promise<FerretSkillsInventory | undefined>;
  /** The composer's `/` and `$` list for one ferret. */
  forComposer(ferret: string): Promise<FerretSkills | undefined>;
  /** The SKILL.md text for a path the inventory lists, or `undefined` for any other path (G175's twin for reads). */
  file(path: string, ferret?: string): Promise<string | undefined>;
}
export const SkillsPort = definePort<SkillsApi>('skills');

export const SKILLS_READ_MODELS = ['inventory', 'ferretInventory', 'forComposer', 'file'] as const;

// ─── state (§9.2) ────────────────────────────────────────────────────────────────────────────────────────────────

/** Installed skill folders by content hash. Opaque to the kernel: they are the skill's own files. */
export const SKILLS_INSTALLED_STATE = defineState({
  name: 'installed',
  path: 'installed/*',
  store: 'opaque',
  format: 1,
});

// ─── config (§9.2, §7.2) ─────────────────────────────────────────────────────────────────────────────────────────

const ITEM_NAME = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

/** `config/skills/<name>.yaml`. A component edit changes what an agent runs with, not what it may spend or control. */
export const SKILLS_CONFIG = configDef(
  defineConfig({
    collection: 'skills',
    name: ITEM_NAME,
    schema: SkillsItemSchema,
    axis: 'configure',
    loosens: neverLoosens,
  }),
);
