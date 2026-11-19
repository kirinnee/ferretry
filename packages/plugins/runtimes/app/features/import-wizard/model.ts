/**
 * What the import wizard shows for one tool, derived from the daemon's scan (`GET /v1/runtimes/setup/scan`) and the tool's own
 * update read (its installed version). Pure: no client, no React. The scan carries NAMES only, so nothing here can hold a value.
 *
 * What the person leaves out is a SET OF ITEM IDS (`claude-code:mcp:notes`): the wizard sends it as `setup.import` `skip`, so
 * the daemon leaves each out of the plan and everything only it would have brought.
 */
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import { z } from 'zod';
import {
  type HarnessScan,
  ImportItemIdSchema,
  type ImportItemId,
  importItemId,
  importNamedItemId,
  type SetupScan,
  type ToolInstallPlan,
  type AccountChange,
} from '../../../contract/index.ts';
import { becomes, GITHUB_TOKEN_NAMES, HARNESS_LABEL } from './mapping-words.ts';

export const HARNESSES: readonly HarnessKey[] = ['claude-code', 'codex'];

/** The part of each tool's own update read the header reads: the installed version, nothing else. */
const InstalledVersionReadSchema = z.looseObject({
  installed: z.union([
    z.looseObject({ state: z.literal('ok'), version: z.string().min(1) }),
    z.looseObject({ state: z.string() }),
    z.null(),
  ]),
});

export const versionOf = (answer: unknown): string | null => {
  const read = InstalledVersionReadSchema.safeParse(answer);
  if (!read.success || read.data.installed === null) return null;
  const installed = read.data.installed as { state: string; version?: string };
  return installed.state === 'ok' && installed.version !== undefined ? installed.version : null;
};

/** One thing the person can take or leave. */
export interface FoundItem {
  /** The id sent in `skip`; null when the host's name cannot be written as one (it is imported with the rest). */
  readonly id: ImportItemId | null;
  readonly label: string;
  readonly becomes: string;
}

type GroupKey = 'instructions' | 'mcp' | 'skill' | 'settings' | 'env' | 'profile';

export interface FoundGroup {
  readonly key: GroupKey;
  readonly title: string;
  readonly items: readonly FoundItem[];
  /** Secret-looking key names the group moves into the Vault (the environment only). */
  readonly locked?: readonly string[];
  /** Of those, the GitHub-token variables: each is its own choice, unticked until the person ticks it. */
  readonly githubTokens?: readonly string[];
}

/** One earlier import whose source changed (`SetupScan.updates`): a component's reference and where it is read from. */
export interface UpdateItem {
  readonly reference: string;
  readonly sources: readonly string[];
}

/** What the wizard says it does NOT take, as fixed lines. */
export interface LeftAlone {
  readonly hooks: number;
  readonly projectFolders: number;
}

type ToolStage = 'not-installed' | 'needs-sign-in' | 'ready';

export interface ToolModel {
  readonly harness: HarnessKey;
  readonly label: string;
  readonly installed: boolean;
  readonly version: string | null;
  readonly stage: ToolStage;
  readonly email: string | null;
  readonly install: ToolInstallPlan | null;
  readonly groups: readonly FoundGroup[];
  readonly leftAlone: LeftAlone;
  /** The runtime name the import suggests. */
  readonly suggestedName: string;
  /** A runtime already uses this login and profile (it is not added again). */
  readonly duplicateOf: string | null;
  readonly problems: readonly string[];
  /** Nothing found to bring: the tool can still get a runtime. */
  readonly empty: boolean;
  /** Things brought in before whose host source has changed since: each is taken again only when ticked (the default). */
  readonly updates: readonly UpdateItem[];
}

const SIGNED_IN = new Set(['signed-in', 'refresh-due']);

const secretName = (key: string): string => key.replace(/^env\./u, '');

const itemId = (id: () => string): ImportItemId | null => {
  const parsed = ImportItemIdSchema.safeParse(id());
  return parsed.success ? parsed.data : null;
};

const groupsOf = (harness: HarnessKey, scan: HarnessScan): readonly FoundGroup[] => {
  const groups: FoundGroup[] = [];
  if (scan.instructions !== undefined)
    groups.push({
      key: 'instructions',
      title: 'Instructions',
      items: [
        {
          id: importItemId(harness, 'instructions'),
          label: scan.instructions.name,
          becomes: becomes(harness, 'instructions'),
        },
      ],
    });
  if (scan.mcpServers.length > 0)
    groups.push({
      key: 'mcp',
      title: 'MCP servers',
      items: scan.mcpServers.map(name => ({
        id: itemId(() => importNamedItemId(harness, 'mcp', name)),
        label: name,
        becomes: becomes(harness, 'mcp'),
      })),
    });
  if (scan.skills.length > 0)
    groups.push({
      key: 'skill',
      title: 'Skills',
      items: scan.skills.map(name => ({
        id: itemId(() => importNamedItemId(harness, 'skill', name)),
        label: name,
        becomes: becomes(harness, 'skill'),
      })),
    });
  if (scan.settings !== undefined && scan.settings.count > 0)
    groups.push({
      key: 'settings',
      title: 'Settings',
      items: [
        {
          id: importItemId(harness, 'settings'),
          label: `Settings (${String(scan.settings.count)} key${scan.settings.count === 1 ? '' : 's'})`,
          becomes: becomes(harness, 'settings'),
        },
      ],
    });
  const secrets = scan.secretKeys.map(secretName);
  const others = secrets.filter(name => !GITHUB_TOKEN_NAMES.includes(name));
  if (secrets.length > 0)
    groups.push({
      key: 'env',
      title: 'Environment',
      // Only GitHub tokens: each is its own choice below, so there is no whole-environment box to draw.
      items:
        others.length === 0
          ? []
          : [
              {
                id: importItemId(harness, 'env'),
                label: `Environment keys (${String(others.length)})`,
                becomes: becomes(harness, 'env'),
              },
            ],
      locked: others,
      githubTokens: secrets.filter(name => GITHUB_TOKEN_NAMES.includes(name)),
    });
  const profiles = scan.codexProfiles ?? [];
  if (profiles.length > 0)
    groups.push({
      key: 'profile',
      title: 'Codex profiles',
      items: profiles.map(profile => ({
        id: itemId(() => importNamedItemId(harness, 'profile', profile.name)),
        label: [profile.name, profile.model, profile.effort].filter(part => part !== undefined).join(' · '),
        becomes: becomes(harness, 'profile'),
      })),
    });
  return groups;
};

/** The model for one tool. A tool the scan did not list reads as not installed. */
export function toolModel(harness: HarnessKey, scan: SetupScan, version: string | null): ToolModel {
  const found = scan.harnesses.find(entry => entry.harness === harness);
  const tool = scan.tools.find(entry => entry.harness === harness);
  const installed = found?.installed ?? tool?.installed ?? false;
  const signedIn = found !== undefined && SIGNED_IN.has(found.account.state);
  const groups = found === undefined ? [] : groupsOf(harness, found);
  // An update belongs to the tool whose own files it is read from (the scan names each source by its path).
  const home = harness === 'claude-code' ? '.claude' : '.codex';
  const ownSources = [found?.instructions?.source, found?.settings?.source];
  const updates = scan.updates
    .filter(update => update.sources.some(source => ownSources.includes(source) || source.includes(home)))
    .map(update => ({ reference: update.reference, sources: [...update.sources] }));
  const suggested = scan.runtimes.find(entry => entry.harness === harness)?.name;
  return {
    harness,
    label: HARNESS_LABEL[harness],
    installed,
    version,
    stage: !installed ? 'not-installed' : signedIn ? 'ready' : 'needs-sign-in',
    email: found?.account.email ?? null,
    install: tool !== undefined && !tool.installed ? tool.install : null,
    groups,
    leftAlone: { hooks: found?.settings?.hooks ?? 0, projectFolders: found?.projectInstructions?.length ?? 0 },
    suggestedName: suggested ?? `${harness}-default`,
    duplicateOf: scan.duplicates.find(entry => entry.harness === harness)?.existing ?? null,
    problems: found?.problems ?? [],
    empty: groups.length === 0 && updates.length === 0,
    updates,
  };
}

/** Every id the person can tick on this tool. */
export const itemIds = (model: ToolModel): readonly ImportItemId[] =>
  model.groups.flatMap(group => group.items.flatMap(item => (item.id === null ? [] : [item.id])));

/** Unticked ids, in the order the screen lists them, for `skip`. Only ids this tool offers are sent. */
export const skipList = (model: ToolModel, left: ReadonlySet<ImportItemId>): readonly ImportItemId[] =>
  itemIds(model).filter(id => left.has(id));

/** A runtime name the daemon would take: not empty, not longer than 200. */
export const nameProblem = (name: string): string | null => {
  const text = name.trim();
  if (text === '') return 'Give the runtime a name.';
  if (text.length > 200) return 'That name is too long.';
  return null;
};

/** The `setup.import` change for one tool. */
export function importChange(
  model: ToolModel,
  left: ReadonlySet<ImportItemId>,
  name: string,
  ticked: ReadonlySet<string> = new Set(),
  declined: ReadonlySet<string> = new Set(),
): AccountChange {
  // Every changed source is taken again unless the person unticked it.
  const acceptedUpdates = model.updates.map(update => update.reference).filter(reference => !declined.has(reference));
  const skip = skipList(model, left);
  const env = model.groups.find(group => group.key === 'env');
  // Only a token variable this scan lists, and only while the environment itself is being brought.
  const tickedEnv = (env?.githubTokens ?? []).filter(token => ticked.has(token) && !left.has(`${model.harness}:env`));
  return {
    kind: 'setup.import',
    include: [model.harness],
    names: { [model.harness]: name.trim() },
    ...(skip.length === 0 ? {} : { skip: [...skip] }),
    ...(tickedEnv.length === 0 ? {} : { tickedEnv }),
    ...(acceptedUpdates.length === 0 ? {} : { acceptedUpdates }),
  };
}

/** How many things will be imported / left out, for the button's own sentence. */
export const counts = (
  model: ToolModel,
  left: ReadonlySet<ImportItemId>,
): { readonly taken: number; readonly left: number } => {
  const all = model.groups.flatMap(group => group.items);
  const out = all.filter(item => item.id !== null && left.has(item.id)).length;
  return { taken: all.length - out, left: out };
};

/** The old onboarding steps a finished tool settles: its harness step, the sign-in and the runtimes. */
export const stepsSettledBy = (
  harness: HarnessKey,
): readonly {
  readonly plugin: string;
  readonly stepId: string;
  readonly state: 'found' | 'done';
  readonly linked?: true;
}[] => [
  { plugin: harness, stepId: 'harness', state: 'found', linked: true },
  { plugin: 'logins', stepId: 'login', state: 'found', linked: true },
  { plugin: 'runtimes', stepId: 'runtimes', state: 'done' },
];

/** The apply's `summary`, as the sentences it is made of (A3 names each file written and each refused). */
export const resultSentences = (summary: string): readonly string[] =>
  summary
    .split(/(?<=\.)\s+/u)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence !== '');
