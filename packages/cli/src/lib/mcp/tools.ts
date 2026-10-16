import {
  AGENT_TOOL_DEFAULT_WAIT_MS,
  AGENT_TOOL_MAX_READ_LINES,
  AGENT_TOOL_MAX_TOTAL_WAIT_MS,
  type AgentToolName,
  TERMINAL_KEYS,
} from '@ferretry/protocol';

/**
 * The Ferretry tools as an MCP server shows them.
 *
 * NAMES USE AN UNDERSCORE, NOT A DOT. The wire calls them `terminal.open`; an MCP tool is shown to the
 * model through the provider's tool API, and both Anthropic's and OpenAI's tool names are limited to
 * letters, digits, `_` and `-`. A dotted name would be renamed or refused by the harness, so the MCP
 * name is `terminal_open` and maps one-to-one onto `terminal.open`.
 *
 * Every input schema is plain JSON Schema written out by hand: the daemon validates the call again
 * against the protocol's own zod schema, so these only have to describe the inputs well enough for a
 * model to fill them in.
 */

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

const NAME = {
  type: 'string',
  description: 'The name, e.g. "dev" (as in %terminal:dev / %browser:app). An id from a list works too.',
};
const NEW_NAME = {
  type: 'string',
  pattern: '^[a-z][a-z0-9-]{0,31}$',
  description: 'A short name you choose, e.g. "dev" or "app": a lowercase letter, then letters, digits or dashes.',
};
const URL = { type: 'string', description: 'An http or https URL.' };
const SELECTOR = { type: 'string', description: 'A CSS or Playwright selector, e.g. "button[type=submit]".' };

const object = (properties: Record<string, unknown>, required: readonly string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length === 0 ? {} : { required }),
  additionalProperties: false,
});

/** The tools, each with the wire tool it is. */
export const MCP_TOOLS: readonly (McpToolDefinition & { readonly tool: AgentToolName })[] = [
  {
    name: 'terminal_list',
    tool: 'terminal.list',
    description: 'List the terminals open in your session, by name.',
    inputSchema: object({}),
  },
  {
    name: 'terminal_open',
    tool: 'terminal.open',
    description:
      'Open a new terminal (a shell) with a name, optionally in a folder and running a command. The person sees it as a tab named %terminal:<name>.',
    inputSchema: object(
      {
        name: NEW_NAME,
        folder: { type: 'string', description: 'Where it starts: absolute, or relative to your working folder.' },
        command: { type: 'string', description: 'A command to run in it, e.g. "bun dev".' },
      },
      ['name'],
    ),
  },
  {
    name: 'terminal_send',
    tool: 'terminal.send',
    description: 'Type text into a terminal, then press keys. A newline in the text is Enter.',
    inputSchema: object(
      {
        name: NAME,
        text: { type: 'string', description: 'Text to type.' },
        keys: {
          type: 'array',
          items: { type: 'string', enum: [...TERMINAL_KEYS] },
          description: 'Keys to press after the text.',
        },
      },
      ['name'],
    ),
  },
  {
    name: 'terminal_read',
    tool: 'terminal.read',
    description: 'Read the last lines a terminal shows.',
    inputSchema: object({ name: NAME, lines: { type: 'integer', minimum: 1, maximum: AGENT_TOOL_MAX_READ_LINES } }, [
      'name',
    ]),
  },
  {
    name: 'terminal_wait',
    tool: 'terminal.wait',
    description:
      'Wait until text appears in a terminal (give "text"), or until its running command ends (give "exit": true).',
    inputSchema: object(
      {
        name: NAME,
        text: { type: 'string' },
        exit: { type: 'boolean' },
        timeoutMs: {
          type: 'integer',
          minimum: 100,
          maximum: AGENT_TOOL_MAX_TOTAL_WAIT_MS,
          description: `How long to wait; ${String(AGENT_TOOL_DEFAULT_WAIT_MS)} by default.`,
        },
      },
      ['name'],
    ),
  },
  {
    name: 'terminal_close',
    tool: 'terminal.close',
    description: 'Close a terminal, ending its shell.',
    inputSchema: object({ name: NAME }, ['name']),
  },
  {
    name: 'browser_list',
    tool: 'browser.list',
    description: 'List the browser pages open in your session, by name.',
    inputSchema: object({}),
  },
  {
    name: 'browser_open',
    tool: 'browser.open',
    description:
      'Open a browser page with a name, optionally at a URL. The person sees it live as %browser:<name>. Pages share this machine’s agent sign-ins and cookies; pass "incognito": true for a throwaway page with its own cookies, shared with nothing.',
    inputSchema: object(
      {
        name: NEW_NAME,
        url: URL,
        incognito: {
          type: 'boolean',
          description: 'A private page: its own cookies and storage, discarded when it closes.',
        },
      },
      ['name'],
    ),
  },
  {
    name: 'browser_navigate',
    tool: 'browser.navigate',
    description: 'Load a URL in a page.',
    inputSchema: object({ name: NAME, url: URL }, ['name', 'url']),
  },
  {
    name: 'browser_click',
    tool: 'browser.click',
    description: 'Click an element in a page.',
    inputSchema: object({ name: NAME, selector: SELECTOR }, ['name', 'selector']),
  },
  {
    name: 'browser_type',
    tool: 'browser.type',
    description: 'Fill an input in a page with text, replacing what it held.',
    inputSchema: object({ name: NAME, selector: SELECTOR, text: { type: 'string' } }, ['name', 'selector', 'text']),
  },
  {
    name: 'browser_read',
    tool: 'browser.read',
    description:
      'Read a page: its visible text, or (mode "a11y") its accessibility tree, which names the buttons, links and fields you can act on.',
    inputSchema: object({ name: NAME, mode: { type: 'string', enum: ['text', 'a11y'] }, selector: SELECTOR }, ['name']),
  },
  {
    name: 'browser_screenshot',
    tool: 'browser.screenshot',
    description: 'Take a screenshot of a page.',
    inputSchema: object({ name: NAME }, ['name']),
  },
  {
    name: 'browser_close',
    tool: 'browser.close',
    description: 'Close a page.',
    inputSchema: object({ name: NAME }, ['name']),
  },
];
