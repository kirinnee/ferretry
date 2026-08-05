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
import type { FleetLayout } from './provisioning.ts';

/** Directories the fleet owns are private: they hold credentials and generated executables. */
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/** One file a fresh fleet starts with. Written only when nothing is at `path` already. */
export interface FleetScaffoldFile {
  readonly path: string;
  readonly content: string;
  readonly mode: number;
}

/** The complete first-run shape: directories to ensure, files to seed, and what to tell the shell. */
export interface FleetScaffold {
  /** Created in order. `mkdir -p` semantics: an existing directory is not an error. */
  readonly directories: readonly string[];
  readonly directoryMode: number;
  readonly files: readonly FleetScaffoldFile[];
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

const configTemplate = (ids: FleetScaffoldIds): string => `# The fleet: every agent account this host can run.
#
# Each account gets its own home, its own generated wrapper, and its own settings.
# Run "fy fleet apply" after editing, then "fy fleet ls" to see what was published.
#
# Nothing below is required. The file is valid as it stands and applies to an empty
# fleet; uncomment the example and edit it to declare your first account.

# Shell file every generated wrapper sources before it runs, so that an environment
# value written as exactly "$NAME" resolves at launch instead of being baked into a
# generated script. Leave it out if you keep no secrets file.
# secretsFile: ~/.secrets

# Reusable bundles of settings. A profile named "base" is applied to every account
# before its own, which is the usual place for anything fleet-wide.
profiles:
  base:
    # A settings layer is either a path to a file (relative paths resolve inside
    # this fleet's assets directory) or an object of overrides merged on top.
    # Layers accumulate left to right; the last one wins.
    settings:
      - includeCoAuthoredBy: false

# Lanes every account can be cloned into. "default" is the interactive lane;
# "auto" is for non-interactive work, and an account opts into it by declaring a
# route for it below.
variants:
  default: {}
  auto:
    mode: auto

agents: []

# ── Example ───────────────────────────────────────────────────────────────────
# Delete the "agents: []" line above and uncomment this to declare one Claude
# account with an interactive lane and an automation lane. The ids below were
# generated for you; every account needs its own, and it must never change once
# anything has referenced it.
#
# agents:
#   - name: work
#     kind: claude
#     # "oauth" signs in through the provider; "api-key" has nothing to sign into.
#     auth: oauth
#     routes:
#       default:
#         id: ${ids.claude}
#         wrapper: fy-claude-work
#         home: ~/.claude-work
#         displayName: Claude (work)
#         defaultModel: claude-opus-4-5
#         models:
#           - claude-opus-4-5
#           - claude-sonnet-4-5
#       auto:
#         id: ${ids.codex}
#         wrapper: fy-claude-work-auto
#         home: ~/.claude-work-auto
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

const ASSETS_README = `# Fleet assets

Anything a fleet account runs *with* lives here: memory files, skills directories,
base settings, hooks and MCP server lists.

A configuration references an asset by path. A relative path resolves inside this
directory, so \`memory: ./memory/CLAUDE.md\` means the file beside this README. A
path beginning \`~/\` or \`$HOME/\` resolves against your home directory, and an
absolute path is used as written.

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
Most are symlinked, so editing the file here is live. Settings are copied instead,
because the harness rewrites that file itself at runtime.
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
}

/**
 * Everything a fresh fleet starts with, as a value.
 *
 * The directories include the assets directory, which provisioning does not create — a relative
 * asset reference used to resolve into a path nothing had made.
 */
export function buildFleetScaffold(input: FleetScaffoldInput): FleetScaffold {
  const { layout, ids, configPath } = input;
  const separator = layout.assetsDirectory.endsWith('/') ? '' : '/';
  return {
    directories: [layout.fleetDirectory, layout.binDirectory, layout.homesDirectory, layout.assetsDirectory],
    directoryMode: DIRECTORY_MODE,
    files: [
      { path: configPath, content: configTemplate(ids), mode: FILE_MODE },
      { path: `${layout.assetsDirectory}${separator}README.md`, content: ASSETS_README, mode: FILE_MODE },
    ],
    pathEntry: `export PATH="${layout.binDirectory}:$PATH"`,
  };
}

/** What scaffolding did. `kept` is the interesting half on a host that already had a fleet. */
export interface FleetScaffoldResult {
  /** Files written because nothing was there. */
  readonly created: readonly string[];
  /** Files left exactly as found. */
  readonly kept: readonly string[];
  /** Directories ensured, whether or not they already existed. */
  readonly directories: readonly string[];
  readonly pathEntry: string;
}

export interface FleetScaffolder {
  scaffold(scaffold: FleetScaffold): Promise<FleetScaffoldResult>;
}
