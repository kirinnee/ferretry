/**
 * @ferretry/plugin-skills/contract — wire schemas, port + token, events, state and config declarations, words, audit kinds.
 * Skills owns the `skill` item kind (§4.9): inert packaged instructions, the inventory of every skill on the machine, and
 * the reviewed copy of one skill from another account or project. It takes `launch.parts`.
 */
import type { Word } from '@ferretry/kernel/contract';
import { defineConfig, defineEvent, definePort, defineState, neverLoosens } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { configDef } from './config-def.ts';
import { LocalSkillInstallStateSchema } from './installs-state.ts';
import {
  type FerretSkills,
  type FerretSkillsInventory,
  type LocalSkillInstallList,
  type MachineSkillsInventory,
  SkillsItemSchema,
} from './wire.ts';

export * from './installs-state.ts';
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
  /** The skills copied from this machine, and where. */
  installs(): Promise<LocalSkillInstallList>;
}
export const SkillsPort = definePort<SkillsApi>('skills');

export const SKILLS_READ_MODELS = ['inventory', 'ferretInventory', 'forComposer', 'file', 'installs'] as const;

// ─── events ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A local copy was applied or removed (after its write). The skill's NAME and the scope only. */
export const SkillsChanged = defineEvent(
  'skills.changed',
  z.strictObject({
    name: z.string().min(1),
    scope: z.enum(['project', 'runtime']),
    change: z.enum(['installed', 'removed']),
  }),
);

// ─── state (§9.2) ────────────────────────────────────────────────────────────────────────────────────────────────

/** Installed skill folders by content hash. Opaque to the kernel: they are the skill's own files. */
export const SKILLS_INSTALLED_STATE = defineState({
  name: 'installed',
  path: 'installed/*',
  store: 'opaque',
  format: 1,
});

/** `state/skills/installs.json`: the copies this machine made, with the hash of every file written. */
export const SKILLS_INSTALLS_STATE = defineState({
  name: 'installs',
  path: 'installs.json',
  store: 'json',
  format: 1,
  schema: LocalSkillInstallStateSchema,
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

// ─── audit kinds (Gate's log; today's `fleet.configured` with `action`/`scope` detail) ──────────────────────────────

/** The skill's NAME, never a file; `code` of a refusal says why (a source the inventory does not list, a file edited here). */
export const SKILLS_AUDIT = {
  installProject: 'fleet.configured:local-skill-install-project',
  installRuntime: 'fleet.configured:local-skill-install-runtime',
  removeProject: 'fleet.configured:local-skill-remove-project',
  removeRuntime: 'fleet.configured:local-skill-remove-runtime',
} as const;
