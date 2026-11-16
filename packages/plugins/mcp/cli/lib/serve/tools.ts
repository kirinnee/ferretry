/**
 * The Ferretry tools as an MCP server shows them.
 *
 * Every input schema is plain JSON Schema written out by hand, because 5.0's zod inputs carry no `.describe()` and
 * `z.toJSONSchema` alone would lose every field's words. The daemon validates the call again against the tool's own
 * zod input, so these only have to describe the inputs well enough for a model to fill them in; the parity test pins
 * the property names of each row to its zod input, so a tool whose input changed fails there.
 *
 * LIMITS ARE LITERALS. The mcp manifest does not consume the terminals, browsers, vault or lessons contracts, so this
 * half may not import them (`contract-consumes`); `tools-limits.test.ts` pins each number to its owner's constant.
 */

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** Terminals' `AGENT_TOOL_MAX_READ_LINES`. */
const AGENT_TOOL_MAX_READ_LINES = 2_000;
/** Terminals' `AGENT_TOOL_MAX_WAIT_MS`: the longest one call to the daemon waits. */
export const AGENT_TOOL_MAX_WAIT_MS = 25_000;
/** Terminals' `AGENT_TOOL_DEFAULT_WAIT_MS`. */
export const AGENT_TOOL_DEFAULT_WAIT_MS = 10_000;
/** The longest a wait may last in all: this server asks the daemon in slices of {@link AGENT_TOOL_MAX_WAIT_MS}. */
export const AGENT_TOOL_MAX_TOTAL_WAIT_MS = 120_000;
/** Terminals' `TERMINAL_KEYS`. */
const TERMINAL_KEYS = [
  'enter',
  'tab',
  'escape',
  'backspace',
  'delete',
  'space',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'page-up',
  'page-down',
  'ctrl-a',
  'ctrl-c',
  'ctrl-d',
  'ctrl-e',
  'ctrl-k',
  'ctrl-l',
  'ctrl-r',
  'ctrl-u',
  'ctrl-w',
  'ctrl-z',
] as const;
/** Lessons' `LESSON_RULE_MAX_CHARS`. */
const LESSON_RULE_MAX_CHARS = 500;
/** Browsers' `BROWSER_CONSOLE_LEVELS`. */
const BROWSER_CONSOLE_LEVELS = ['error', 'warning', 'info', 'log', 'debug'] as const;
/** Browsers' `BROWSER_CPU_THROTTLE_MAX`. */
const BROWSER_CPU_THROTTLE_MAX = 20;
/** Browsers' `BROWSER_EMULATED_PERMISSIONS`. */
const BROWSER_EMULATED_PERMISSIONS = [
  'geolocation',
  'notifications',
  'midi',
  'clipboard-write',
  'accelerometer',
  'gyroscope',
  'magnetometer',
  'background-sync',
] as const;
/** Browsers' `BROWSER_RESOURCE_TYPES`. */
const BROWSER_RESOURCE_TYPES = [
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'texttrack',
  'xhr',
  'fetch',
  'eventsource',
  'websocket',
  'manifest',
  'other',
] as const;
/** Vault's `INPUT_MAX_EXPIRY_SECONDS`, `INPUT_MAX_FIELDS` and `INPUT_PROMPT_MAX_LENGTH`. */
const INPUT_MAX_EXPIRY_SECONDS = 3_600;
const INPUT_MAX_FIELDS = 4;
const INPUT_PROMPT_MAX_LENGTH = 280;
/** Accounts' `LOGIN_RECIPE_MAX_LENGTH` and its proposal reason's limit. */
const LOGIN_RECIPE_MAX_LENGTH = 4_000;
const LOGIN_PROPOSAL_WHY_MAX_LENGTH = 280;

const NAME = {
  type: 'string',
  description: 'The name, like %terminal:dev or %browser:app, or a listed id.',
};
const NEW_NAME = {
  type: 'string',
  pattern: '^[a-z][a-z0-9-]{0,31}$',
  description: 'A short name you choose, e.g. "dev" or "app".',
};
const ASK_OWNER = {
  type: ['boolean', 'string'],
  description:
    'Hand it to the owner now: their tab opens on it. true, or one plain sentence saying what to do there. Never a secret.',
};
const ASK_MESSAGE = {
  type: 'string',
  description: 'A short plain sentence saying exactly what the owner should do there. Never a secret.',
};
const URL = { type: 'string', description: 'An http or https URL.' };
const SELECTOR = { type: 'string', description: 'A CSS or Playwright selector, e.g. "button[type=submit]".' };
const REF = {
  type: 'string',
  description: 'A ref from browser_read "snapshot", e.g. "e12"; or selector.',
};
const COORDINATE = { type: 'number', minimum: 0, description: 'Viewport CSS pixels.' };
const INPUT_PROMPT = {
  type: 'string',
  maxLength: INPUT_PROMPT_MAX_LENGTH,
  description: 'What it is for. Never a secret.',
};
const SENSITIVITY = { type: 'string', enum: ['secret', 'code', 'private', 'plain'] };
/** A push approval: no prompt, nothing typed; the daemon reads the number, never the ferret. */
const PUSH = { type: 'boolean', description: 'Approve on your phone (tap Yes/number): no prompt. Wait: pa_ id.' };
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
    description: 'Account you expect, by handle (SUDO_KIRIN_BOX): a hint only, the owner still taps.',
  },
};

const object = (properties: Record<string, unknown>, required: readonly string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length === 0 ? {} : { required }),
  additionalProperties: false,
});

/** The tools, each with the wire tool it is. */
const TERMINAL_AND_BROWSER_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'terminal_list',
    description: 'List the terminals open in your session, by name.',
    inputSchema: object({}),
  },
  {
    name: 'terminal_open',
    description:
      'Open a terminal (a shell) with a name, optionally in a folder, running a command. The person sees it as a tab named %terminal:<name>.',
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
    description: 'Read the last lines a terminal shows.',
    inputSchema: object({ name: NAME, lines: { type: 'integer', minimum: 1, maximum: AGENT_TOOL_MAX_READ_LINES } }, [
      'name',
    ]),
  },
  {
    name: 'terminal_wait',
    description: 'Wait for "text" to appear, or the running command to end ("exit": true).',
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
    description: 'Close a terminal, ending its shell.',
    inputSchema: object({ name: NAME }, ['name']),
  },
  {
    name: 'terminal_ask_owner',
    description:
      'Hand a terminal to the owner to act in it (a password, a code, "press Enter"): their tab comes forward ("Your turn here"). Then wait and read it.',
    inputSchema: object({ name: NAME, message: ASK_MESSAGE }, ['name']),
  },
  {
    name: 'terminal_request_input',
    description:
      'Ask the owner to type ONE value into a terminal from a card: secret (a password; ALWAYS for sudo), code (a 2FA, email, SMS or device code; you see it), private (shows, not one-time) or plain (you see it). Returns !A<n>; then input_wait.',
    inputSchema: object(
      {
        name: NAME,
        prompt: INPUT_PROMPT,
        sensitivity: SENSITIVITY,
        label: { type: 'string' },
        push: PUSH,
        ...INPUT_OPTIONS,
      },
      ['name'],
    ),
  },
  {
    name: 'input_wait',
    description:
      'Wait for the owner to answer your input card (!A<n>): where it stands, then the screen with the value masked. Never the value.',
    inputSchema: object(
      {
        id: { type: 'string', description: 'The card, like !A7, or a pa_ id.' },
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
    name: 'account_hint',
    description:
      "Before a sign-in: the owner's sign-ins for a page or site (id, account, method, username, recipe). Never a value.",
    inputSchema: object({ name: NAME, site: { type: 'string', description: 'Or a host or URL.' } }),
  },
  {
    name: 'account_propose',
    description:
      'After a sign-in, propose its recipe (Markdown steps, no values; [[ID]] names another account) and/or preapprove: suggest a standing rule. The owner decides.',
    inputSchema: object(
      {
        signIn: { type: 'string', description: 'Its id from account_hint, like si_3f2a….' },
        recipe: { type: 'string', maxLength: LOGIN_RECIPE_MAX_LENGTH, description: 'The whole new recipe.' },
        preapprove: { type: 'boolean', description: 'Also suggest a standing rule.' },
        why: { type: 'string', maxLength: LOGIN_PROPOSAL_WHY_MAX_LENGTH, description: 'One line: what changed.' },
      },
      ['signIn', 'why'],
    ),
  },
  {
    name: 'browser_list',
    description: 'List the browser pages open in your session, by name.',
    inputSchema: object({}),
  },
  {
    name: 'browser_open',
    description:
      'Open a named browser page, optionally at a URL. The person sees it live as %browser:<name>. Pages share this machine’s agent sign-ins; "incognito": true gives a throwaway one.',
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
    description: 'Load a URL in a page, or go back, forward or reload.',
    inputSchema: object({ name: NAME, url: URL, history: { type: 'string', enum: ['back', 'forward', 'reload'] } }, [
      'name',
    ]),
  },
  {
    name: 'browser_click',
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
    description:
      'Fill a field (ref or selector), replacing its text. submit presses Enter after; slowly types key by key. Never a secret.',
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
    description:
      'Read a page: visible text, or mode "snapshot" (use it first): the accessibility tree with a ref per element for other tools. find: only lines with that text.',
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
    description:
      'Answer the dialog (alert, confirm, prompt, beforeunload) a page waits on; a browser result says when one is open. Dismissed after 30 s unanswered. promptText answers a prompt.',
    inputSchema: object(
      { name: NAME, action: { type: 'string', enum: ['accept', 'dismiss'] }, promptText: { type: 'string' } },
      ['name', 'action'],
    ),
  },
  {
    name: 'browser_tabs',
    description:
      'list: your pages and the popups they opened (available: false means not yours). adopt: name a popup (id from the list) to use it. Never switches the person’s tab.',
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
    description:
      'Wait for one thing: an element (ref or selector, with state), text, textGone, url (part of the address), load, or time (ms). Says if it happened in time.',
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
    description:
      'list: recent requests with ids. get: one by id, with safe response headers and a text body. Cookies and credentials are never shown.',
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
    description: 'Make a page act like another device or setting; reset undoes it. Never the user agent.',
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
          print: { type: 'boolean', description: 'As for print.' },
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
    description:
      'Give a page files: a file input or its picker (ref or selector). files: paths in your working folder, or {"attachment": "att_…"}. mode "drop": onto a dropzone. Needs the files switch.',
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
    description:
      'Save a file the page downloaded (a result says "a download started … id dl-1") into your working folder as downloads/<name>, or saveAs. Needs the files switch.',
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
    description:
      'Print the page to a PDF in your working folder (downloads/<title>.pdf, or saveAs). Needs headless mode and the files switch.',
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
    description: 'Move the pointer over an element (ref or selector) or a point (x, y): menus, tooltips, hover states.',
    inputSchema: object({ name: NAME, ref: REF, selector: SELECTOR, x: COORDINATE, y: COORDINATE }, ['name']),
  },
  {
    name: 'browser_drag',
    description:
      'Drag between elements (fromRef/fromSelector to toRef/toSelector) or points (fromX, fromY to toX, toY, in steps): sliders, canvases, maps.',
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
    description:
      'Press up to 32 keys in order, e.g. ["Enter"], ["Control+Shift+K"]. Modifiers: Alt, Control, ControlOrMeta, Meta, Shift, plus one key. ref/selector focuses an element first. Never a secret.',
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
    description:
      'Scroll: an element into view (ref or selector), to the first place a text shows, by deltaX/deltaY pixels, or by pages (1 is a screen down, -1 up; up to ±20).',
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
    description: 'Choose options of a select (ref or selector), by value or label. Up to 64.',
    inputSchema: object(
      { name: NAME, ref: REF, selector: SELECTOR, values: { type: 'array', items: { type: 'string' }, minItems: 1 } },
      ['name', 'values'],
    ),
  },
  {
    name: 'browser_check',
    description: 'Tick (checked true) or untick (false) a checkbox or radio button (ref or selector).',
    inputSchema: object({ name: NAME, ref: REF, selector: SELECTOR, checked: { type: 'boolean' } }, [
      'name',
      'checked',
    ]),
  },
  {
    name: 'browser_fill_form',
    description:
      'Fill up to 32 fields at once. Each: ref or selector, plus exactly one of text, checked, option (select), value (slider, date, colour). Never a secret: a password field is flagged.',
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
    description: 'Outline an element (ref or selector) for the person watching. clear: true removes it.',
    inputSchema: object({ name: NAME, ref: REF, selector: SELECTOR, clear: { type: 'boolean' } }, ['name']),
  },
  {
    name: 'browser_eval',
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
    description: 'Close a page.',
    inputSchema: object({ name: NAME }, ['name']),
  },
  {
    name: 'browser_ask_owner',
    description:
      'Hand a page to the owner to act in it (a captcha, a payment, a consent screen): their tab comes forward ("Your turn here"). Then wait and read it.',
    inputSchema: object({ name: NAME, message: ASK_MESSAGE }, ['name']),
  },
  {
    name: 'browser_request_input',
    description:
      'Ask the owner for a login form on ONE card; the daemon types each field: plain (an e-mail you see), secret (a password) or code (a 2FA, email or SMS code). Then input_wait. Next page: a new card with chain.',
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
        push: PUSH,
      },
      ['name'],
    ),
  },
  {
    name: 'secure_copy',
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
  { name: 'secure_list', description: 'List copies.', inputSchema: object({}) },
  {
    name: 'secure_discard',
    description: 'Drop a copy.',
    inputSchema: object({ handle: { type: 'string' } }, ['handle']),
  },
  {
    name: 'secure_paste',
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
    name: 'task_plan',
    description: 'Before a task, ask the owner once to pre-approve its sign-ins and pastes.',
    inputSchema: object(
      {
        lines: {
          type: 'array',
          description:
            '{kind,uses,why} and: sign-in signIn|site,fields:[username,password,totp]; terminal-sign-in signIn|place; paste from,to',
        },
        expiresInSeconds: { type: 'integer' },
      },
      ['lines'],
    ),
  },
];

const CONFIG_PATH = {
  type: 'string',
  description:
    'A config file: machine.yaml, warden.yaml, learning.yaml, voice.yaml, account-defaults.yaml, logins/<id>.yaml, profiles/<name>.yaml, runtimes/<name>.yaml or components/<kind>/<name>.yaml.',
};
const CONFIG_TEXT = {
  type: 'string',
  description: 'The whole file, as YAML. Never a secret value: write ${secret:NAME} and ask the owner to store it.',
};

/**
 * The `config.*` tools (docs/config-files.md): this machine's configuration files, read, checked and
 * written. Refused unless the owner turned on "What agents may control › Ferretry settings"; even then a
 * write that loosens what the machine allows waits for the owner's confirmation.
 */
const CONFIG_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'config_read',
    description:
      'Read this machine’s Ferretry configuration: no path: every file and problem; a path: that file’s text and etag (pass it to config_write).',
    inputSchema: object({ path: CONFIG_PATH }),
  },
  {
    name: 'config_validate',
    description:
      'Check a config file’s text as if it were written, without writing it. Answers each problem with its line and the fix.',
    inputSchema: object({ path: CONFIG_PATH, text: CONFIG_TEXT }, ['path', 'text']),
  },
  {
    name: 'config_write',
    description:
      'Write a config file. Refused unless it checks. A change that loosens spending or what agents may do waits for the owner to confirm; tell them.',
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
const LESSON_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'lessons_suggest',
    description:
      'File a lesson for the owner to review: a correction they made, or a lasting preference. scope "repo": this project only; "global": every ferret. A duplicate merges.',
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
 * The `search_work` tool: cards and agenda items by what they say, so a ferret finds the work that already
 * covers its idea before filing a second one. Read-only; the daemon decides what the caller may see.
 */
const SEARCH_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'search_work',
    description: 'Find cards and agenda items by words or id (F303) before filing a duplicate; all adds old closed.',
    inputSchema: object(
      {
        query: { type: 'string', minLength: 1, maxLength: 200 },
        kind: { type: 'string', enum: ['task', 'agenda'] },
        open: { type: 'boolean' },
        all: { type: 'boolean' },
      },
      ['query'],
    ),
  },
];

/**
 * The `instructions` tool: which of its own system-prompt sections this ferret launched with, and how the
 * owner turns each on. Ferrets answers it from the launch environment it stored, so this server just forwards it.
 */
const INSTRUCTIONS_TOOL: McpToolDefinition = {
  name: 'instructions',
  description:
    'Which Ferretry sections your prompt launched with (hypermedia, Pack mode, agenda mode, lessons) and how to turn each on. Check before saying one is missing.',
  inputSchema: object({}),
};

/** The card progress tool (Board's `card_progress`; new in 5.0, no v4 row). */
const CARD_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'card_progress',
    description: 'Rewrite one card’s progress (now, doneSoFar, next).',
    inputSchema: object(
      {
        card: {
          type: 'string',
          pattern: '^[BFIC][1-9][0-9]{0,8}$',
          description: 'The card id, like F12 (letter B, F, I or C, then a number).',
        },
        now: { type: 'string', maxLength: 8_192 },
        doneSoFar: { type: 'string', maxLength: 8_192 },
        next: { type: 'string', maxLength: 8_192 },
      },
      ['card'],
    ),
  },
];

/**
 * Agent tools whose owner (Accounts) has not built them. An agent is not told to use a tool that cannot work (M2 ruling), so
 * the owner's manifest no longer declares them and this list keeps their definitions out of what the server lists, whatever
 * a manifest declares later; the parity test pins both.
 */
const UNBUILT_TOOLS: ReadonlySet<string> = new Set(['account_propose', 'task_plan']);

/** Every tool this server lists, in the order a model reads them: the built ones only. */
export const MCP_TOOLS: readonly McpToolDefinition[] = [
  ...TERMINAL_AND_BROWSER_TOOLS,
  ...CONFIG_TOOLS,
  ...LESSON_TOOLS,
  ...SEARCH_TOOLS,
  ...CARD_TOOLS,
  INSTRUCTIONS_TOOL,
].filter(tool => !UNBUILT_TOOLS.has(tool.name));
