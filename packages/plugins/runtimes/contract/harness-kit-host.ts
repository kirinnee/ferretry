/**
 * What a harness plugin hands Runtimes to read the person's own setup for the first-run import: the host scan's inputs and
 * results, and what a harvest exchanges. Split from `./harness-kit.ts` (the kit itself) only to keep that file small; both are
 * exported from `./index.ts`.
 */

import type { KitSettingsFormat, KitSettingsObject } from './harness-kit.ts';

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
  /** Named profiles the host's settings declare (names and the two keys an import would keep): shown, never imported. */
  readonly profileHints?: readonly { readonly name: string; readonly model?: string; readonly effort?: string }[];
}
