import type { CatalogHarness } from '../wire/index.ts';
export type McpScope = 'ferretry' | 'component' | 'user' | 'project' | 'local';
export interface ClaudeOAuthClient {
  readonly clientId: string;
  readonly callbackPort?: number;
}

export type McpDeclaration =
  | {
      readonly name: string;
      readonly transport: 'stdio';
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      readonly disabled?: true;
    }
  | {
      readonly name: string;
      readonly transport: 'http' | 'sse';
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
      /** Codex's `bearer_token_env_var`: a variable the harness reads the token from. */
      readonly bearerVariable?: string;
      /** Claude's `oauth` block: a client registered by hand with the provider (`.mcp.json` only). */
      readonly oauth?: ClaudeOAuthClient;
      readonly disabled?: true;
    };
export interface McpComponentRecord {
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly url?: string | undefined;
  readonly auth?: 'oauth' | undefined;
  readonly oauth?:
    | {
        readonly clientId: string;
        readonly clientSecret?: string | undefined;
        readonly callbackPort?: number | undefined;
      }
    | undefined;
  readonly harness?: CatalogHarness | undefined;
}

export interface McpSourceServer {
  readonly id: string;
  readonly name: string;
  readonly scope: McpScope;
  readonly harness: 'claude' | 'codex';
  /** The file that declares it, when it has one. */
  readonly source?: string | undefined;
  readonly declaration: McpDeclaration | null;
  /** The component record, when `scope` is `component` and the record is still there. */
  readonly component?: McpComponentRecord | undefined;
}
export interface SkillWalkLimits {
  readonly entries: number;
  readonly depth: number;
}

export const SKILL_WALK_LIMITS: SkillWalkLimits = { entries: 1_000, depth: 16 };

type SkillTreeEntryType = 'file' | 'symlink' | 'hardlink' | 'other' | 'deep';

export interface SkillTreeEntry {
  readonly path: string;
  readonly type: SkillTreeEntryType;
  /** Bytes, as listed. Zero for anything that is not a file. */
  readonly size: number;
}

export interface SkillTreeListing {
  readonly entries: readonly SkillTreeEntry[];
  /** The walk stopped at the entry limit: there is more it did not look at. */
  readonly truncated: boolean;
}

export type SkillFileRead =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: 'too_big' | 'unreadable' };

export interface SkillTreePort {
  list(manifestPath: string, limits: SkillWalkLimits, confinedTo?: string): Promise<SkillTreeListing | undefined>;
  read(manifestPath: string, relativePath: string, maxBytes: number, confinedTo?: string): Promise<SkillFileRead>;
}
