import {
  AGENT_TOOL_DEFAULT_WAIT_MS,
  AGENT_TOOL_MAX_READ_LINES,
  AGENT_TOOL_MAX_TOTAL_WAIT_MS,
  AGENT_TOOL_MAX_WAIT_MS,
  type AgentConfigToolName,
  type AgentLessonToolName,
  type AgentToolName,
  BROWSER_CONSOLE_LEVELS,
  BROWSER_CPU_THROTTLE_MAX,
  BROWSER_EMULATED_PERMISSIONS,
  BROWSER_RESOURCE_TYPES,
  INPUT_MAX_EXPIRY_SECONDS,
  INPUT_MAX_FIELDS,
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
  description: 'The name, as in %terminal:dev or %browser:app; an id from a list works too.',
};
const NEW_NAME = {
  type: 'string',
  pattern: '^[a-z][a-z0-9-]{0,31}$',
  description: 'A short name you choose, e.g. "dev" or "app".',
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
const REF = {
  type: 'string',
  description: 'An element ref from browser_read mode "snapshot", e.g. "e12". Use this or selector.',
};
const COORDINATE = { type: 'number', minimum: 0, description: 'Viewport CSS pixels.' };
const INPUT_PROMPT = {
  type: 'string',
  maxLength: INPUT_PROMPT_MAX_LENGTH,
  description: 'What it is for. Never a secret.',
};
const SENSITIVITY = { type: 'string', enum: ['secret', 'private', 'plain'] };
const INPUT_OPTIONS = {
  submit: {
    type: 'string',
    enum: ['agent', 'offer-owner', 'owner-default'],
    description: 'Who presses Enter; the card offers it by default.',
  },
  expiresInSeconds: {
    type: 'integer',
    minimum: 30,
    maximum: INPUT_MAX_EXPIRY_SECONDS,
  },
  blocking: { type: 'boolean', description: 'Ping the owner.' },
  chain: { type: 'string', description: 'The card this login step follows, like A7.' },
  secretHint: {
    type: 'string',
    description: 'Saved login you expect, by handle (SUDO_KIRIN_BOX): a hint only, the owner still taps.',
  },
};

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
      'Hand a terminal to the owner when you need them to act in it (a password, a code, "press Enter"): their tab comes forward with "Your turn here". Then wait and read it.',
    inputSchema: object({ name: NAME, message: ASK_MESSAGE }, ['name']),
  },
  {
    name: 'terminal_request_input',
    tool: 'terminal.request_input',
    description:
      'Ask the owner to type ONE value into a terminal from a card: secret (a password; ALWAYS for sudo), private (a code that shows) or plain (you see it). Returns !A<n>; then input_wait. The terminal is unreadable ~2 min after.',
    inputSchema: object(
      {
        name: NAME,
        prompt: INPUT_PROMPT,
        sensitivity: SENSITIVITY,
        label: { type: 'string' },
        ...INPUT_OPTIONS,
      },
      ['name', 'prompt', 'sensitivity'],
    ),
  },
  {
    name: 'input_wait',
    tool: 'input.wait',
    description:
      'Wait for the owner to answer your input card (!A<n>): where it stands, and once delivered the screen with the value masked. Never the value.',
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
    name: 'login_hint',
    tool: 'login.hint',
    description:
      "Before a sign-in: the owner's saved logins for a page or site (label, method like Google, login domain, username). Never a value.",
    inputSchema: object({ name: NAME, site: { type: 'string', description: 'Or a host or URL.' } }),
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
      'Open a browser page with a name, optionally at a URL. The person sees it live as %browser:<name>. Pages share this machine’s agent sign-ins and cookies; pass "incognito": true for a throwaway page with its own cookies.',
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
    description: 'Load a URL in a page, or go back, forward or reload.',
    inputSchema: object({ name: NAME, url: URL, history: { type: 'string', enum: ['back', 'forward', 'reload'] } }, [
      'name',
    ]),
  },
  {
    name: 'browser_click',
    tool: 'browser.click',
    description: 'Click an element (ref or selector), or a point (x, y) for a canvas or map.',
    inputSchema: object(
      {
        name: NAME,
        ref: REF,
        selector: SELECTOR,
        x: COORDINATE,
        y: COORDINATE,
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        double: { type: 'boolean' },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'] },
        },
      },
      ['name'],
    ),
  },
  {
    name: 'browser_type',
    tool: 'browser.type',
    description:
      'Fill a field (ref or selector) with text, replacing what it held. submit presses Enter after; slowly types key by key. Never a secret.',
    inputSchema: object(
      {
        name: NAME,
        ref: REF,
        selector: SELECTOR,
        text: { type: 'string' },
        submit: { type: 'boolean' },
        slowly: { type: 'boolean' },
      },
      ['name', 'text'],
    ),
  },
  {
    name: 'browser_read',
    tool: 'browser.read',
    description:
      'Read a page: visible text, or mode "snapshot" (use it first): the accessibility tree with a ref per element, which other browser tools take. find narrows it to lines with that text.',
    inputSchema: object(
      {
        name: NAME,
        mode: { type: 'string', enum: ['text', 'a11y', 'snapshot'] },
        ref: REF,
        selector: SELECTOR,
        find: { type: 'string' },
        depth: { type: 'integer', minimum: 1 },
        boxes: { type: 'boolean', description: 'Add each element’s viewport box, for a click by x, y.' },
      },
      ['name'],
    ),
  },
  {
    name: 'browser_screenshot',
    tool: 'browser.screenshot',
    description: 'Take a screenshot of a page, the full page, or one element (ref or selector).',
    inputSchema: object(
      {
        name: NAME,
        ref: REF,
        selector: SELECTOR,
        fullPage: { type: 'boolean' },
        format: { type: 'string', enum: ['png', 'jpeg'] },
      },
      ['name'],
    ),
  },
  {
    name: 'browser_dialog',
    tool: 'browser.dialog',
    description:
      'Answer the dialog (alert, confirm, prompt, beforeunload) a page is waiting on; any browser result tells you when one is open. Unanswered, it is dismissed after 30 s. promptText answers a prompt.',
    inputSchema: object(
      { name: NAME, action: { type: 'string', enum: ['accept', 'dismiss'] }, promptText: { type: 'string' } },
      ['name', 'action'],
    ),
  },
  {
    name: 'browser_tabs',
    tool: 'browser.tabs',
    description:
      'list: your pages and the popups they opened (available: false means not yours). adopt: give a popup (id from the list) a name so you can use it. Never switches the person’s tab.',
    inputSchema: object(
      {
        action: { type: 'string', enum: ['list', 'adopt'] },
        id: { type: 'string', description: 'adopt: the popup’s id from the list.' },
        as: NEW_NAME,
      },
      ['action'],
    ),
  },
  {
    name: 'browser_wait_for',
    tool: 'browser.wait_for',
    description:
      'Wait for one thing: an element (ref or selector, with state), text, textGone, url (part of the address), load, or time (ms). Says whether it happened in time.',
    inputSchema: object(
      {
        name: NAME,
        ref: REF,
        selector: SELECTOR,
        state: {
          type: 'string',
          enum: ['visible', 'hidden', 'attached', 'detached'],
          description: 'visible by default.',
        },
        text: { type: 'string' },
        textGone: { type: 'string' },
        url: { type: 'string' },
        load: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] },
        time: { type: 'integer', minimum: 1, maximum: AGENT_TOOL_MAX_WAIT_MS },
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
    name: 'browser_console',
    tool: 'browser.console',
    description:
      'The page’s recent console messages and errors, numbered. level: this level and worse. since: only entries after that number.',
    inputSchema: object(
      {
        name: NAME,
        level: { type: 'string', enum: BROWSER_CONSOLE_LEVELS },
        since: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: '100 by default.' },
      },
      ['name'],
    ),
  },
  {
    name: 'browser_network',
    tool: 'browser.network',
    description:
      'list: the page’s recent requests, each with an id. get: one request by id, with safe response headers and a text body. Cookies and credentials are never shown.',
    inputSchema: object(
      {
        name: NAME,
        action: { type: 'string', enum: ['list', 'get'] },
        id: { type: 'string', pattern: '^r\\d{1,9}$', description: 'get: a request id, e.g. "r12".' },
        filter: { type: 'string', description: 'list: only URLs containing this.' },
        types: {
          type: 'array',
          items: { type: 'string', enum: BROWSER_RESOURCE_TYPES },
          description: 'list: only these kinds.',
        },
      },
      ['name', 'action'],
    ),
  },
  {
    name: 'browser_emulate',
    tool: 'browser.emulate',
    description: 'Make a page act like another device or setting; reset puts it all back. Never the user agent.',
    inputSchema: object(
      {
        name: NAME,
        viewport: object({ width: { type: 'integer', minimum: 320 }, height: { type: 'integer', minimum: 240 } }, [
          'width',
          'height',
        ]),
        media: object({
          colorScheme: { type: 'string', enum: ['light', 'dark', 'no-preference'] },
          reducedMotion: { type: 'string', enum: ['reduce', 'no-preference'] },
          forcedColors: { type: 'string', enum: ['active', 'none'] },
          contrast: { type: 'string', enum: ['more', 'less', 'custom', 'no-preference'] },
          print: { type: 'boolean', description: 'Lay out as for print.' },
        }),
        geolocation: object(
          { latitude: { type: 'number' }, longitude: { type: 'number' }, accuracy: { type: 'number' } },
          ['latitude', 'longitude'],
        ),
        locale: { type: 'string', description: 'e.g. "en-US".' },
        timezone: { type: 'string', description: 'e.g. "Europe/Berlin".' },
        cpuThrottle: { type: 'number', minimum: 1, maximum: BROWSER_CPU_THROTTLE_MAX, description: '1 is none.' },
        network: object({
          offline: { type: 'boolean' },
          latency: { type: 'integer', minimum: 0, description: 'Added ms.' },
          throughput: { type: 'integer', minimum: 1, description: 'kbit/s.' },
        }),
        permissions: { type: 'array', items: { type: 'string', enum: BROWSER_EMULATED_PERMISSIONS } },
        reset: { type: 'boolean' },
      },
      ['name'],
    ),
  },
  {
    name: 'browser_upload',
    tool: 'browser.upload',
    description:
      'Give a page files: a file input, or the button that opens the file picker (ref or selector). files are paths in your working folder, or {"attachment": "att_…"}. mode "drop": onto a dropzone. Needs the files switch.',
    inputSchema: object(
      {
        name: NAME,
        ref: REF,
        selector: SELECTOR,
        files: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            anyOf: [
              { type: 'string', maxLength: 1024 },
              { type: 'object', properties: { attachment: { type: 'string' } }, required: ['attachment'] },
            ],
          },
        },
        mode: { type: 'string', enum: ['input', 'drop'] },
      },
      ['name', 'files'],
    ),
  },
  {
    name: 'browser_download',
    tool: 'browser.download',
    description:
      'Save a file the page downloaded (a result says "a download started … id dl-1") into your working folder: downloads/<its name> unless saveAs says where. Needs the files switch.',
    inputSchema: object(
      {
        name: NAME,
        id: { type: 'string', description: 'The download id from the result, e.g. "dl-1"; the latest when absent.' },
        saveAs: { type: 'string', maxLength: 1024, description: 'A path inside your working folder.' },
        overwrite: { type: 'boolean' },
      },
      ['name'],
    ),
  },
  {
    name: 'browser_pdf',
    tool: 'browser.pdf',
    description:
      'Print the page to a PDF in your working folder (downloads/<title>.pdf unless saveAs says where). Needs a headless browser, not the Real window mode. Needs the files switch.',
    inputSchema: object(
      {
        name: NAME,
        saveAs: { type: 'string', maxLength: 1024, description: 'A path inside your working folder.' },
        overwrite: { type: 'boolean' },
      },
      ['name'],
    ),
  },
  {
    name: 'browser_hover',
    tool: 'browser.hover',
    description: 'Move the pointer over an element (ref or selector) or a point (x, y): menus, tooltips, hover states.',
    inputSchema: object({ name: NAME, ref: REF, selector: SELECTOR, x: COORDINATE, y: COORDINATE }, ['name']),
  },
  {
    name: 'browser_drag',
    tool: 'browser.drag',
    description:
      'Drag from one element to another (fromRef/fromSelector to toRef/toSelector), or point to point (fromX, fromY to toX, toY, in steps) for sliders, canvases, maps.',
    inputSchema: object(
      {
        name: NAME,
        fromRef: REF,
        fromSelector: SELECTOR,
        fromX: COORDINATE,
        fromY: COORDINATE,
        toRef: REF,
        toSelector: SELECTOR,
        toX: COORDINATE,
        toY: COORDINATE,
        steps: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Points only; 10 by default.',
        },
      },
      ['name'],
    ),
  },
  {
    name: 'browser_mouse',
    tool: 'browser.mouse',
    description:
      'Low-level mouse: action move (x, y), down or up (button), or wheel (deltaX, deltaY up to ±20000 pixels). Give x, y to move there first.',
    inputSchema: object(
      {
        name: NAME,
        action: { type: 'string', enum: ['move', 'down', 'up', 'wheel'] },
        x: COORDINATE,
        y: COORDINATE,
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        deltaX: { type: 'number', minimum: -20000, maximum: 20000 },
        deltaY: { type: 'number', minimum: -20000, maximum: 20000 },
      },
      ['name', 'action'],
    ),
  },
  {
    name: 'browser_press',
    tool: 'browser.press',
    description:
      'Press up to 32 keys in order, e.g. ["Enter"], ["ArrowDown"], ["Control+Shift+K"]. Modifiers Alt, Control, ControlOrMeta, Meta, Shift, then a named key or one character. ref/selector focuses an element first. Never a secret.',
    inputSchema: object(
      {
        name: NAME,
        keys: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32 },
        ref: REF,
        selector: SELECTOR,
      },
      ['name', 'keys'],
    ),
  },
  {
    name: 'browser_scroll',
    tool: 'browser.scroll',
    description:
      'Scroll one way: an element into view (ref or selector), to the first place a text shows, by deltaX/deltaY pixels, or by pages (1 is a screen down, -1 up; up to ±20).',
    inputSchema: object(
      {
        name: NAME,
        ref: REF,
        selector: SELECTOR,
        text: { type: 'string' },
        deltaX: { type: 'number', minimum: -20000, maximum: 20000 },
        deltaY: { type: 'number', minimum: -20000, maximum: 20000 },
        pages: { type: 'number', minimum: -20, maximum: 20 },
      },
      ['name'],
    ),
  },
  {
    name: 'browser_select',
    tool: 'browser.select',
    description: 'Choose options of a select (ref or selector), by value or label. Up to 64.',
    inputSchema: object(
      { name: NAME, ref: REF, selector: SELECTOR, values: { type: 'array', items: { type: 'string' }, minItems: 1 } },
      ['name', 'values'],
    ),
  },
  {
    name: 'browser_check',
    tool: 'browser.check',
    description: 'Tick (checked true) or untick (false) a checkbox or radio button (ref or selector).',
    inputSchema: object({ name: NAME, ref: REF, selector: SELECTOR, checked: { type: 'boolean' } }, [
      'name',
      'checked',
    ]),
  },
  {
    name: 'browser_fill_form',
    tool: 'browser.fill_form',
    description:
      'Fill up to 32 fields in one call. Each: ref or selector, plus exactly one of text, checked, option (select), value (slider, date, colour). Never a secret: a password field is flagged.',
    inputSchema: object(
      {
        name: NAME,
        fields: {
          type: 'array',
          minItems: 1,
          maxItems: 32,
          items: object({
            ref: REF,
            selector: SELECTOR,
            text: { type: 'string' },
            checked: { type: 'boolean' },
            option: { type: 'string' },
            value: { type: 'string' },
          }),
        },
      },
      ['name', 'fields'],
    ),
  },
  {
    name: 'browser_highlight',
    tool: 'browser.highlight',
    description:
      'Outline an element (ref or selector) so the person watching sees what you mean. clear: true removes it.',
    inputSchema: object({ name: NAME, ref: REF, selector: SELECTOR, clear: { type: 'boolean' } }, ['name']),
  },
  {
    name: 'browser_eval',
    tool: 'browser.eval',
    description:
      'Run your own JavaScript function in a page, in an isolated world (its DOM, none of its scripts); returns the value as JSON. Refused unless the owner turned on Page scripts.',
    inputSchema: object(
      {
        name: NAME,
        function: {
          type: 'string',
          description: 'A function expression: "() => document.title", or "(element) => …" with ref/selector.',
        },
        ref: REF,
        selector: SELECTOR,
        timeoutMs: { type: 'integer', minimum: 100, maximum: 10_000, description: '5000 by default.' },
      },
      ['name', 'function'],
    ),
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
      'Hand a page to the owner when you need them to act in it (a login, a captcha, a payment, a consent screen): their tab comes forward with "Your turn here". Then wait and read it.',
    inputSchema: object({ name: NAME, message: ASK_MESSAGE }, ['name']),
  },
  {
    name: 'browser_request_input',
    tool: 'browser.request_input',
    description:
      'Ask the owner for a login form on ONE card; the daemon types each field: plain (an e-mail you see) or secret (a password). Then input_wait. Next page: a new card with chain.',
    inputSchema: object(
      {
        name: NAME,
        prompt: INPUT_PROMPT,
        fields: {
          type: 'array',
          minItems: 1,
          maxItems: INPUT_MAX_FIELDS,
          items: object(
            {
              id: { type: 'string' },
              label: { type: 'string' },
              sensitivity: SENSITIVITY,
              ref: { type: 'string' },
              selector: { type: 'string' },
            },
            ['id', 'sensitivity'],
          ),
        },
        submit: INPUT_OPTIONS.submit,
        chain: INPUT_OPTIONS.chain,
      },
      ['name', 'prompt', 'fields'],
    ),
  },
  {
    name: 'secure_copy',
    tool: 'secure.copy',
    description:
      "Seal a command's stdout or a page element (a token) as sealed:<name>; you see its length, never the value. Seal before reading it.",
    inputSchema: object(
      {
        name: { type: 'string' },
        source: {
          type: 'object',
          description: '{"kind":"command","argv":["gh","auth","token"]} or {"kind":"browser","key":"app","ref":"e3"}',
        },
      },
      ['name', 'source'],
    ),
  },
  { name: 'secure_list', tool: 'secure.list', description: 'List copies.', inputSchema: object({}) },
  {
    name: 'secure_discard',
    tool: 'secure.discard',
    description: 'Drop a copy.',
    inputSchema: object({ handle: { type: 'string' } }, ['handle']),
  },
  {
    name: 'secure_paste',
    tool: 'secure.paste',
    description:
      'Paste sealed:<name> into your terminal or a page field, or save it as a secret, once allowed; then input_wait.',
    inputSchema: object(
      {
        handle: { type: 'string' },
        to: {
          type: 'object',
          description:
            '{"kind":"terminal","name":"dev"}, {"kind":"browser","name":"app","ref":"e3"} or {"kind":"secret","name":"VERCEL_TOKEN"}',
        },
        prompt: { type: 'string' },
      },
      ['handle', 'to', 'prompt'],
    ),
  },
  {
    name: 'secure_preapprove',
    tool: 'secure.preapprove',
    description: 'Ask the owner to approve planned pastes in advance.',
    inputSchema: object(
      { items: { type: 'array', description: '[{from:{kind,program|origin},to:{kind,program|origin},why}]' } },
      ['items'],
    ),
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
      'File a lesson for the owner to review: a correction they made, or a durable fact about how they want work done. Use scope "repo" for a fact about this project, "global" for one every ferret should follow. A duplicate merges into the existing one.',
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
