/**
 * What a harness plugin can hand Runtimes so that harness's runtime behaviour lives in the harness's own plugin.
 *
 * The kit rides on the one port the owner already fills (`ProfileComponentSource.kit`, `./component-source.ts`): Claude Code
 * and Codex each already give Runtimes a settings source, and Runtimes already looks it up per harness. Every member is
 * OPTIONAL: a harness that does not give one cannot do that thing, and Runtimes says so with `unsupportedHarnessSentence`
 * (`./harness-words.ts`) and does not borrow another harness's answer.
 *
 * A member is added here only with the move that fills it, and what a member exchanges is written in plain contract types
 * (documents are `SettingsObject`s), so a plugin never imports Runtimes' daemon.
 */

import type { FerretsApi } from '@ferretry/core-ferrets/contract';
import type { ProcessesPort, RootHandle } from '@ferretry/kernel/contract';

/** A settings or config document as a plain object (a parsed `settings.json` / `config.toml`). */
export type KitSettingsObject = Readonly<Record<string, unknown>>;

/** How one document on a runtime's launch line is spelled. */
export type KitSettingsFormat = 'json' | 'toml';

/** One MCP server of the account model, as a kit renders it. Exactly one of `command` or `url` is set. */
export interface KitMcpServer {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly auth?: 'oauth';
}

/** A server's variables, split by how a document carries them. */
export interface KitServerEnvironment {
  /** Variables written as literal values. */
  readonly literal: Readonly<Record<string, string>>;
  /** Variables forwarded from the launch environment by name, because their value names a secret. */
  readonly forwarded: readonly string[];
}

/** The agent-permission words a fixed layer is built for. */
export type KitAgentPermissions = Readonly<Record<string, unknown>>;

/** What a plugin is asked for to build the layer a launched agent gets last. */
export interface KitFixedLayerInput {
  readonly agentPermissions: KitAgentPermissions;
  /** The folder the agent is launched in. */
  readonly cwd: string;
  /** The `fy` executable the tools server runs as. */
  readonly fyCommand: string;
  /** Whether the installed harness accepts `--permission-mode auto` (only Claude asks). */
  readonly acceptsAutoPermissionMode: boolean;
}

/** One locked entry of the fixed layer: a document key, or a bare launch flag. */
export interface KitFixedEntry {
  readonly purpose: string;
  readonly target: 'settings' | 'claude-json' | 'launch';
  readonly path: readonly string[];
  readonly key: string;
  readonly value: unknown;
}

/** The fixed layer for one harness, or the sentence that says why an auto launch cannot be honoured. */
export type KitFixedLayerResult =
  | {
      readonly ok: true;
      readonly layer: {
        readonly entries: readonly KitFixedEntry[];
        /** Launch arguments, appended after every flag the profile carries. */
        readonly args: readonly string[];
        readonly settingsOverlay?: KitSettingsObject;
        readonly rules?: string;
        readonly configJson?: KitSettingsObject;
      };
    }
  | { readonly ok: false; readonly refusal: { readonly kind: string; readonly message: string } };

/** What a plugin is asked for to find where a credential lives. */
export interface KitCredentialInput {
  readonly store: 'host' | 'ferretry' | 'environment';
  readonly userHome: string;
  /** Where the person's own harness home is, when it can be named. */
  readonly hostHome?: string;
  /** What the credential's own `env` authenticates with, for an `environment` store. */
  readonly env?: Readonly<Record<string, string>>;
  /** The file or directory the login-keeper named for a Ferretry-kept login. */
  readonly signInFile?: string;
  /** The variables the login-keeper named for a Ferretry-kept login's runtimes (a Claude login's one secure-storage variable). */
  readonly variables?: Readonly<Record<string, string>>;
}

/** Where one credential lives, as a kit says it. Never a credential value. */
export type KitCredentialResolution =
  | { readonly kind: 'stored'; readonly directory?: string; readonly file?: string; readonly secureStorage?: string }
  | { readonly kind: 'environment'; readonly env: Readonly<Record<string, string>>; readonly args?: readonly string[] }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** A link a runtime's home holds to a credential file: its own path, pointing at the file. */
export interface KitCredentialLink {
  readonly path: string;
  readonly target: string;
}

/** What a plugin is asked for to write the config documents of one runtime home. */
export interface KitDocumentsInput {
  /** The settings the runtime would write, with the profile's layers and the fixed layer already merged. */
  readonly settings: KitSettingsObject;
  /** The servers the profile contributes, each already rendered by {@link RuntimesHarnessKit.renderMcpServer}, by name. */
  readonly servers: Readonly<Record<string, KitSettingsObject>>;
  /** The merged `hooks` block of a hooks component, when the profile has one; the harness chooses which document holds it. */
  readonly hooksBlock?: KitSettingsObject;
}

/** The documents one runtime home holds. */
export interface KitDocuments {
  readonly settings: KitSettingsObject;
  /** A second document whose top-level keys are each replaced whole before launch (Claude's `.claude.json`). */
  readonly claudeJson?: KitSettingsObject;
}

/** One setting a plumbing key writes: a settings path and its value. */
export interface KitPlumbingEntry {
  readonly key: string;
  readonly path: readonly string[];
  readonly value: unknown;
}

/** What a plugin is asked for to name the plumbing keys a runtime's settings always carry. */
export interface KitPlumbingInput {
  /** The settings the runtime would write, so a command the person already set can be chained. */
  readonly settings: KitSettingsObject;
  /** The status line command for this runtime, given the person's own command when their settings name one. */
  readonly statusLine: (ownCommand?: string) => string;
}

/**
 * Whether a server reached at `url` speaks the older SSE transport rather than streamable HTTP. Read from the path's last
 * segment (`…/sse`), the convention every SSE server Ferretry has seen follows.
 */
export function isSseUrl(url: string): boolean {
  const pathname = new URL(url).pathname.replace(/\/+$/, '');
  return pathname.split('/').at(-1)?.toLowerCase() === 'sse';
}

/** One login a host scan found. Display only. */
export interface KitHostLogin {
  readonly state: 'signed-in' | 'refresh-due' | 'not-signed-in' | 'unreadable' | 'not-shareable' | 'unknown';
  readonly email?: string;
  readonly reason?: string;
}

/** One guarded host document read; `source` is its absolute path. */
export type KitHostDocumentRead =
  | { readonly kind: 'text'; readonly source: string; readonly text: string; readonly bytes: number }
  | { readonly kind: 'absent'; readonly source: string }
  | { readonly kind: 'too-large'; readonly source: string; readonly bytes: number }
  | { readonly kind: 'unreadable'; readonly source: string; readonly reason: string };

/** A host skill folder and the digest of its whole content. */
export interface KitHostSkill {
  readonly item: string;
  readonly source: string;
  readonly digest: string;
}

/** A project instructions file, only checked for existence; its content is never read. */
export interface KitProjectInstructionHint {
  readonly path: string;
  readonly file: string;
  readonly verified: boolean;
}

/** Setup documents and safe login facts, before Runtimes locates commands and reports missing MCP commands. */
export interface KitHostSetup {
  readonly login: KitHostLogin;
  readonly instructions: KitHostDocumentRead;
  readonly settings: KitHostDocumentRead;
  readonly mcp?: KitHostDocumentRead;
  /** A separate hooks document, for a harness that keeps its hooks outside its settings. Only counted, never imported. */
  readonly hooks?: KitHostDocumentRead;
  readonly projectInstructions?: readonly KitProjectInstructionHint[];
  readonly skills: readonly KitHostSkill[];
  readonly problems: readonly string[];
}

/** Host scan operations remain guarded by Runtimes' kernel roots; the harness chooses its own setup paths. */
export interface KitHostScanInput {
  readonly userHome: string;
  readonly configuredHome?: string;
  read(home: string, path: string): Promise<KitHostDocumentRead>;
  readUserMcp(): Promise<KitHostDocumentRead>;
  skills(
    home: string,
    directory: string,
  ): Promise<{ readonly found: readonly KitHostSkill[]; readonly problems: readonly string[] }>;
  login(): Promise<KitHostLogin>;
  projectInstructions(mcp: KitHostDocumentRead): Promise<readonly KitProjectInstructionHint[]>;
}

/** A harness's own import document names and settings format. */
export interface KitImportSetup {
  readonly settingsFormat: KitSettingsFormat;
  readonly settingsFile: string;
  readonly instructionsName: string;
}

/** An imported environment: component references, safe plain values, and secret names only. */
export interface KitImportedEnvironment {
  readonly env: Record<string, string>;
  readonly secretKeys: string[];
  readonly dropped: string[];
  readonly gated: string[];
  readonly plain: { readonly name: string; readonly value: string }[];
  readonly minted: { readonly name: string; readonly secretName: string }[];
}

/** Shared import services with the harness's mutable settings copy; secret handling remains in Runtimes. */
export interface KitHarvestInput {
  readonly rest: Record<string, unknown>;
  readonly source: string;
  readonly mcpSource?: string;
  readonly parsedEnv?: unknown;
  /** A separate hooks document the host keeps, already parsed; present only when the host read one and it parsed. */
  readonly hooks?: { readonly source: string; readonly document: KitSettingsObject };
  readonly skippedEnv: boolean;
  readonly skippedModelSet: boolean;
  countHooks(block: KitSettingsObject): number;
  importEnvironment(value: unknown, prefix: string, source: string): KitImportedEnvironment;
}

/** The harness-owned parts of a harvest, before shared component and secret reconciliation. */
export interface KitHarvestParts {
  readonly hooks?: { readonly source: string; readonly count: number };
  readonly envImport?: KitImportedEnvironment;
  readonly modelEnvironment?: KitSettingsObject;
  readonly mcpSource: string;
}

/** One model a runtime offers, as the catalog of its login lists it. */
export interface KitRuntimeModel {
  readonly id: string;
  readonly label: string;
  readonly tier?: 'best' | 'balanced' | 'fast';
  readonly context?: number;
  readonly efforts: readonly string[];
  readonly defaultEffort?: string;
  readonly note?: string;
  readonly available: boolean;
}

/** What a plugin is asked for to name a runtime's extra environment and files. */
export interface KitExtrasInput {
  /** The directory every runtime of the harness shares its state database in. */
  readonly sqliteHome: string;
  /** The runtime's own state directory under its home. */
  readonly statePath: string;
  /** What the runtime offers: the login's catalog (when it has one), its models, and the one it launches with. */
  readonly models: {
    readonly catalog?: { readonly id: string };
    readonly entries: readonly KitRuntimeModel[];
    readonly default: string | undefined;
  };
  /** The runtime's generated settings. A person's own setting is theirs and stands. */
  readonly settings: KitSettingsObject;
}

/** What a harness adds to a runtime beyond the common launch. */
export interface KitExtras {
  readonly env: Readonly<Record<string, string>>;
  /** A model catalog file the runtime reads, with its text, the launch arguments that name it and how it is recorded. */
  readonly catalog?: {
    /** The file's name inside the runtime's state directory. */
    readonly file: string;
    /** The absolute path the launch arguments name. */
    readonly path: string;
    readonly text: string;
    readonly args: readonly string[];
    /** The format of the text, published so a machine that updated rewrites the file. */
    readonly format: number;
  };
}

/** What `ferrets.changed` says of one ferret. */
export interface KitFerretChange {
  readonly ferret: string;
  readonly state?: string;
  readonly gone?: true;
}

/** What an ended ferret's follow-up stands on, from the kernel's roots, processes and clock and the published fleet. */
export interface KitEndHost {
  /** The published accounts of the fleet. */
  readonly inventory: {
    accounts(): Promise<readonly { readonly kind: string; readonly wrapper: string; readonly home: string }[]>;
  };
  /** `kernel.roots.root('fleet')`, unscoped. */
  readonly fleet: RootHandle;
  readonly processes: Pick<ProcessesPort, 'runsFrom' | 'usersOf' | 'terminate'>;
  /** `<FY_HOME>/fleet/homes`: the only place a runtime's config directory may be. */
  readonly homesDirectory: () => string;
  readonly sleep: (milliseconds: number) => Promise<void>;
  /** The published wrapper of a runtime by its name, or `undefined` when none is published under it. */
  wrapperOf(runtime: string): Promise<string | undefined>;
}

/** What a harness plugin is asked for when a ferret stops. */
export interface KitEndInput {
  readonly ferrets: Pick<FerretsApi, 'get'>;
  /** `undefined` while the host offers none: the follow-up then does nothing. */
  readonly host: KitEndHost | undefined;
  /** A line for the daemon log when a follow-up could not run. Names no value. */
  readonly warn?: (message: string) => void;
  /** The owner is to be told why a ferret never started. */
  readonly launchFailed: (failure: {
    readonly ferret: string;
    readonly runtime: string;
    readonly message: string;
  }) => void;
}

/** What a launch's autonomous prelude is asked for. */
export interface KitAutonomousPreludeInput {
  /** The variable that points the harness at its home, as Runtimes' wrapper exports it. */
  readonly homeEnv: string;
}

/**
 * The instruction argument of a launch, split around the place the ferret's sections go: the wrapper writes the shell
 * word `before`, then the sections, then `after` (an empty `after` writes nothing). Both parts are quoted by Runtimes.
 */
export interface KitInstructionArgument {
  readonly before: string;
  readonly after: string;
}

/** What a harness adds to the launch line of a runtime's wrapper script. */
export interface KitWrapper {
  /** The shell `case` patterns of the arguments that may name a conversation to resume. */
  readonly conversationArgs: string;
  /** The arguments that start a runtime on a model. */
  modelArgs(model: string): readonly string[];
  /** A per-ferret section as this harness's own argument carries it, before Runtimes quotes it for the shell. */
  quoteSection(text: string): string;
  /** The instruction argument with a place for the sections, or `undefined` for any other argument. */
  instructionArgument(arg: string): KitInstructionArgument | undefined;
  /** The lines that withhold the question tool from an agent. */
  questionLines(): readonly string[];
  /** Arguments the wrapper supplies itself (`questionLines`), which the exec line drops from the launch's own. */
  readonly suppliedArguments?: readonly string[];
  /** What an auto launch prepares first (Claude's first-run seed). Absent: nothing. */
  autonomousPrelude?(input: KitAutonomousPreludeInput): readonly string[];
  /** What an auto launch writes after the conversation claim, to trust the folder it starts in (Codex). Absent: nothing. */
  trustFolderLines?(): readonly string[];
  /** Lines that ask the installed harness about a flag, run before the auto launch's `exec`. */
  promptSnapshotLines?(command: string): readonly string[];
}

/** What a harness plugin hands Runtimes for the harness it owns. Every member is optional; see the file comment. */
export interface RuntimesHarnessKit {
  // Words.
  /** The command that starts the harness: `claude`, `codex`. */
  readonly command?: string;
  /** The variable that points the harness at its home. */
  readonly homeEnv?: string;
  /** The settings file the harness reads and its format. */
  readonly settingsFile?: { readonly format: KitSettingsFormat; readonly file: string; readonly directory: string };
  /** What installs the harness, and what it is called to the person. */
  readonly install?: {
    readonly npm: string;
    readonly cask: string;
    readonly nixpkgs: string;
    readonly label: string;
  };
  /** The model catalog a sign-in lists models from. */
  readonly signInCatalog?: string;
  /** Skill folders the harness keeps for itself, which a skills component may not use. */
  readonly ownedSkillEntries?: readonly string[];

  // The layer every launched agent gets last.
  fixedLayer?(input: KitFixedLayerInput): KitFixedLayerResult;
  /** Flags the fixed layer takes over from a profile, by how much of the command line each uses. */
  readonly supersededFlags?: Readonly<Record<string, 'bare' | 'value' | 'config'>>;

  // The credential store.
  credentialStore?(input: KitCredentialInput): KitCredentialResolution;
  credentialEnvironment?(resolution: KitCredentialResolution): Readonly<Record<string, string>>;
  credentialLink?(home: string, resolution: KitCredentialResolution): KitCredentialLink | undefined;

  // MCP rendering and config documents.
  renderMcpServer?(server: KitMcpServer, env: KitServerEnvironment, bearer?: string): KitSettingsObject;
  readonly mcpImport?: {
    readonly table: string;
    readonly knownKeys: readonly string[];
    readonly skipDisabled: boolean;
  };
  configDocuments?(input: KitDocumentsInput): KitDocuments;
  plumbing?(input: KitPlumbingInput): readonly KitPlumbingEntry[];

  // Login notes and host import.
  loginNote?(login: KitHostLogin): string;
  scanHost?(input: KitHostScanInput): Promise<KitHostSetup>;
  readonly importSetup?: KitImportSetup;
  harvest?(input: KitHarvestInput): KitHarvestParts;

  // The launch line.
  readonly wrapper?: KitWrapper;

  // What one harness adds to a runtime beyond the common launch.
  runtimeExtras?(input: KitExtrasInput): KitExtras;

  // What a harness leaves behind that a ended ferret has to answer for. Never throws: housekeeping never fails an ending.
  onFerretChanged?(input: KitEndInput, change: KitFerretChange): Promise<void>;
}
