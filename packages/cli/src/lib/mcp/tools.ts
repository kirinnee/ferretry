import {
  AGENT_TOOL_DEFAULT_WAIT_MS,
  AGENT_TOOL_MAX_READ_LINES,
  AGENT_TOOL_MAX_TOTAL_WAIT_MS,
  AGENT_TOOL_MAX_WAIT_MS,
  type AgentConfigToolName,
  type AgentLessonToolName,
  type AgentToolName,
  INPUT_MAX_EXPIRY_SECONDS,
  INPUT_PROMPT_MAX_LENGTH,
  LESSON_RULE_MAX_CHARS,
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
const ASK_OWNER = {
  type: ['boolean', 'string'],
  description:
    'Hand it to the owner right away: their tab opens on it with "Your turn here". true, or a short plain sentence saying exactly what to do there. Never a secret.',
};
const ASK_MESSAGE = {
  type: 'string',
  description: 'A short plain sentence saying exactly what the owner should do there. Never a secret.',
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
        askOwner: ASK_OWNER,
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
    name: 'terminal_ask_owner',
    tool: 'terminal.ask_owner',
    description:
      'Hand a terminal to the owner when you need them to act in it (a password, a code, "press Enter"): their tab comes forward with "Your turn here". Then wait; read the terminal to see when they are done.',
    inputSchema: object({ name: NAME, message: ASK_MESSAGE }, ['name']),
  },
  {
    name: 'terminal_request_input',
    tool: 'terminal.request_input',
    description:
      'Ask the owner to type ONE value into a terminal: a password, sudo password or passphrase (sensitivity secret), or a plain answer such as a username, hostname or y/N (sensitivity plain). Have the program show its prompt first, with echo off for a secret; then raise this and the owner types the value on a card, so you never hold it. Returns the card (!A<n>) at once; call input_wait. "prompt" is shown to the owner as "the agent says", never as fact: say what the value is for. Put no secret anywhere in the call. A secret is never returned to you, and terminal_read and terminal_wait on that terminal are refused for about two minutes after it is typed (you can still send keys); a plain answer is NOT secret and the card tells the owner you can see it. terminal_send is blocked on this terminal until the card is answered, cancelled or expires.',
    inputSchema: object(
      {
        name: NAME,
        prompt: {
          type: 'string',
          maxLength: INPUT_PROMPT_MAX_LENGTH,
          description:
            'What the value is for, in a plain sentence, e.g. "sudo password to install the package". Never a secret.',
        },
        sensitivity: {
          type: 'string',
          enum: ['secret', 'private', 'plain'],
          description:
            'secret: a password or passphrase; the terminal must have echo off. plain: a username, e-mail, hostname or y/N, which you may see. private (a code that shows on screen) is not supported in terminals yet: ask the owner in chat.',
        },
        submit: {
          type: 'string',
          enum: ['agent', 'offer-owner', 'owner-default'],
          description:
            'Who presses Enter after the value is typed: "agent" (you do), "offer-owner" (the card offers it; the default), "owner-default" (it is on by default).',
        },
        expiresInSeconds: {
          type: 'integer',
          minimum: 30,
          maximum: INPUT_MAX_EXPIRY_SECONDS,
          description: 'How long the card waits; 600 by default.',
        },
        blocking: { type: 'boolean', description: 'You are stopped until it is answered: also ping the owner.' },
        chain: { type: 'string', description: 'A follow-up in a multi-step login: the card it follows, like A7.' },
      },
      ['name', 'prompt', 'sensitivity'],
    ),
  },
  {
    name: 'input_wait',
    tool: 'input.wait',
    description:
      'Wait for the owner to answer an input card (!A<n>) you raised. Returns where it stands (pending, delivered, refused, expired or cancelled), and for a delivered one the terminal text with the value masked. It never returns the value.',
    inputSchema: object(
      {
        id: { type: 'string', description: 'The card, like !A7.' },
        timeoutMs: {
          type: 'integer',
          minimum: 100,
          maximum: AGENT_TOOL_MAX_WAIT_MS,
          description: 'How long to wait in this call; call again to keep waiting.',
        },
      },
      ['id'],
    ),
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
        askOwner: ASK_OWNER,
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
  {
    name: 'browser_ask_owner',
    tool: 'browser.ask_owner',
    description:
      'Hand a page to the owner when you need them to act in it (a login, a captcha, a payment, a consent screen): their tab comes forward with "Your turn here". Then wait; read the page to see when they are done.',
    inputSchema: object({ name: NAME, message: ASK_MESSAGE }, ['name']),
  },
];

const CONFIG_PATH = {
  type: 'string',
  description:
    'A file, relative to the configuration directory: machine.yaml, warden.yaml, learning.yaml, voice.yaml, logins/<id>.yaml, profiles/<name>.yaml, runtimes/<name>.yaml or components/<kind>/<name>.yaml.',
};
const CONFIG_TEXT = {
  type: 'string',
  description:
    'The whole file, as YAML. Never a secret value: write ${secret:NAME} and ask the owner to store the value.',
};

/**
 * The `config.*` tools (docs/config-files.md): this machine's configuration files, read, checked and
 * written. Refused unless the owner turned on "What agents may control › Ferretry settings"; even then a
 * write that loosens what the machine allows waits for the owner's confirmation.
 */
export const MCP_CONFIG_TOOLS: readonly (McpToolDefinition & { readonly configTool: AgentConfigToolName })[] = [
  {
    name: 'config_read',
    configTool: 'config.read',
    description:
      'Read this machine’s Ferretry configuration: with no path, every file and every problem; with a path, that file’s text and its etag (pass the etag back to config_write).',
    inputSchema: object({ path: CONFIG_PATH }),
  },
  {
    name: 'config_validate',
    configTool: 'config.validate',
    description:
      'Check a configuration file’s text as if it were written, without writing it. Answers each problem with its line and the fix.',
    inputSchema: object({ path: CONFIG_PATH, text: CONFIG_TEXT }, ['path', 'text']),
  },
  {
    name: 'config_write',
    configTool: 'config.write',
    description:
      'Write a configuration file. Refused unless it checks. A change that loosens what the machine may spend or what agents may do is written but waits for the owner to confirm it; tell the owner.',
    inputSchema: object(
      {
        path: CONFIG_PATH,
        text: CONFIG_TEXT,
        etag: { type: 'string', description: 'The etag config_read gave you, so a newer edit is never overwritten.' },
      },
      ['path', 'text'],
    ),
  },
];

/**
 * The `lessons.suggest` tool (docs/learning.md): how a ferret files a lesson for the owner to
 * review. The daemon derives the session from the credential alone and attaches the evidence — the
 * owner's own words — itself, so nothing here can name a session or carry a quote.
 */
export const MCP_LESSON_TOOLS: readonly (McpToolDefinition & { readonly lessonTool: AgentLessonToolName })[] = [
  {
    name: 'lessons_suggest',
    lessonTool: 'lessons.suggest',
    description:
      'File a lesson for the owner to review: a correction they made, or a durable fact about how they want work done. Use scope "repo" for a fact about this project, "global" for one every ferret should follow. File each lesson once; a duplicate merges into the existing one.',
    inputSchema: object(
      {
        rule: {
          type: 'string',
          maxLength: LESSON_RULE_MAX_CHARS,
          description: 'One short imperative rule, e.g. "Run bun install inside the target package."',
        },
        scope: { type: 'string', enum: ['global', 'repo'] },
      },
      ['rule', 'scope'],
    ),
  },
];

/**
 * The `instructions` tool: which of its own system-prompt sections this ferret launched with, and how the
 * owner turns each on — the `fy instructions` report. Answered by the server from the launch environment
 * it inherited, the one the wrapper composed the prompt from, so nothing goes to the daemon.
 */
export const MCP_INSTRUCTIONS_TOOL: McpToolDefinition = {
  name: 'instructions',
  description:
    'Which Ferretry sections of your system prompt you launched with (hypermedia, Pack mode, agenda mode, lessons) and how the owner turns each on. Check this before telling the owner a section is missing.',
  inputSchema: object({}),
};
