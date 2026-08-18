/**
 * What a host needs before it has a fleet at all.
 *
 * `fy fleet apply` reads a configuration and materializes it. On a machine that has never had one,
 * there is nothing to read: the fleet directory does not exist, the configuration does not exist,
 * and the assets directory a relative asset reference resolves into is never created by an apply.
 * The tool this replaces did not have to solve that — its directories, its assets and its `PATH`
 * entry were all placed by an external configuration manager. Ferretry has no such manager behind
 * it, so it owns the whole first-run story.
 *
 * Three decisions are worth stating, because each is a departure:
 *
 * - **Defaults ship with the product.** The tool this replaces copied its starting files from a
 *   directory that did not exist in its own source tree, so in practice it shipped nothing. Here the
 *   starting content is right below, which also gives it something that tool never had: a newer
 *   release can add a default without touching a file a person has since edited.
 * - **Nothing is ever overwritten.** Scaffolding is `create if absent`, so re-running it after an
 *   upgrade fills in what is new and leaves everything else exactly as found. That is what makes it
 *   safe to run on a machine that already has a fleet.
 * - **The `PATH` line is part of the output.** A command that creates a directory of executables and
 *   does not say how the shell will find them has not finished the job — an apply that writes
 *   wrappers nowhere on `PATH` reports success and produces nothing a person can run.
 *
 * Pure: this module decides *what* a fresh fleet contains. Writing it — and deciding what is already
 * there — is an adapter's job.
 */

import type { HarnessKind } from './manifest.ts';
import type { FleetLayout } from './provisioning.ts';

/** Directories the fleet owns are private: they hold credentials and generated executables. */
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/** One file a fresh fleet starts with. Written only when nothing is at `path` already. */
export interface FleetScaffoldFile {
  readonly path: string;
  readonly content: string;
  readonly mode: number;
  /**
   * Optional, narrow exception to create-if-absent for a declaration that is
   * valid but empty. Returning undefined keeps the existing bytes untouched.
   */
  readonly updateIfPresent?: (existing: string) => string | undefined;
}

/**
 * Preparation stopped part-way, and this is exactly what the host now carries.
 *
 * There is no undo: every file a scaffold writes is one that was absent, so removing them again
 * could not be distinguished from removing files somebody else had just created. The only honest
 * answer is to name what landed and where it stopped — and to say that running it again finishes
 * the job, because absence remains the kernel's decision on the second pass too.
 */
export class FleetScaffoldPartialError extends Error {
  constructor(
    readonly failedPath: string,
    readonly progress: {
      readonly created: readonly string[];
      readonly kept: readonly string[];
      readonly directories: readonly string[];
    },
    override readonly cause: unknown,
  ) {
    super(`preparing the fleet stopped at ${failedPath}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'FleetScaffoldPartialError';
  }
}

/** The complete first-run shape: directories to ensure, files to seed, and what to tell the shell. */
export interface FleetScaffold {
  /** Created in order. `mkdir -p` semantics: an existing directory is not an error. */
  readonly directories: readonly string[];
  readonly directoryMode: number;
  readonly files: readonly FleetScaffoldFile[];
  /** The configuration declaration this scaffold can add to an empty file. */
  readonly declaration?: { readonly path: string; readonly account: HarnessKind };
  /** The line a person must add to their shell profile for the generated wrappers to be runnable. */
  readonly pathEntry: string;
}

/**
 * Identifiers for the commented example in the starter configuration.
 *
 * Supplied rather than generated, because an account id is a UUID this module has no business
 * inventing — and because a scaffold has to be a value a test can assert on.
 */
export interface FleetScaffoldIds {
  readonly claude: string;
  readonly codex: string;
}

/**
 * The model a first account starts with, per harness.
 *
 * EXPORTED because a second consumer needs the same value: when a harness reports no model of its
 * own, the account form offers this one and says out loud that it is Ferretry's starter rather than
 * something the host declared. Two copies of a model identifier would drift the first time either
 * moved, and the drift would be invisible in the worst way — a form offering a model no scaffold
 * ever wrote, on an account that then claims to serve it.
 */
export const FLEET_STARTER_MODELS: Readonly<Record<HarnessKind, string>> = {
  claude: 'claude-opus-5',
  codex: 'gpt-5.6',
};

const starterAccount = (kind: HarnessKind, id: string): string => {
  const label = kind === 'claude' ? 'Claude' : 'Codex';
  const model = FLEET_STARTER_MODELS[kind];
  return `agents:
  - name: primary
    kind: ${kind}
    # "oauth" signs in through the provider; "api-key" has nothing to sign into.
    auth: oauth
    routes:
      default:
        id: ${id}
        wrapper: ${kind}-primary
        home: ${kind}-primary
        displayName: ${label} (primary)
        defaultModel: ${model}
        models:
          - ${model}`;
};

const configTemplate = (
  ids: FleetScaffoldIds,
  firstAccount: HarnessKind | undefined,
): string => `# The fleet: every agent account this host can run.
#
# Each account gets its own home, its own generated wrapper, and its own settings.
# Run "fy fleet apply" after editing, then "fy fleet ls" to see what was published.
#
# Nothing below is required. The file is valid as it stands and applies to an empty fleet.

# Shell file every generated wrapper sources before it runs, so that an environment
# value written as exactly "$NAME" resolves at launch instead of being baked into a
# generated script. Leave it out if you keep no secrets file.
# secretsFile: ~/.secrets

# Reusable bundles of settings. A profile named "base" is applied to every account
# before its own, which is the usual place for anything fleet-wide.
profiles:
  base:
    # These neutral Ferretry starters make a newly declared account usable.
    # Each path is relative to this fleet's assets directory. Edit those files,
    # or layer inline settings later in the composition chain to override them.
    memory: ./CLAUDE.md
    claude:
      settings: ./templates/claude/settings.json
    codex:
      settings: ./templates/codex/config.toml

# Lanes every account can be cloned into. "default" is the interactive lane;
# "auto" is for non-interactive work, and an account opts into it by declaring a
# route for it below.
variants:
  default: {}
  auto:
    mode: auto
    # The auto lane is Ferretry's unattended path. These harness flags keep a
    # session from stopping for permission input; Claude's remaining first-run
    # prompts are seeded safely by the generated wrapper itself.
    claude:
      flags:
        - --dangerously-skip-permissions
        - --disallowed-tools=AskUserQuestion
      settings:
        - skipDangerousModePermissionPrompt: true
    codex:
      flags:
        - --dangerously-bypass-approvals-and-sandbox
        - --no-alt-screen

${firstAccount === undefined ? 'agents: []' : starterAccount(firstAccount, ids[firstAccount])}

# ── Example ───────────────────────────────────────────────────────────────────
# ${
  firstAccount === undefined
    ? 'Delete the "agents: []" line above and uncomment this to declare one Claude'
    : 'This is a second Claude account with an interactive lane and an automation lane.'
}
# The ids below were generated for you; every account needs its own, and it must
# never change once anything has referenced it.
#
# agents:
#   - name: work
#     kind: claude
#     # "oauth" signs in through the provider; "api-key" has nothing to sign into.
#     auth: oauth
#     routes:
#       default:
#         id: ${ids.claude}
#         wrapper: claude-work
#         home: claude-work
#         displayName: Claude (work)
#         defaultModel: claude-opus-4-5
#         models:
#           - claude-opus-4-5
#           - claude-sonnet-4-5
#       auto:
#         id: ${ids.codex}
#         wrapper: claude-auto-work
#         home: claude-auto-work
#         displayName: Claude (work, automation)
#         defaultModel: claude-opus-4-5
#         models:
#           - claude-opus-4-5
#
# # A thin executable that runs one account's wrapper with flags prepended.
# commands: []
#
# # One alias fans out into a command for every account of each harness it lists.
# aliases: {}
#
# # The harness home the bare "claude" / "codex" command reads, named by account id.
# defaultHomes: {}
`;

const STARTER_INSTRUCTIONS = `# Ferretry starter instructions

This is the neutral shared guidance installed by \`fy fleet init\`. Claude receives
it as \`CLAUDE.md\`; Codex receives the same source as \`AGENTS.md\`.

Replace this file with your own global instructions when you are ready. Ferretry
will not overwrite it on a later init or upgrade. Repository-local instructions
may add to or refine this starting point.

- Follow the repository's contributor and agent instructions.
- Keep changes scoped to the requested task and preserve unrelated work.
- Run the repository's relevant checks before reporting that work is complete.
`;

/** Claude accepts JSON only, so `$schema` is its in-file editing guidance. */
const CLAUDE_SETTINGS = `{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "includeCoAuthoredBy": false
}
`;

const CODEX_SETTINGS = `# Ferretry's neutral Codex base settings.
# Add shared settings here or replace this file; fy fleet init never overwrites it.
# Model, approval, sandbox and tool policy are deliberately left to each account/lane.
`;

const ASSETS_README = `# Fleet assets

Anything a fleet account runs *with* lives here: memory files, skills directories,
base settings, hooks and MCP server lists.

A configuration references an asset by path. A relative path resolves inside this
directory, so \`memory: ./memory/CLAUDE.md\` means the file beside this README. A
path beginning \`~/\` or \`$HOME/\` resolves against your home directory, and an
absolute path is used as written.

## Included starters

- \`CLAUDE.md\` is concise shared guidance. The base profile materializes it as
  Claude's \`CLAUDE.md\` and Codex's \`AGENTS.md\`.
- \`templates/claude/settings.json\` is the neutral Claude settings layer.
- \`templates/codex/config.toml\` is an intentionally policy-free Codex layer.

No hooks, MCP servers or skills are installed by default. Those execute code or
encode workflow preferences, so add only the ones you have chosen and reviewed.

## How overriding works

\`settings\` is layered. A layer is either a **file path** — a shared base you keep
here — or an **object of overrides** written inline in the configuration. Layers
accumulate through the composition chain (base profile, the agent's profiles, the
variant's profiles, the variant's own fields, the agent's own fields) and are
deep-merged left to right, so a later layer wins key by key. Arrays replace rather
than append, because a list such as \`permissions.allow\` is a complete statement and
an override has to be able to remove from it.

Every other asset field is a single path, and the last writer in that chain wins.

## What is safe to edit

All of it. \`fy fleet init\` only ever creates what is missing, so nothing here is
overwritten by re-running it or by upgrading — including this file. If you want a
newer default, delete your copy and run \`fy fleet init\` again.

Files are materialized into each account's home when you run \`fy fleet apply\`.
Account-home assets are copies, not symlinks: editing a source here takes effect on
the next apply. Settings are merged into a real file because each harness may also
rewrite its settings at runtime.
`;

export interface FleetScaffoldInput {
  readonly layout: FleetLayout;
  readonly ids: FleetScaffoldIds;
  /**
   * Where to write the starter configuration.
   *
   * Supplied, not derived: the caller already decides which file `fy fleet apply` reads, and a
   * second notion of that here would let init seed a configuration apply never looks at.
   */
  readonly configPath: string;
  /** A single account to declare in a newly-created starter; absent keeps the file-first empty fleet. */
  readonly firstAccount?: HarnessKind;
}

/**
 * Adds the generated starter account to a configuration that explicitly has
 * no accounts, without normalising the rest of the person's YAML.
 *
 * The initial starter uses `agents: []`, so that common path is a one-line
 * substitution which preserves every surrounding comment and section. An
 * omitted `agents` key is also an empty declaration under the configuration
 * schema; append a new root key in that case. Any other zero-looking shape is
 * refused rather than guessed at: damaged state is not an empty fleet.
 */
function declareFirstAccountInEmptyConfig(
  existing: string,
  kind: HarnessKind,
  ids: FleetScaffoldIds,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(existing) ?? {};
  } catch (error) {
    throw new Error(
      `cannot add a first account because the existing configuration is not valid YAML: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('cannot add a first account because the existing configuration is not a YAML mapping');
  }
  const agents = (parsed as Record<string, unknown>).agents;
  if (agents === undefined) return `${existing.replace(/\s*$/u, '')}\n\n${starterAccount(kind, ids[kind])}\n`;
  if (!Array.isArray(agents)) {
    throw new Error('cannot add a first account because the existing configuration has a non-list "agents" value');
  }
  if (agents.length > 0) return undefined;

  const replacement = starterAccount(kind, ids[kind]);
  const updated = existing.replace(/^agents\s*:\s*\[\s*\](\s*(?:#.*)?)$/mu, (_line, comment: string) => {
    return `${replacement.slice(0, 'agents:'.length)}${comment}${replacement.slice('agents:'.length)}`;
  });
  if (updated === existing) {
    throw new Error(
      'cannot add a first account because the empty "agents" declaration has a structure Ferretry cannot safely edit',
    );
  }
  return updated;
}

/**
 * Everything a fresh fleet starts with, as a value.
 *
 * The directories include the assets directory, which provisioning does not create — a relative
 * asset reference used to resolve into a path nothing had made.
 */
export function buildFleetScaffold(input: FleetScaffoldInput): FleetScaffold {
  const { layout, ids, configPath, firstAccount } = input;
  const separator = layout.assetsDirectory.endsWith('/') ? '' : '/';
  const assetPath = (name: string): string => `${layout.assetsDirectory}${separator}${name}`;
  return {
    directories: [
      layout.fleetDirectory,
      layout.binDirectory,
      layout.homesDirectory,
      layout.assetsDirectory,
      assetPath('templates'),
      assetPath('templates/claude'),
      assetPath('templates/codex'),
    ],
    directoryMode: DIRECTORY_MODE,
    files: [
      {
        path: configPath,
        content: configTemplate(ids, firstAccount),
        mode: FILE_MODE,
        ...(firstAccount === undefined
          ? {}
          : { updateIfPresent: (existing: string) => declareFirstAccountInEmptyConfig(existing, firstAccount, ids) }),
      },
      { path: assetPath('README.md'), content: ASSETS_README, mode: FILE_MODE },
      { path: assetPath('CLAUDE.md'), content: STARTER_INSTRUCTIONS, mode: FILE_MODE },
      { path: assetPath('templates/claude/settings.json'), content: CLAUDE_SETTINGS, mode: FILE_MODE },
      { path: assetPath('templates/codex/config.toml'), content: CODEX_SETTINGS, mode: FILE_MODE },
    ],
    ...(firstAccount === undefined ? {} : { declaration: { path: configPath, account: firstAccount } }),
    pathEntry: `export PATH="${layout.binDirectory}:$PATH"`,
  };
}

/** What scaffolding did. `kept` is the interesting half on a host that already had a fleet. */
export interface FleetScaffoldResult {
  /** Files written because nothing was there. */
  readonly created: readonly string[];
  /** Files left exactly as found. */
  readonly kept: readonly string[];
  /** Existing declarations that were safely extended rather than replaced. */
  readonly updated: readonly string[];
  /** Present only when this run actually declared the requested first account. */
  readonly declaredFirstAccount?: HarnessKind;
  /** Directories ensured, whether or not they already existed. */
  readonly directories: readonly string[];
  readonly pathEntry: string;
}

export interface FleetScaffolder {
  scaffold(scaffold: FleetScaffold): Promise<FleetScaffoldResult>;
}
