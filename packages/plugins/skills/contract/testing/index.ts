/**
 * @ferretry/plugin-skills/contract/testing — the fake and the conformance suite (§7.8). The real implementation and the
 * fake pass the same suite.
 */
import { err, ok, type Result } from '@ferretry/std';
import {
  type FerretSkills,
  type FerretSkillsInventory,
  FerretSkillsInventorySchema,
  FerretSkillsSchema,
  type LocalSkillInstallList,
  LocalSkillInstallListSchema,
  type MachineSkillsInventory,
  MachineSkillsInventorySchema,
  type SkillsApi,
} from '../index.ts';

export const EMPTY_INVENTORY: MachineSkillsInventory = { homes: [], projects: [], truncated: false };

export interface FakeSkills extends SkillsApi {
  setInventory(inventory: MachineSkillsInventory): void;
  setFerret(ferret: string, inventory: FerretSkillsInventory, composer: FerretSkills): void;
  /** A SKILL.md the fake lists, by absolute path. */
  setFile(path: string, content: string): void;
  setInstalls(installs: LocalSkillInstallList): void;
}

export function fakeSkills(): FakeSkills {
  let inventory = EMPTY_INVENTORY;
  let installs: LocalSkillInstallList = { installs: [] };
  const ferrets = new Map<string, { inventory: FerretSkillsInventory; composer: FerretSkills }>();
  const files = new Map<string, string>();
  return {
    inventory: async () => inventory,
    ferretInventory: async ferret => ferrets.get(ferret)?.inventory,
    forComposer: async ferret => ferrets.get(ferret)?.composer,
    file: async path => files.get(path),
    installs: async () => installs,
    setInventory: next => {
      inventory = next;
    },
    setFerret: (ferret, nextInventory, composer) => {
      ferrets.set(ferret, { inventory: nextInventory, composer });
    },
    setFile: (path, content) => {
      files.set(path, content);
    },
    setInstalls: next => {
      installs = next;
    },
  };
}

/** What every implementation of `SkillsApi` must satisfy. */
export async function skillsConformance(make: () => SkillsApi): Promise<Result<true, readonly string[]>> {
  const failures: string[] = [];
  const api = make();
  if (!MachineSkillsInventorySchema.safeParse(await api.inventory()).success)
    failures.push('inventory() returns a MachineSkillsInventory');
  if (!LocalSkillInstallListSchema.safeParse(await api.installs()).success)
    failures.push('installs() returns an install list');
  const inventory = await api.ferretInventory('no-such-ferret');
  if (inventory !== undefined && !FerretSkillsInventorySchema.safeParse(inventory).success)
    failures.push('ferretInventory() returns a FerretSkillsInventory or undefined');
  const composer = await api.forComposer('no-such-ferret');
  if (composer !== undefined && !FerretSkillsSchema.safeParse(composer).success)
    failures.push('forComposer() returns FerretSkills or undefined');
  // G175: only a path the inventory lists is ever read.
  if ((await api.file('/etc/passwd')) !== undefined) failures.push('file() serves only a path the inventory lists');
  return failures.length === 0 ? ok(true) : err(failures);
}
