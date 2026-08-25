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
 *   wrappers nowhere on `PATH` reports success and produces nothing a *person* can type. It is not
 *   what a daemon needs: the manifest publishes each wrapper's absolute path and a start launches
 *   that, so a session works before anybody has edited a shell profile.
 *
 * WHAT IT DECLARES has since widened from "an empty fleet" to "the accounts a detected harness
 * earns", because a starter configuration with no accounts in it was setup somebody had to finish
 * before anything worked at all. The names come from {@link module:defaults} rather than from here,
 * so the boot trail that reports what it created and the file that declares it read one table.
 *
 * Pure: this module decides *what* a fresh fleet contains. Writing it — and deciding what is already
 * there — is an adapter's job.
 */

import {
  DEFAULT_ACCOUNT_NAME,
  DEFAULT_INSTRUCTIONS,
  defaultAccountsFor,
  defaultInstructionsName,
  FLEET_DEFAULT_LANES,
  type FleetDefaultAccount,
  type FleetDefaultLane,
  HARNESS_LABEL,
} from './defaults.ts';
import type { HarnessKind } from './manifest.ts';
import { canonicalAssetReference } from './paths.ts';
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
  /**
   * The configuration declaration this scaffold can add to an empty file.
   *
   * A SET of harnesses rather than one, because "the accounts a detected harness earns" is what is
   * declared now and a host may have both installed. One-harness spelling is a one-element set, so
   * there is a single shape rather than a special case for the command-line flag that names one.
   */
  readonly declaration?: { readonly path: string; readonly accounts: readonly HarnessKind[] };
  /** The line a person must add to their shell profile for the generated wrappers to be runnable. */
  readonly pathEntry: string;
}

/**
 * Identifiers for the accounts a starter configuration declares, one per (harness × lane).
 *
 * ONE PER LANE, not one per harness. A default account occupies two lanes — the interactive one and
 * the unattended one — and an account id must never change once anything has referenced it, so two
 * lanes sharing one id would be two accounts the manifest could not tell apart. The previous shape
 * had exactly that defect in miniature: its commented example spent the *codex* id on a claude
 * account's `auto` route because there was no third identifier to spend.
 *
 * Supplied rather than generated, because an account id is a UUID this module has no business
 * inventing — and because a scaffold has to be a value a test can assert on.
 */
export interface FleetScaffoldIds {
  /** One per (harness × lane), for the accounts this scaffold actually declares. */
  readonly accounts: Readonly<Record<HarnessKind, Readonly<Record<FleetDefaultLane, string>>>>;
  /**
   * Two more, for the commented example, because an example is a thing somebody UNCOMMENTS.
   *
   * It used to print the ids already spent on the declared Claude account above it, so following the
   * one instruction the file gives — "uncomment this to declare one" — produced a configuration that
   * refused to parse on a duplicate id, in the first file a new person opens. The example is not a
   * decoration; it has to be valid the moment the `#` comes off.
   */
  readonly example: Readonly<Record<FleetDefaultLane, string>>;
}

/**
 * Every identifier a starter configuration prints, from one mint.
 *
 * Declared here so no caller hand-builds the nested shape: four call sites each spelling the same
 * two-level literal is four chances to reuse an id across lanes, and a reused account id is the one
 * mistake this table exists to make impossible.
 */
export function fleetScaffoldIds(mint: () => string): FleetScaffoldIds {
  const lanes = (): Readonly<Record<FleetDefaultLane, string>> =>
    Object.fromEntries(FLEET_DEFAULT_LANES.map(lane => [lane, mint()])) as Record<FleetDefaultLane, string>;
  return { accounts: { claude: lanes(), codex: lanes() }, example: lanes() };
}

/** One declared lane of a starter account, at the indentation a route sits under `routes:`. */
const starterRoute = (account: FleetDefaultAccount, id: string): string => `      ${account.lane}:
        id: ${id}
        wrapper: ${account.wrapper}
        home: ${account.home}
        displayName: "${account.displayName}"
        defaultModel: ${account.defaultModel}
        models:
          - ${account.defaultModel}`;

/**
 * One agent per detected harness, with every default lane declared as a route on it.
 *
 * ONE AGENT AND TWO ROUTES, never two agents. The lanes share a provider login, which is what
 * `identity` was built for, so signing in once makes both usable; two agents would ask a person to
 * do the same sign-in twice. Every name here comes from {@link defaultAccountsFor} rather than being
 * re-derived, because the boot trail that tells somebody what was created reads the same function.
 */
const starterAgents = (
  harnesses: readonly HarnessKind[],
  ids: FleetScaffoldIds,
  /**
   * The lanes this configuration actually has variants for.
   *
   * PASSED IN rather than assumed, because a route names a variant and the configuration schema
   * refuses one that is not declared. The template below declares both, so the fresh-file path always
   * gets both; a configuration somebody else wrote may declare only `default`, and declaring an `auto`
   * route into it would turn their valid empty fleet into a file that no longer parses.
   */
  lanes: readonly FleetDefaultLane[] = FLEET_DEFAULT_LANES,
): string => {
  const accounts = defaultAccountsFor(harnesses).filter(account => lanes.includes(account.lane));
  const kinds = (['claude', 'codex'] as const).filter(kind => accounts.some(account => account.kind === kind));
  const agent = (kind: HarnessKind): string => `  - name: ${DEFAULT_ACCOUNT_NAME}
    kind: ${kind}
    # "oauth" signs in through the provider; "api-key" has nothing to sign into.
    auth: oauth
    routes:
${accounts
  .filter(account => account.kind === kind)
  .map(account => starterRoute(account, ids.accounts[kind][account.lane]))
  .join('\n')}`;
  return `agents:\n${kinds.map(agent).join('\n')}`;
};

/**
 * The shared registry lines for the four default instruction documents.
 *
 * FOUR NAMES rather than the one `default` this used to register. A single shared document forced
 * Codex to read a file whose own text said it was Claude's, and forced an unattended account to read
 * guidance written for one that can ask a question. Both the names and the paths come from
 * {@link DEFAULT_INSTRUCTIONS} and {@link defaultInstructionsName}, so a registry entry can never
 * name a path the writer below does not create.
 */
const sharedInstructions = (): string =>
  (['claude', 'codex'] as const)
    .flatMap(kind =>
      FLEET_DEFAULT_LANES.map(
        lane => `    ${defaultInstructionsName(kind, lane)}: ${DEFAULT_INSTRUCTIONS[kind][lane]}`,
      ),
    )
    .join('\n');

const configTemplate = (
  ids: FleetScaffoldIds,
  firstAccounts: readonly HarnessKind[],
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

# The documents this fleet shares, by name. Declaring one here does not link any
# account to it — it gives the path a name, so a surface can offer it, say how many
# accounts use it, and switch one account between the shared document and its own
# copy. There are four, because each harness reads a document named after itself and
# an unattended lane needs different guidance from an attended one.
#
# An account that references one of these gets the SAME FILE in its home, not a copy
# of it: editing the document below changes every account that references it, with no
# apply in between. "settings" is the exception — a stack of layers is merged into one
# generated file, because a merge cannot be the same file as any of its sources.
shared:
  memory:
${sharedInstructions()}
  settings:
    claude: ./templates/claude/settings.json
    codex: ./templates/codex/config.toml

# Reusable bundles of settings. A profile named "base" is applied to every account
# before its own, which is the usual place for anything fleet-wide. The base profile
# is what makes the shared documents above the default for every account.
profiles:
  base:
    # These neutral Ferretry starters make a newly declared account usable.
    # Each path is relative to this fleet's assets directory. Edit those files,
    # or layer inline settings later in the composition chain to override them.
    #
    # "memory" is declared per harness rather than once: Claude reads its document
    # as CLAUDE.md and Codex reads its own as AGENTS.md, so one shared source would
    # give Codex a file whose own text says it belongs to Claude.
    claude:
      memory: ${DEFAULT_INSTRUCTIONS.claude.default}
      settings: ./templates/claude/settings.json
    codex:
      memory: ${DEFAULT_INSTRUCTIONS.codex.default}
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
    #
    # A variant is applied AFTER the base profile, so the "-auto" document below
    # replaces the base one for this lane only.
    claude:
      memory: ${DEFAULT_INSTRUCTIONS.claude.auto}
      flags:
        - --dangerously-skip-permissions
        - --disallowed-tools=AskUserQuestion
      settings:
        - skipDangerousModePermissionPrompt: true
    codex:
      memory: ${DEFAULT_INSTRUCTIONS.codex.auto}
      flags:
        - --dangerously-bypass-approvals-and-sandbox
        - --no-alt-screen

${firstAccounts.length === 0 ? 'agents: []' : starterAgents(firstAccounts, ids)}

# ── Example ───────────────────────────────────────────────────────────────────
# ${
  firstAccounts.length === 0
    ? 'Delete the "agents: []" line above and uncomment this to declare one Claude'
    : 'This is a second Claude account with an interactive lane and an automation lane.'
}
# The ids below were generated for you and are used nowhere else in this file, so
# uncommenting it as it stands is valid. Every account needs its own, and an id must
# never change once anything has referenced it.
#
# An account may serve SEVERAL models and names one of them as its default. Write a
# model as a bare identifier, or as an entry when you want to give it a name a person
# reads — or to take it out of service, which needs a reason nobody has to guess at.
# An unavailable model is never offered and never routed to, and "fy fleet ls" prints
# it with the reason you gave.
#
# agents:
#   - name: work
#     kind: claude
#     # "oauth" signs in through the provider; "api-key" has nothing to sign into.
#     auth: oauth
#     routes:
#       default:
#         id: ${ids.example.default}
#         wrapper: claude-work
#         home: claude-work
#         displayName: Claude (work)
#         defaultModel: claude-opus-4-5
#         models:
#           - claude-opus-4-5
#           - id: claude-sonnet-4-5
#             displayName: Sonnet 4.5
#           - id: claude-haiku-4-5
#             available: false
#             unavailableReason: this subscription does not include Haiku
#       auto:
#         id: ${ids.example.auto}
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

const attendedInstructions = (kind: HarnessKind): string => `# Ferretry starter instructions

Neutral guidance installed with this fleet. Every ${HARNESS_LABEL[kind]} account that has not been
pointed at something else reads it, as \`${kind === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'}\` in its own home.

Replace it with your own global instructions when you are ready. Ferretry creates
this file only when it is absent and never overwrites it, so a later init or
upgrade leaves your edits alone. Repository-local instructions may add to or
refine this starting point.

- Follow the repository's own contributor and agent instructions first.
- Keep changes scoped to what was asked and preserve unrelated work.
- Run the repository's relevant checks before reporting that work is complete.
- Say what you did, and say what you did not do.
`;

/**
 * The unattended lane's document.
 *
 * A SEPARATE DOCUMENT rather than a paragraph in the one above, because the advice inverts: "ask
 * before you do something ambiguous" is right for somebody sitting at a terminal and is a deadlock
 * for a run nobody is watching. An agent that cannot be asked has to be told so.
 */
const unattendedInstructions = (kind: HarnessKind): string => `# Ferretry starter instructions — unattended

Neutral guidance installed with this fleet, for a ${HARNESS_LABEL[kind]} account that runs with
nobody watching. Replace it with your own when you are ready; Ferretry creates this
file only when it is absent and never overwrites it.

Nobody is there to answer a question, so this lane differs from the attended one:

- Never wait for input. Choose the most reasonable option and write down the
  assumption you made.
- Prefer a smaller reversible step over a larger irreversible one.
- Keep changes scoped to what was asked and preserve unrelated work.
- Run the repository's relevant checks before claiming the work is complete.
- Report what was done AND what was not, including anything skipped and why.
- When a choice cannot be made safely, stop and report it rather than guess.
`;

/**
 * The four documents a fresh fleet ships, keyed exactly as {@link DEFAULT_INSTRUCTIONS} keys their
 * paths — so a path the configuration points at and the content written to it cannot disagree.
 */
const INSTRUCTION_DOCUMENTS: Readonly<Record<HarnessKind, Readonly<Record<FleetDefaultLane, string>>>> = {
  claude: { default: attendedInstructions('claude'), auto: unattendedInstructions('claude') },
  codex: { default: attendedInstructions('codex'), auto: unattendedInstructions('codex') },
};

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

- \`${DEFAULT_INSTRUCTIONS.claude.default}\` and \`${DEFAULT_INSTRUCTIONS.codex.default}\` are concise
  shared guidance, one per harness. The base profile points each harness at its own,
  and both land in an account's home under the name that harness reads.
- \`${DEFAULT_INSTRUCTIONS.claude.auto}\` and \`${DEFAULT_INSTRUCTIONS.codex.auto}\` are the same thing for
  the \`auto\` lane. An unattended agent cannot ask a question, so it is given
  different advice rather than the same advice with a caveat.
- \`templates/claude/settings.json\` is the neutral Claude settings layer.
- \`templates/codex/config.toml\` is an intentionally policy-free Codex layer.

No hooks, MCP servers or skills are installed by default. Those execute code or
encode workflow preferences, so add only the ones you have chosen and reviewed.

## Shared documents

The \`shared:\` block in \`config.yaml\` gives a name to each document the fleet offers
to every account — the four instruction documents above are registered as
\`${defaultInstructionsName('claude', 'default')}\`, \`${defaultInstructionsName('claude', 'auto')}\`, \`${defaultInstructionsName('codex', 'default')}\` and \`${defaultInstructionsName('codex', 'auto')}\`. Naming a
document there changes nothing on its own: an account uses one by referencing it, and
the base profile and the \`auto\` variant are what make them the defaults.

Declare another name under \`memory:\` and you have another shared instruction document,
each account using whichever it references. An account that needs its own copy points
at a path under \`accounts/<wrapper>/\`, which is what unlinking writes.

## How overriding works

\`settings\` is layered. A layer is either a **file path** — a shared base you keep
here — or an **object of overrides** written inline in the configuration. Layers
accumulate through the composition chain (base profile, the agent's profiles, the
variant's profiles, the variant's own fields, the agent's own fields) and are
deep-merged left to right, so a later layer wins key by key. Arrays replace rather
than append, because a list such as \`permissions.allow\` is a complete statement and
an override has to be able to remove from it.

Every other asset field is a single path, and the last writer in that chain wins.

## Editing one document, for every account that uses it

A file here is not copied into the homes that reference it — it **is** the file in
each of those homes, because \`fy fleet apply\` links it. Two accounts pointing at
\`./CLAUDE.md\` share one file on disk, so editing it changes both immediately, with
no apply in between. That is the whole reason to share a document rather than keep
four near-identical ones.

Two exceptions, both stated where you can see them (\`fy fleet sharing\` says which
one each field has, and \`fy fleet apply --dry-run\` names the operation):

- **\`settings\` is generated, never linked.** It is a stack of layers merged into one
  file, and a merge of several sources cannot be the same file as any of them. Each
  harness also rewrites its own settings while it runs, so the destination has to be
  a real file. Edit a layer here; an edit made directly in an account's home is
  folded in once and then replaced by the merge.
- **A source outside this directory is copied.** A reference beginning \`/\`, \`~\` or
  \`$HOME\` — or one that climbs out with \`..\` — is copied at apply time instead, and
  reaches the account on the next apply rather than immediately. Keep shared
  documents in here to get a real link.

## What is safe to edit

All of it. \`fy fleet init\` only ever creates what is missing, so nothing here is
overwritten by re-running it or by upgrading — including this file. If you want a
newer default, delete your copy and run \`fy fleet init\` again.
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
  /**
   * The harnesses whose default accounts a newly-created starter declares; empty keeps the
   * file-first empty fleet.
   *
   * A SET, because "which harnesses does this host have" is the question a boot answers and a host
   * can answer it with both. `fy fleet init --first-account=claude` is that same question narrowed
   * to one by hand, so it passes a one-element set rather than a second spelling of the same fact.
   */
  readonly firstAccounts?: readonly HarnessKind[];
}

/**
 * Which default lanes an existing configuration has variants for.
 *
 * An ABSENT `variants` key is the schema's `{ default: {} }`, so the interactive lane is available on
 * a document that says nothing — and a lane whose variant is missing is dropped rather than refused,
 * because an account with one lane is useful and a configuration that will not parse is not. A
 * `variants` value that is not a mapping is left to the schema to reject on the next read; nothing
 * here can be declared safely against it, so no lane is.
 */
function declaredLanes(document: Record<string, unknown>): readonly FleetDefaultLane[] {
  const variants = document.variants;
  if (variants === undefined) return FLEET_DEFAULT_LANES.filter(lane => lane === 'default');
  if (typeof variants !== 'object' || variants === null || Array.isArray(variants)) return [];
  return FLEET_DEFAULT_LANES.filter(lane => lane in variants);
}

/**
 * Adds the generated starter accounts to a configuration that explicitly has
 * no accounts, without normalising the rest of the person's YAML.
 *
 * The initial starter uses `agents: []`, so that common path is a one-line
 * substitution which preserves every surrounding comment and section. An
 * omitted `agents` key is also an empty declaration under the configuration
 * schema; append a new root key in that case. Any other zero-looking shape is
 * refused rather than guessed at: damaged state is not an empty fleet.
 *
 * ONLY THE LANES THIS DOCUMENT DECLARES VARIANTS FOR are given routes. A route
 * names a variant, and the configuration schema refuses an undeclared one — so
 * writing an `auto` route into a document that declares only `default` would
 * take somebody's valid empty fleet and leave it a file that no longer parses,
 * which is a strictly worse outcome than the account they did not get.
 */
function declareFirstAccountsInEmptyConfig(
  existing: string,
  harnesses: readonly HarnessKind[],
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
  const lanes = declaredLanes(parsed as Record<string, unknown>);
  if (lanes.length === 0) {
    // An agent must declare at least one route, so there is nothing to write. Refused rather than
    // written empty, which would be a document the very next read rejects.
    throw new Error(
      `cannot add a first account because the existing configuration declares none of the default lanes (${FLEET_DEFAULT_LANES.join(', ')}) as variants`,
    );
  }
  const agents = (parsed as Record<string, unknown>).agents;
  if (agents === undefined) return `${existing.replace(/\s*$/u, '')}\n\n${starterAgents(harnesses, ids, lanes)}\n`;
  if (!Array.isArray(agents)) {
    throw new Error('cannot add a first account because the existing configuration has a non-list "agents" value');
  }
  if (agents.length > 0) return undefined;

  const replacement = starterAgents(harnesses, ids, lanes);
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
  const { layout, ids, configPath } = input;
  const firstAccounts = input.firstAccounts ?? [];
  const separator = layout.assetsDirectory.endsWith('/') ? '' : '/';
  const assetPath = (name: string): string => `${layout.assetsDirectory}${separator}${name}`;
  /**
   * All four instruction documents, on every host.
   *
   * A CLAUDE-ONLY HOST STILL GETS THE CODEX PAIR. The configuration this scaffold writes points both
   * harnesses at their own documents whether or not either is installed, so writing only the detected
   * one would leave a live reference to a file nothing had made — and installing the other harness
   * later would then need a second, differently-shaped step to fix it.
   */
  const instructions = (['claude', 'codex'] as const).flatMap(kind =>
    FLEET_DEFAULT_LANES.map(lane => ({
      // Canonicalised rather than trimmed by hand: `./CLAUDE.md` and `CLAUDE.md` are one document,
      // and the same function is what every reader of an asset reference compares through.
      path: assetPath(canonicalAssetReference(DEFAULT_INSTRUCTIONS[kind][lane])),
      content: INSTRUCTION_DOCUMENTS[kind][lane],
      mode: FILE_MODE,
    })),
  );
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
        content: configTemplate(ids, firstAccounts),
        mode: FILE_MODE,
        ...(firstAccounts.length === 0
          ? {}
          : {
              updateIfPresent: (existing: string) => declareFirstAccountsInEmptyConfig(existing, firstAccounts, ids),
            }),
      },
      { path: assetPath('README.md'), content: ASSETS_README, mode: FILE_MODE },
      ...instructions,
      { path: assetPath('templates/claude/settings.json'), content: CLAUDE_SETTINGS, mode: FILE_MODE },
      { path: assetPath('templates/codex/config.toml'), content: CODEX_SETTINGS, mode: FILE_MODE },
    ],
    ...(firstAccounts.length === 0 ? {} : { declaration: { path: configPath, accounts: firstAccounts } }),
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
  /** Present only when this run actually declared the requested accounts, naming their harnesses. */
  readonly declaredAccounts?: readonly HarnessKind[];
  /** Directories ensured, whether or not they already existed. */
  readonly directories: readonly string[];
  readonly pathEntry: string;
}

export interface FleetScaffolder {
  scaffold(scaffold: FleetScaffold): Promise<FleetScaffoldResult>;
}
