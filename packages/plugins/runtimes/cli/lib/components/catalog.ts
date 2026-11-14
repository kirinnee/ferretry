/**
 * `fy components [kind]`: the components on this machine — instructions, MCP servers, skills, settings, hooks and model
 * sets — read from the files each plugin owns, over the kernel's config routes (v4's `fy components`, one list for every
 * kind). Showing, adding, changing and removing one is the verb of its kind (`fy mcp show`, `fy skill add`, …).
 */
import {
  configDocument,
  configFiles,
  namesIn,
  readConfigFile,
  type PluginClient,
  UsageIndex,
} from '@ferretry/kernel/manifest';

/** The kinds, in v4's order, with v4's words, and the folders that hold each. */
const COMPONENT_KINDS = [
  {
    kind: 'instructions',
    label: 'Instructions',
    description: 'Guidance every session reads first.',
    folders: ['instructions'],
  },
  { kind: 'mcp', label: 'MCP servers', description: 'Tools a session can call.', folders: ['mcp'] },
  { kind: 'skills', label: 'Skills', description: 'Named abilities a session can use.', folders: ['skills'] },
  {
    kind: 'settings',
    label: 'Settings',
    description: 'Flags, environment and options for one tool.',
    folders: ['claude-code/settings', 'codex/settings'],
  },
  {
    kind: 'hooks',
    label: 'Hooks',
    description: 'Commands that run at points in a session, for one tool.',
    folders: ['claude-code/hooks', 'codex/hooks'],
  },
  {
    kind: 'modelSets',
    label: 'Model sets',
    description: 'The models a runtime offers, and its default.',
    folders: ['model-sets'],
  },
] as const;

type ComponentKindName = (typeof COMPONENT_KINDS)[number]['kind'];

const SCOPE_WORDS = { generic: 'Generic', claude: 'Claude only', codex: 'Codex only' } as const;
type Scope = keyof typeof SCOPE_WORDS;

/** Which verb shows one of this kind, for the closing hint. */
const SHOW_VERBS: Readonly<Record<ComponentKindName, string>> = {
  instructions: 'instruction show <name>',
  mcp: 'mcp show <name>',
  skills: 'skill show <name>',
  settings: 'harness claude-code|codex settings show <name>',
  hooks: 'harness claude-code|codex hooks show <name>',
  modelSets: 'model-set show <name>',
};

interface ComponentRow {
  readonly reference: string;
  readonly kind: ComponentKindName;
  readonly name: string;
  readonly scope: Scope;
  readonly usedBy: { readonly profiles: readonly string[]; readonly runtimes: readonly string[] };
}

interface ComponentGroup {
  readonly kind: ComponentKindName;
  readonly label: string;
  readonly description: string;
  readonly components: readonly ComponentRow[];
}

/** The kind a person typed, or the sentence that says which there are. */
export function parseKind(word: string): { readonly kind: ComponentKindName } | { readonly refusal: string } {
  const found = COMPONENT_KINDS.find(entry => entry.kind === word);
  return found === undefined
    ? {
        refusal: `"${word}" is not a kind of component: use one of ${COMPONENT_KINDS.map(entry => entry.kind).join(', ')}.`,
      }
    : { kind: found.kind };
}

/** Every component of the kinds asked for, read live. */
export async function readComponents(
  client: Pick<PluginClient, 'call'>,
  only: ComponentKindName | undefined,
): Promise<readonly ComponentGroup[]> {
  const files = await configFiles(client);
  const index = await UsageIndex.load(client, files);
  const groups: ComponentGroup[] = [];
  for (const group of COMPONENT_KINDS) {
    if (only !== undefined && group.kind !== only) continue;
    const rows: ComponentRow[] = [];
    for (const folder of group.folders) {
      for (const name of namesIn(files, folder)) {
        const harness = folder.startsWith('claude-code/')
          ? 'claude-code'
          : folder.startsWith('codex/')
            ? 'codex'
            : (configDocument(await readConfigFile(client, `${folder}/${name}.yaml`)).harness as unknown);
        const reference = `${group.kind}/${name}`;
        rows.push({
          reference,
          kind: group.kind,
          name,
          scope: harness === 'claude-code' ? 'claude' : harness === 'codex' ? 'codex' : 'generic',
          usedBy: index.of(reference),
        });
      }
    }
    rows.sort((left, right) => left.name.localeCompare(right.name) || left.scope.localeCompare(right.scope));
    groups.push({ kind: group.kind, label: group.label, description: group.description, components: rows });
  }
  return groups;
}

/** One group per kind, a line per component. */
export function renderComponents(
  groups: readonly ComponentGroup[],
  binary: string,
  only: ComponentKindName | undefined,
): string {
  const lines: string[] = [];
  for (const group of groups) {
    lines.push(`${group.label} — ${group.description}`);
    if (group.components.length === 0) lines.push('  none yet');
    for (const component of group.components)
      lines.push(
        `  ${component.name}  (${SCOPE_WORDS[component.scope]})  used by ${String(component.usedBy.profiles.length)} profile(s)`,
      );
  }
  lines.push(
    '',
    only === undefined
      ? `Show one with the verb of its kind: ${binary} instruction|mcp|skill|model-set show <name>, or ${binary} harness claude-code|codex settings|hooks show <name>.`
      : `Show one with \`${binary} ${SHOW_VERBS[only]}\`.`,
  );
  return lines.join('\n');
}
