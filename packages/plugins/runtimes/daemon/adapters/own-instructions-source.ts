/**
 * Runtimes' own `instructions` components as a profile component source. No other plugin owns the kind, so Runtimes does:
 * its documents are `config/instructions/<name>.yaml`, read live from the kernel's configuration on every call and kept
 * nowhere. The evaluator reads it through the same source interface the other owners provide, so there is one reading path
 * and no second way to resolve a kind.
 */
import type { ConfigCollectionDef, ConfigPort } from '@ferretry/kernel/contract';
import { type InstructionsFile, INSTRUCTION_ITEMS, type ProfileComponentSource } from '../../contract/index.ts';

// The contract widens its config defs so `manifest.data.config` accepts them (`contract/config-def.ts`); this puts the shape back.
const instructionItems = INSTRUCTION_ITEMS as unknown as ConfigCollectionDef<InstructionsFile>;

export function ownInstructionsSource(config: Pick<ConfigPort, 'collection'>): ProfileComponentSource {
  const items = (): ReadonlyMap<string, InstructionsFile> => config.collection(instructionItems);
  return {
    list: async () => [...items().keys()].toSorted((left, right) => left.localeCompare(right)),
    read: async name => {
      const item = items().get(name);
      if (item === undefined) return undefined;
      const { description: _description, ...component } = item;
      return structuredClone({ ...component });
    },
  };
}
