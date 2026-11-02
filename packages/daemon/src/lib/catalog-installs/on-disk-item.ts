/**
 * The item as THIS machine holds it now, rebuilt so the diff compares what is installed with what is offered
 * (docs/catalogs.md § See changes). Pure: the service reads the disk and the store, this only shapes it.
 *
 * Two jobs besides assembling the item. The installer replaced `${secret:NAME}` placeholders with the person's own
 * secret (a runtime) or variable (a project), so those values are mapped BACK to the placeholder the item uses —
 * otherwise every environment line would show as changed. And a file too big to show is not read, so it is put
 * back into the answer as an entry that says so.
 */
import {
  type CatalogChanges,
  type CatalogMcpSetup,
  CatalogMcpSetupSchema,
  type CatalogSecretBindings,
  type SharedCatalogItem,
} from '@ferretry/protocol';

type SkillItem = Extract<SharedCatalogItem, { kind: 'skill' }>;
type McpItem = Extract<SharedCatalogItem, { kind: 'mcp' }>;

const PLACEHOLDER = /^\$\{secret:([A-Za-z0-9_.-]+)\}$/u;
const PROJECT_VARIABLE = /^\$\{([A-Z_][A-Z0-9_]*)\}$/u;
/** A project install writes the person's own variable as `${NAME}`; the contract spells a filled value `${secret:NAME}`. */
const asPlaceholder = (text: string): string => {
  const variable = PROJECT_VARIABLE.exec(text)?.[1];
  return variable === undefined ? text : `\${secret:${variable}}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `item` with the files it has on disk now, at the version the install recorded. */
export function skillAsInstalled(item: SkillItem, version: number, files: ReadonlyMap<string, string>): SkillItem {
  return {
    ...item,
    itemVersion: version,
    skill: { ...item.skill, files: [...files].map(([path, content]) => ({ path, content })) },
  };
}

/** `item` with the server it has on disk now, at the version the install recorded. */
export const mcpAsInstalled = (item: McpItem, version: number, mcp: CatalogMcpSetup): McpItem => ({
  ...item,
  itemVersion: version,
  mcp,
});

const mappedEnv = (env: unknown): unknown =>
  isRecord(env)
    ? Object.fromEntries(
        Object.entries(env).map(([name, text]) => [name, typeof text === 'string' ? asPlaceholder(text) : text]),
      )
    : {};

/** A `.mcp.json` entry as the contract's setup, or `undefined` when it is not a shape an install writes. */
export function setupOfProjectEntry(entry: unknown): CatalogMcpSetup | undefined {
  if (!isRecord(entry)) return undefined;
  const candidate =
    entry.type === 'http'
      ? { transport: 'url', url: entry.url }
      : { transport: 'command', command: entry.command, args: entry.args ?? [], env: mappedEnv(entry.env) };
  const parsed = CatalogMcpSetupSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The setup with every value the installer filled in turned back into the placeholder it came from. `bindings`
 * is what the install recorded (placeholder → the person's variable or secret, or `null`); `offered` is the setup
 * being compared against, which settles a variable two placeholders were bound to, and which names a
 * placeholder the install left unbound (so it is on disk as nothing at all).
 */
export function withPlaceholders(
  setup: CatalogMcpSetup,
  offered: CatalogMcpSetup,
  bindings: CatalogSecretBindings,
): CatalogMcpSetup {
  if (setup.transport !== 'command') return setup;
  const wanted = offered.transport === 'command' ? offered.env : {};
  const env: Record<string, string> = {};
  for (const [name, text] of Object.entries(setup.env)) {
    const own = PLACEHOLDER.exec(text)?.[1];
    const candidates = Object.entries(bindings)
      .filter(([, target]) => own !== undefined && target === own)
      .map(([placeholder]) => placeholder)
      .toSorted();
    const used = PLACEHOLDER.exec(wanted[name] ?? '')?.[1];
    const placeholder = used !== undefined && candidates.includes(used) ? used : candidates[0];
    env[name] = placeholder === undefined ? text : `\${secret:${placeholder}}`;
  }
  for (const [name, text] of Object.entries(wanted)) {
    const placeholder = PLACEHOLDER.exec(text)?.[1];
    if (placeholder !== undefined && bindings[placeholder] === null && !Object.hasOwn(env, name)) env[name] = text;
  }
  return { ...setup, env };
}

const skillFileLabel = (path: string): string => `Skill file ${path}`;

/**
 * `changes` with the files that could not be read marked as what they are: too big (or not text) to show. A file
 * the offered version also has replaces the entry the diff drew for it; one it no longer has is added as removed.
 */
export function withUnreadableFiles(
  changes: CatalogChanges,
  unreadable: readonly string[],
  offered: SkillItem,
): CatalogChanges {
  const offeredPaths = new Set(offered.skill.files.map(file => file.path));
  const labels = new Set(unreadable.map(skillFileLabel));
  const kept = changes.entries.filter(entry => !labels.has(entry.label));
  const marked = unreadable.map(path => ({
    label: skillFileLabel(path),
    change: offeredPaths.has(path) ? ('changed' as const) : ('removed' as const),
    document: true,
    tooLarge: true as const,
  }));
  return { ...changes, entries: [...marked, ...kept] };
}
