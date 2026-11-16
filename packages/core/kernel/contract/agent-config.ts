import { z } from 'zod';

/**
 * The agent's configuration tools (docs/config-files.md), exactly as today's MCP wrapper names them: the names, the
 * input schemas and the descriptions a ferret reads. The wire of `POST /v1/agent/config` carries the same three calls
 * under today's dotted names (`config.read` …), so the door and the tools cannot disagree about what a call is.
 */

const PATH_WORDS =
  'A config file: machine.yaml, warden.yaml, learning.yaml, voice.yaml, account-defaults.yaml, logins/<id>.yaml, profiles/<name>.yaml, runtimes/<name>.yaml or components/<kind>/<name>.yaml.';
const TEXT_WORDS = 'The whole file, as YAML. Never a secret value: write ${secret:NAME} and ask the owner to store it.';
const ETAG_WORDS = 'The etag config_read gave you, so a newer edit is never overwritten.';

/** The largest file text an agent may send (today's `CONFIG_FILE_MAX_BYTES`). */
export const AGENT_CONFIG_TEXT_MAX_BYTES = 256 * 1024;

const Path = z.string().min(1).describe(PATH_WORDS);
const Text = z
  .string()
  .refine(text => new TextEncoder().encode(text).length <= AGENT_CONFIG_TEXT_MAX_BYTES, {
    message: `a configuration file is at most ${String(AGENT_CONFIG_TEXT_MAX_BYTES / 1024)} KiB`,
  })
  .describe(TEXT_WORDS);

/** The input of each tool, by tool name. */
export const AgentConfigCallSchemas = {
  config_read: z.strictObject({ path: Path.optional() }),
  config_validate: z.strictObject({ path: Path, text: Text }),
  config_write: z.strictObject({ path: Path, text: Text, etag: z.string().min(1).describe(ETAG_WORDS).optional() }),
} as const;

/** What each tool is for, word for word what a ferret reads. */
export const AGENT_CONFIG_TOOLS = {
  config_read:
    'Read this machine’s Ferretry configuration: no path: every file and problem; a path: that file’s text and etag (pass it to config_write).',
  config_validate:
    'Check a config file’s text as if it were written, without writing it. Answers each problem with its line and the fix.',
  config_write:
    'Write a config file. Refused unless it checks. A change that loosens spending or what agents may do waits for the owner to confirm; tell them.',
} as const;

export type AgentConfigToolName = keyof typeof AGENT_CONFIG_TOOLS;

/** The body of `POST /v1/agent/config`: one call, named by today's dotted tool name. Strict: no credential, no ferret. */
export const AgentConfigCallSchema = z.discriminatedUnion('tool', [
  AgentConfigCallSchemas.config_read.extend({ tool: z.literal('config.read') }),
  AgentConfigCallSchemas.config_validate.extend({ tool: z.literal('config.validate') }),
  AgentConfigCallSchemas.config_write.extend({ tool: z.literal('config.write') }),
]);
export type AgentConfigCall = z.infer<typeof AgentConfigCallSchema>;

/** Which declared tool each dotted name on the wire is. */
export const AGENT_CONFIG_TOOL_OF: Readonly<Record<AgentConfigCall['tool'], AgentConfigToolName>> = {
  'config.read': 'config_read',
  'config.validate': 'config_validate',
  'config.write': 'config_write',
};

/** What a config tool answers: a sentence an agent can act on, and the file or the issues behind it. */
export interface AgentConfigAnswer {
  readonly summary: string;
  readonly text?: string;
  readonly etag?: string;
  readonly issues?: readonly {
    readonly path: string;
    readonly line?: number;
    readonly column?: number;
    readonly severity: 'error' | 'warning';
    readonly message: string;
    readonly fix: string;
  }[];
  readonly files?: readonly {
    readonly path: string;
    readonly kind: string;
    readonly schema: string;
    readonly state: 'ok' | 'invalid' | 'pending';
  }[];
}
