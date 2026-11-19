/**
 * Which tool an imported item belongs to, as the import plans it: the name a tool's item takes, and the scope an update
 * keeps. Pure. Split out of `import.ts` (one feature, one file): that module plans what an import makes, this one only
 * answers whose an item is.
 */
import type { HarnessKind } from '../manifest.ts';
import type { Candidate, ImportedComponent } from './import.ts';
import type { AccountModel, McpComponent } from './schema.ts';

/** `claude-instructions`, `codex-github`: what an item of one tool is named. */
export const harnessNamed = (harness: HarnessKind, what: string): string => `${harness}-${what}`;

const withoutScope = (server: McpComponent): Omit<McpComponent, 'harness'> => {
  const { harness: _harness, ...rest } = server;
  return rest;
};

/**
 * A server another tool's import already made under this name: this tool's is its OWN item, `<tool>-<name>`, created new,
 * whether or not the two are identical. The existing item is never widened or changed (its owner only creates), and the
 * same tool imported again finds its own item by the same rule and updates it.
 */
export function ownMcpItem(original: Candidate, existing: AccountModel | undefined): Candidate {
  if (original.component.kind !== 'mcp') return original;
  const mine = original.component.value;
  const heldBy = existing?.components.mcp[original.component.name]?.harness;
  if (mine.harness === undefined || heldBy === undefined || heldBy === mine.harness) return original;
  return {
    ...original,
    component: { kind: 'mcp', name: harnessNamed(mine.harness, original.component.name), value: mine },
  };
}

/** An update never changes which tools a server serves: the item keeps the scope it has. */
export function keepScope(component: ImportedComponent, existing: AccountModel | undefined): ImportedComponent {
  if (component.kind !== 'mcp') return component;
  const scope = existing?.components.mcp[component.name]?.harness;
  return {
    ...component,
    value: { ...withoutScope(component.value), ...(scope === undefined ? {} : { harness: scope }) },
  };
}
