import { z } from 'zod';
import { AgendaIdSchema } from './agenda.ts';
import {
  BROWSER_CONSOLE_MAX_LIMIT,
  BROWSER_DIALOG_PROMPT_MAX_CHARS,
  BROWSER_NETWORK_FILTER_MAX_CHARS,
  BROWSER_RESOURCE_TYPES,
  BROWSER_WAIT_MAX_MS,
  BROWSER_WAIT_TEXT_MAX_CHARS,
  BrowserConsoleLevelSchema,
  BrowserDialogActionSchema,
  BrowserElementStateSchema,
  BrowserEmulationShape,
  BrowserLoadStateSchema,
  BrowserRequestIdSchema,
  BrowserResourceTypeSchema,
} from './browser-page-lifecycle.ts';
import {
  BROWSER_MAX_SCROLL_TEXT_CHARS,
  BrowserMouseActionSchema,
  BrowserPressKeysSchema,
  BrowserScrollDeltaSchema,
  BrowserScrollPagesSchema,
  BrowserSelectValuesSchema,
  browserDragShape,
  browserFormFieldsOf,
  refineBrowserDrag,
  refineBrowserHighlight,
  refineBrowserMouse,
  refineBrowserScroll,
} from './browser-pointer.ts';
import {
  BROWSER_MAX_FIND_CHARS,
  BROWSER_MAX_SNAPSHOT_DEPTH,
  BrowserCoordinateSchema,
  BrowserModifierSchema,
  BrowserMouseButtonSchema,
  BrowserReadModeSchema,
  BrowserRefSchema,
  BrowserScreenshotFormatSchema,
  refineBrowserRead,
  refineBrowserScreenshot,
  refineBrowserTarget,
} from './browser-target.ts';
import { InstantSchema } from './common.ts';
import {
  INPUT_FIELD_LABEL_MAX_LENGTH,
  INPUT_MAX_EXPIRY_SECONDS,
  INPUT_MAX_FIELDS,
  INPUT_PROMPT_MAX_LENGTH,
  InputAgentViewSchema,
  InputFieldIdSchema,
  InputSensitivitySchema,
  InputSubmitModeSchema,
} from './input-request.ts';
import { LoginEntryIdSchema, LoginHintListSchema } from './login-entries.ts';
import { LoginRecipeProposedSchema, LoginRecipeProposeRequestSchema, LoginRecipeSchema } from './login-recipes.ts';
import { SecretNameSchema } from './secrets.ts';
import {
  COPY_MAX_LIFETIME_SECONDS,
  COPY_MAX_LIVE_PER_SESSION,
  COPY_PLAN_MAX_ITEMS,
  COPY_PLAN_MAX_LIFETIME_SECONDS,
  CopyCommandReportSchema,
  CopyHandleSchema,
  CopyMetaSchema,
  CopyNameSchema,
  CopyPlanItemSchema,
  CopyPlanSchema,
  CopySourceSchema,
} from './secure-copy.ts';
import { SurfaceKeySchema, SurfaceKindSchema, SurfaceNameSchema } from './surface-names.ts';

export * from './surface-names.ts';

/**
 * AGENT TOOLS — the wire an agent (and a script, and a person) drives terminals and browser pages
 * through, by NAME.
 *
 * Every terminal and browser page an agent works with carries a short human name — `dev`, `app` —
 * that the agent and the person share: the person writes `%terminal:dev`, the agent calls
 * `terminal.send` with `name: "dev"`, and both mean the same shell. The daemon stores the name beside
 * the surface it names and keeps it unique within the session.
 *
 * WHO MAY CALL WHAT. Two routes carry the same call body (`AgentToolCallSchema`):
 *
 * - `POST /v1/agent/tools` is the AGENT's. It names no session: the daemon derives the session from the
 *   session credential the caller presents on the `x-fy-session-capability` header, which the daemon
 *   minted into that session's own environment and keeps only a hash of. It is served to the host's
 *   own admin token arriving over loopback and nothing else, so an agent reaches only surfaces of its
 *   own session on its own machine.
 * - `POST /v1/sessions/:sessionId/surfaces/terminals/tools` and `…/surfaces/browser/tools` are a PERSON's (the CLI, the
 *   app), and accept only that kind's tools. They name the session in the path, are governed by the `terminal` / `browser` grants like
 *   every other surface route, and refuse an agent that identifies itself.
 *
 * WHAT IS BOUNDED. Every text field below has a ceiling, the wait has a ceiling under the daemon's
 * own idle timeout, and a read is clipped to {@link AGENT_TOOL_MAX_OUTPUT_CHARS}. The audit log
 * records each call by tool and surface name with lengths only — never the typed text.
 */

/** The longest text one `terminal.send` or `browser.type` carries. */
export const AGENT_TOOL_MAX_TEXT_CHARS = 16_384;
/** The most named keys one `terminal.send` carries. */
export const AGENT_TOOL_MAX_KEYS = 64;
/** How many lines `terminal.read` returns when asked for none, and the most it returns. */
export const AGENT_TOOL_DEFAULT_READ_LINES = 200;
export const AGENT_TOOL_MAX_READ_LINES = 2_000;
/** The most text one read or wait hands back. The tail is kept: the newest output is what matters. */
export const AGENT_TOOL_MAX_OUTPUT_CHARS = 65_536;
/**
 * The longest one daemon-side wait may last, and its default. Under the HTTP server's own 30 s idle
 * timeout on purpose: a longer wait would be cut by the server and read as a failure. A client that
 * wants longer waits again — `fy` and the MCP server both loop up to {@link AGENT_TOOL_MAX_TOTAL_WAIT_MS}.
 */
export const AGENT_TOOL_MAX_WAIT_MS = 25_000;
export const AGENT_TOOL_DEFAULT_WAIT_MS = 10_000;
/** The longest a client may ask one `terminal.wait` tool call to last in total. */
export const AGENT_TOOL_MAX_TOTAL_WAIT_MS = 120_000;
/** The longest URL an agent may navigate to. */
export const AGENT_TOOL_MAX_URL_CHARS = 2_048;
/** The longest selector an agent may click, type into or read. */
export const AGENT_TOOL_MAX_SELECTOR_CHARS = 1_024;
/** The longest script one `browser.eval` carries. */
export const AGENT_TOOL_MAX_SCRIPT_CHARS = 4_096;
/** The longest one `browser.eval` may run, and how long it runs when asked for no limit. */
export const AGENT_TOOL_MAX_SCRIPT_MS = 10_000;
export const AGENT_TOOL_DEFAULT_SCRIPT_MS = 5_000;
/** The longest folder a terminal may be opened in. */
export const AGENT_TOOL_MAX_FOLDER_CHARS = 1_024;
/** The longest path an agent may name a file by (one to upload, or where to save one). */
export const AGENT_TOOL_MAX_PATH_CHARS = 1_024;
/** The most files one `browser.upload` carries. */
export const AGENT_TOOL_MAX_UPLOAD_FILES = 20;
/** The largest one file an upload may carry, and the most one call may carry in all. */
export const AGENT_TOOL_MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024;
export const AGENT_TOOL_MAX_UPLOAD_CALL_BYTES = 200 * 1024 * 1024;
/** The largest file a download or a PDF may be saved as. */
export const AGENT_TOOL_MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
/** The longest sentence an agent may leave the owner when it hands a surface over. */
export const AGENT_TOOL_MAX_ASK_CHARS = 280;

/**
 * The keys `terminal.send` can press, by name. A closed list rather than raw escape sequences: the
 * agent says what it means, and the daemon owns the bytes.
 */
export const TERMINAL_KEYS = [
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
export const TerminalKeySchema = z.enum(TERMINAL_KEYS);
export type TerminalKey = z.infer<typeof TerminalKeySchema>;

const TextSchema = z.string().min(1).max(AGENT_TOOL_MAX_TEXT_CHARS);

/** Only web pages: an agent has no business opening `file:`, `javascript:` or `chrome:` URLs. */
export const AgentUrlSchema = z
  .string()
  .max(AGENT_TOOL_MAX_URL_CHARS)
  .refine(
    value => URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol),
    'only http and https URLs can be opened',
  );

/** What the owner is asked to do when a surface is handed to them: a short plain sentence, never a secret. */
export const AskOwnerMessageSchema = z.string().trim().min(1).max(AGENT_TOOL_MAX_ASK_CHARS);

/** `true` asks the owner to take the surface over; a string says exactly what to do there. */
const AskOwnerSchema = z.union([z.literal(true), AskOwnerMessageSchema]);

const SelectorSchema = z.string().trim().min(1).max(AGENT_TOOL_MAX_SELECTOR_CHARS);

/** The element a browser act names: a ref from a page snapshot (`e12`), or a selector. */
const ElementTargetShape = { selector: SelectorSchema.optional(), ref: BrowserRefSchema.optional() };

const InputFieldLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(INPUT_FIELD_LABEL_MAX_LENGTH)
  .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'a label is one line');

/**
 * One field of a `browser.request_input` card: what it is called, how careful to be with it, and the element
 * it goes into (a snapshot's ref or a selector). `plain` is a value the ferret may see (an e-mail); `secret`
 * is a password.
 */
export const BrowserInputFieldSchema = z
  .strictObject({
    id: InputFieldIdSchema,
    label: InputFieldLabelSchema.optional(),
    sensitivity: InputSensitivitySchema,
    ...ElementTargetShape,
  })
  .superRefine(refineBrowserTarget({ point: false, required: true }));
export type BrowserInputField = z.infer<typeof BrowserInputFieldSchema>;

/**
 * A file an upload names: a path inside the session's own folder (relative to it, or absolute under it), or
 * an attachment the owner put in this session's chat (`att_` and its sha-256).
 */
export const ATTACHMENT_ID_PATTERN = /^att_[a-f0-9]{64}$/u;
export const AgentUploadFileSchema = z.union([
  z.string().trim().min(1).max(AGENT_TOOL_MAX_PATH_CHARS),
  z.strictObject({ attachment: z.string().regex(ATTACHMENT_ID_PATTERN, 'an attachment id is att_ and 64 hex digits') }),
]);
export type AgentUploadFile = z.infer<typeof AgentUploadFileSchema>;

/** How `browser.upload` hands files over: into a file input (or a file chooser), or dropped on a dropzone. */
export const BrowserUploadModeSchema = z.enum(['input', 'drop']);
export type BrowserUploadMode = z.infer<typeof BrowserUploadModeSchema>;

/** Where a saved file goes: a path inside the session's own folder. */
const SaveAsSchema = z.string().trim().min(1).max(AGENT_TOOL_MAX_PATH_CHARS);

/** Where in history `browser.navigate` goes instead of to a URL. */
export const BrowserHistoryStepSchema = z.enum(['back', 'forward', 'reload']);

const AgentToolCallBodySchema = z.discriminatedUnion('tool', [
  z.strictObject({ tool: z.literal('terminal.list') }),
  z.strictObject({
    tool: z.literal('terminal.open'),
    name: SurfaceNameSchema,
    /** Where the shell starts: absolute, or relative to the session's own folder. */
    folder: z.string().trim().min(1).max(AGENT_TOOL_MAX_FOLDER_CHARS).optional(),
    /** Typed into the new shell and run, as if sent with `enter`. */
    command: TextSchema.optional(),
    /** Hand the new shell to the owner at once: their tab opens on it, with this as what to do. */
    askOwner: AskOwnerSchema.optional(),
  }),
  z
    .strictObject({
      tool: z.literal('terminal.send'),
      name: SurfaceKeySchema,
      /** Typed as-is; a newline in it is Enter. */
      text: TextSchema.optional(),
      /** Pressed after the text, in order. */
      keys: z.array(TerminalKeySchema).min(1).max(AGENT_TOOL_MAX_KEYS).optional(),
    })
    .refine(call => call.text !== undefined || call.keys !== undefined, 'send needs text, keys, or both'),
  z.strictObject({
    tool: z.literal('terminal.read'),
    name: SurfaceKeySchema,
    lines: z.number().int().min(1).max(AGENT_TOOL_MAX_READ_LINES).optional(),
  }),
  z
    .strictObject({
      tool: z.literal('terminal.wait'),
      name: SurfaceKeySchema,
      /** Wait until this text appears in the terminal's recent output. */
      text: z.string().min(1).max(1_024).optional(),
      /** Wait until the running command ends and the shell is back at its prompt. */
      exit: z.literal(true).optional(),
      timeoutMs: z.number().int().min(100).max(AGENT_TOOL_MAX_WAIT_MS).optional(),
    })
    .refine(call => (call.text === undefined) !== (call.exit === undefined), 'wait for text or for exit, not both'),
  z.strictObject({ tool: z.literal('terminal.close'), name: SurfaceKeySchema }),
  z.strictObject({
    tool: z.literal('terminal.request_input'),
    name: SurfaceKeySchema,
    /** What the owner is told the value is for: shown as "the agent says", never as fact. */
    prompt: z.string().trim().min(1).max(INPUT_PROMPT_MAX_LENGTH),
    sensitivity: InputSensitivitySchema,
    submit: InputSubmitModeSchema.optional(),
    expiresInSeconds: z.number().int().min(30).max(INPUT_MAX_EXPIRY_SECONDS).optional(),
    blocking: z.boolean().optional(),
    chain: AgendaIdSchema.optional(),
    /** The saved login the agent expects; a hint only, the daemon decides what matches. */
    secretHint: LoginEntryIdSchema.optional(),
    /** What the card calls the value ("Passphrase"); the daemon words one from the sensitivity when absent. */
    label: InputFieldLabelSchema.optional(),
  }),
  z.strictObject({
    tool: z.literal('browser.request_input'),
    name: SurfaceKeySchema,
    /** What the owner is told the values are for: shown as "the agent says", never as fact. */
    prompt: z.string().trim().min(1).max(INPUT_PROMPT_MAX_LENGTH),
    /** The values, in the order they are typed: each with its own sensitivity and its own element. */
    fields: z
      .array(BrowserInputFieldSchema)
      .min(1)
      .max(INPUT_MAX_FIELDS)
      .refine(fields => new Set(fields.map(field => field.id)).size === fields.length, 'each field needs its own id'),
    /** Press Enter in the last field after typing: offered to the owner by default. */
    submit: InputSubmitModeSchema.optional(),
    expiresInSeconds: z.number().int().min(30).max(INPUT_MAX_EXPIRY_SECONDS).optional(),
    blocking: z.boolean().optional(),
    chain: AgendaIdSchema.optional(),
    secretHint: LoginEntryIdSchema.optional(),
  }),
  z.strictObject({
    tool: z.literal('input.wait'),
    /** The card raised by `*.request_input`, written `!A7` or `A7`. */
    id: z
      .string()
      .trim()
      .transform(value => value.replace(/^!/u, ''))
      .pipe(AgendaIdSchema),
    timeoutMs: z.number().int().min(100).max(AGENT_TOOL_MAX_WAIT_MS).optional(),
  }),
  z
    .strictObject({
      tool: z.literal('account.hint'),
      /** A page of the agent's: the daemon reads the host from where the page IS, not from the agent. */
      name: SurfaceKeySchema.optional(),
      /** A site the agent is about to sign in to: a host, a URL or a `program@host`. */
      site: z.string().trim().min(1).max(AGENT_TOOL_MAX_URL_CHARS).optional(),
    })
    .refine(call => (call.name === undefined) !== (call.site === undefined), 'name a page or a site, not both'),
  /**
   * A ferret proposes the recipe of one saved login after signing in (login-recipes.ts): the whole new Markdown and
   * why. It is the ferret's words; it waits on the owner unless the owner allowed auto-apply for that login.
   */
  z.strictObject({
    tool: z.literal('account.propose'),
    login: LoginEntryIdSchema,
    recipe: LoginRecipeSchema,
    why: LoginRecipeProposeRequestSchema.shape.why,
  }),
  z.strictObject({
    tool: z.literal('terminal.ask_owner'),
    name: SurfaceKeySchema,
    message: AskOwnerMessageSchema.optional(),
  }),
  z.strictObject({ tool: z.literal('browser.list') }),
  z.strictObject({
    tool: z.literal('browser.open'),
    name: SurfaceNameSchema,
    url: AgentUrlSchema.optional(),
    /** A throwaway page with its own cookies and storage, shared with nothing; gone when it closes. */
    incognito: z.literal(true).optional(),
    /** Hand the new page to the owner at once: their tab opens on it, with this as what to do. */
    askOwner: AskOwnerSchema.optional(),
  }),
  z
    .strictObject({
      tool: z.literal('browser.navigate'),
      name: SurfaceKeySchema,
      url: AgentUrlSchema.optional(),
      /** Back, forward or reload, instead of a URL. */
      history: BrowserHistoryStepSchema.optional(),
    })
    .refine(call => (call.url === undefined) !== (call.history === undefined), 'navigate to a url or through history'),
  z
    .strictObject({
      tool: z.literal('browser.click'),
      name: SurfaceKeySchema,
      ...ElementTargetShape,
      /** A point in the viewport, in CSS pixels — for a canvas or anything a snapshot cannot name. */
      x: BrowserCoordinateSchema.optional(),
      y: BrowserCoordinateSchema.optional(),
      button: BrowserMouseButtonSchema.optional(),
      double: z.literal(true).optional(),
      modifiers: z.array(BrowserModifierSchema).max(5).optional(),
    })
    .superRefine(refineBrowserTarget({ point: true, required: true })),
  z
    .strictObject({
      tool: z.literal('browser.type'),
      name: SurfaceKeySchema,
      ...ElementTargetShape,
      text: z.string().max(AGENT_TOOL_MAX_TEXT_CHARS),
      /** Press Enter after the text. */
      submit: z.literal(true).optional(),
      /** One key at a time, for a field that reacts to each keystroke. */
      slowly: z.literal(true).optional(),
    })
    .superRefine(refineBrowserTarget({ point: false, required: true })),
  z
    .strictObject({
      tool: z.literal('browser.read'),
      name: SurfaceKeySchema,
      /**
       * `text` is the visible text; `a11y` is the accessibility tree; `snapshot` is that tree with a ref
       * beside every element, which every browser act accepts in place of a selector.
       */
      mode: BrowserReadModeSchema.optional(),
      ...ElementTargetShape,
      /** `snapshot` only: just the lines containing this text, each with its ref. */
      find: z.string().trim().min(1).max(BROWSER_MAX_FIND_CHARS).optional(),
      depth: z.number().int().min(1).max(BROWSER_MAX_SNAPSHOT_DEPTH).optional(),
      boxes: z.literal(true).optional(),
    })
    .superRefine(refineBrowserTarget({ point: false, required: false }))
    .superRefine(refineBrowserRead),
  z
    .strictObject({
      tool: z.literal('browser.screenshot'),
      name: SurfaceKeySchema,
      ...ElementTargetShape,
      fullPage: z.literal(true).optional(),
      format: BrowserScreenshotFormatSchema.optional(),
    })
    .superRefine(refineBrowserTarget({ point: false, required: false }))
    .superRefine(refineBrowserScreenshot),
  z
    .strictObject({
      tool: z.literal('browser.dialog'),
      name: SurfaceKeySchema,
      /** Answer the dialog the page is waiting on: accept it (OK) or dismiss it (Cancel). */
      action: BrowserDialogActionSchema,
      /** A `prompt` dialog's answer. */
      promptText: z.string().max(BROWSER_DIALOG_PROMPT_MAX_CHARS).optional(),
    })
    .refine(
      call => call.promptText === undefined || call.action === 'accept',
      'promptText answers a prompt, so it goes with accept',
    ),
  z
    .strictObject({
      tool: z.literal('browser.tabs'),
      action: z.enum(['list', 'adopt']),
      /** `adopt`: the popup to take on, by the id a list showed. */
      id: SurfaceKeySchema.optional(),
      /** `adopt`: the name to give it. */
      as: SurfaceNameSchema.optional(),
    })
    .refine(
      call =>
        call.action === 'adopt'
          ? call.id !== undefined && call.as !== undefined
          : call.id === undefined && call.as === undefined,
      'adopt needs the popup id and the name to give it; list takes neither',
    ),
  z
    .strictObject({
      tool: z.literal('browser.wait_for'),
      name: SurfaceKeySchema,
      ...ElementTargetShape,
      /** With a ref or selector: what the element should be. Defaults to visible. */
      state: BrowserElementStateSchema.optional(),
      text: z.string().min(1).max(BROWSER_WAIT_TEXT_MAX_CHARS).optional(),
      textGone: z.string().min(1).max(BROWSER_WAIT_TEXT_MAX_CHARS).optional(),
      /** A part of the page's address. */
      url: z.string().min(1).max(BROWSER_WAIT_TEXT_MAX_CHARS).optional(),
      load: BrowserLoadStateSchema.optional(),
      /** Just wait this many milliseconds. */
      time: z.number().int().min(1).max(BROWSER_WAIT_MAX_MS).optional(),
      timeoutMs: z.number().int().min(100).max(BROWSER_WAIT_MAX_MS).optional(),
    })
    .superRefine(refineBrowserTarget({ point: false, required: false }))
    .superRefine((call, context) => {
      const named = [call.selector ?? call.ref, call.text, call.textGone, call.url, call.load, call.time].filter(
        value => value !== undefined,
      ).length;
      if (named !== 1)
        context.addIssue({
          code: 'custom',
          message: 'wait for exactly one thing: a ref or selector, text, textGone, url, load or time',
        });
      if (call.state !== undefined && call.selector === undefined && call.ref === undefined)
        context.addIssue({ code: 'custom', message: 'state goes with a ref or selector' });
    }),
  z.strictObject({
    tool: z.literal('browser.console'),
    name: SurfaceKeySchema,
    /** This level and worse. */
    level: BrowserConsoleLevelSchema.optional(),
    /** Only entries after this number, as a previous call reported it. */
    since: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(BROWSER_CONSOLE_MAX_LIMIT).optional(),
  }),
  z
    .strictObject({
      tool: z.literal('browser.network'),
      name: SurfaceKeySchema,
      action: z.enum(['list', 'get']),
      /** `get`: the request to show, by the id a list named. */
      id: BrowserRequestIdSchema.optional(),
      /** `list`: only URLs containing this text. */
      filter: z.string().min(1).max(BROWSER_NETWORK_FILTER_MAX_CHARS).optional(),
      /** `list`: only these kinds of request. */
      types: z.array(BrowserResourceTypeSchema).min(1).max(BROWSER_RESOURCE_TYPES.length).optional(),
    })
    .superRefine((call, context) => {
      if (call.action === 'get' && call.id === undefined)
        context.addIssue({ code: 'custom', message: 'get needs the id of a request from a list' });
      if (call.action === 'list' && call.id !== undefined)
        context.addIssue({ code: 'custom', message: 'list takes a filter, not an id' });
      if (call.action === 'get' && (call.filter !== undefined || call.types !== undefined))
        context.addIssue({ code: 'custom', message: 'get takes an id, not a filter' });
    }),
  z
    .strictObject({ tool: z.literal('browser.emulate'), name: SurfaceKeySchema, ...BrowserEmulationShape })
    .refine(
      call => Object.entries(call).some(([key, value]) => key !== 'tool' && key !== 'name' && value !== undefined),
      'name something to emulate, or reset: true',
    ),
  z
    .strictObject({
      tool: z.literal('browser.upload'),
      name: SurfaceKeySchema,
      ...ElementTargetShape,
      files: z.array(AgentUploadFileSchema).min(1).max(AGENT_TOOL_MAX_UPLOAD_FILES),
      /** `input` (the default) fills a file input or answers the file chooser a click opens; `drop` drops them on a dropzone. */
      mode: BrowserUploadModeSchema.optional(),
    })
    .superRefine(refineBrowserTarget({ point: false, required: true })),
  z.strictObject({
    tool: z.literal('browser.download'),
    name: SurfaceKeySchema,
    /** Which download, by the id an act reported; the page's latest when absent. */
    id: z
      .string()
      .regex(/^dl-[a-z0-9]{1,16}$/u, 'a download id looks like dl-3')
      .optional(),
    /** Where to save it, inside the session's own folder; `downloads/<its name>` when absent. */
    saveAs: SaveAsSchema.optional(),
    /** Replace a file already there; without it an existing file is never touched. */
    overwrite: z.literal(true).optional(),
  }),
  z.strictObject({
    tool: z.literal('browser.pdf'),
    name: SurfaceKeySchema,
    /** Where to save it, inside the session's own folder; `downloads/<page title>.pdf` when absent. */
    saveAs: SaveAsSchema.optional(),
    overwrite: z.literal(true).optional(),
  }),
  z
    .strictObject({
      tool: z.literal('browser.hover'),
      name: SurfaceKeySchema,
      ...ElementTargetShape,
      x: BrowserCoordinateSchema.optional(),
      y: BrowserCoordinateSchema.optional(),
    })
    .superRefine(refineBrowserTarget({ point: true, required: true })),
  z
    .strictObject({
      tool: z.literal('browser.drag'),
      name: SurfaceKeySchema,
      ...browserDragShape(SelectorSchema),
    })
    .superRefine(refineBrowserDrag),
  z
    .strictObject({
      tool: z.literal('browser.mouse'),
      name: SurfaceKeySchema,
      action: BrowserMouseActionSchema,
      x: BrowserCoordinateSchema.optional(),
      y: BrowserCoordinateSchema.optional(),
      button: BrowserMouseButtonSchema.optional(),
      deltaX: BrowserScrollDeltaSchema.optional(),
      deltaY: BrowserScrollDeltaSchema.optional(),
    })
    .superRefine(refineBrowserMouse),
  z
    .strictObject({
      tool: z.literal('browser.press'),
      name: SurfaceKeySchema,
      keys: BrowserPressKeysSchema,
      /** Focus this element first. */
      ...ElementTargetShape,
    })
    .superRefine(refineBrowserTarget({ point: false, required: false })),
  z
    .strictObject({
      tool: z.literal('browser.scroll'),
      name: SurfaceKeySchema,
      ...ElementTargetShape,
      /** Scroll the first place this text shows up into view. */
      text: z.string().min(1).max(BROWSER_MAX_SCROLL_TEXT_CHARS).optional(),
      deltaX: BrowserScrollDeltaSchema.optional(),
      deltaY: BrowserScrollDeltaSchema.optional(),
      /** Screens: 1 is one screen down, -1 one screen up. */
      pages: BrowserScrollPagesSchema.optional(),
    })
    .superRefine(refineBrowserScroll),
  z
    .strictObject({
      tool: z.literal('browser.select'),
      name: SurfaceKeySchema,
      ...ElementTargetShape,
      values: BrowserSelectValuesSchema,
    })
    .superRefine(refineBrowserTarget({ point: false, required: true })),
  z
    .strictObject({
      tool: z.literal('browser.check'),
      name: SurfaceKeySchema,
      ...ElementTargetShape,
      /** `true` ticks, `false` unticks. */
      checked: z.boolean(),
    })
    .superRefine(refineBrowserTarget({ point: false, required: true })),
  z.strictObject({
    tool: z.literal('browser.fill_form'),
    name: SurfaceKeySchema,
    fields: browserFormFieldsOf(SelectorSchema),
  }),
  z
    .strictObject({
      tool: z.literal('browser.highlight'),
      name: SurfaceKeySchema,
      ...ElementTargetShape,
      clear: z.literal(true).optional(),
    })
    .superRefine(refineBrowserHighlight),
  z
    .strictObject({
      /**
       * OWNER-GATED: refused unless the owner has turned on "What agents may control › Page scripts".
       * The function runs in an isolated world of its own: the page's DOM, none of its JavaScript.
       */
      tool: z.literal('browser.eval'),
      name: SurfaceKeySchema,
      /** A function expression, `() => …`, or `(element) => …` with a ref or selector. */
      function: z.string().trim().min(1).max(AGENT_TOOL_MAX_SCRIPT_CHARS),
      ...ElementTargetShape,
      timeoutMs: z.number().int().min(100).max(AGENT_TOOL_MAX_SCRIPT_MS).optional(),
    })
    .superRefine(refineBrowserTarget({ point: false, required: false })),
  z.strictObject({ tool: z.literal('browser.close'), name: SurfaceKeySchema }),
  z.strictObject({
    tool: z.literal('browser.ask_owner'),
    name: SurfaceKeySchema,
    message: AskOwnerMessageSchema.optional(),
  }),
  z.strictObject({
    tool: z.literal('secure.copy'),
    /** The handle the copy is known by: `sealed:<name>`. */
    name: CopyNameSchema,
    source: CopySourceSchema,
    expiresInSeconds: z.number().int().min(60).max(COPY_MAX_LIFETIME_SECONDS).optional(),
  }),
  z.strictObject({ tool: z.literal('secure.list') }),
  z.strictObject({ tool: z.literal('secure.discard'), handle: CopyHandleSchema }),
  z.strictObject({
    tool: z.literal('secure.paste'),
    handle: CopyHandleSchema,
    /**
     * Where it goes: a terminal prompt the agent opened (the daemon observes what reads it), one field on a page
     * the agent opened (a snapshot's ref or a selector; the daemon observes the field and the page's origin), or
     * the secret store under a name (the daemon observes whether the name already holds a value).
     */
    to: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('terminal'), name: SurfaceKeySchema }),
      z
        .strictObject({ kind: z.literal('browser'), name: SurfaceKeySchema, ...ElementTargetShape })
        .superRefine(refineBrowserTarget({ point: false, required: true })),
      z.strictObject({ kind: z.literal('secret'), name: SecretNameSchema }),
    ]),
    /** What the paste is for, shown to the owner as the agent's words. */
    prompt: z.string().trim().min(1).max(INPUT_PROMPT_MAX_LENGTH),
    submit: InputSubmitModeSchema.optional(),
    expiresInSeconds: z.number().int().min(30).max(INPUT_MAX_EXPIRY_SECONDS).optional(),
  }),
  z.strictObject({
    tool: z.literal('secure.preapprove'),
    /** The pastes the agent plans, before it starts: one card, the owner ticks what it allows. */
    items: z.array(CopyPlanItemSchema).min(1).max(COPY_PLAN_MAX_ITEMS),
    expiresInSeconds: z.number().int().min(300).max(COPY_PLAN_MAX_LIFETIME_SECONDS).optional(),
  }),
]);

/** Names an older client still sends, read as the tool they became: every check downstream sees only the new name. */
const LEGACY_TOOL_NAMES: Readonly<Record<string, string>> = {
  'login.hint': 'account.hint',
  'login.propose': 'account.propose',
};

export const AgentToolCallSchema = z.preprocess(
  (raw: unknown) =>
    typeof raw === 'object' &&
    raw !== null &&
    'tool' in raw &&
    typeof raw.tool === 'string' &&
    raw.tool in LEGACY_TOOL_NAMES
      ? { ...raw, tool: LEGACY_TOOL_NAMES[raw.tool] }
      : raw,
  AgentToolCallBodySchema,
);
export type AgentToolCall = z.infer<typeof AgentToolCallSchema>;
export type AgentToolName = AgentToolCall['tool'];

/**
 * The tools that change nothing — they list, read, wait or look — plus the config tools that only read.
 *
 * A call to one of these that the daemon DROPPED mid-request (it was restarting) may be sent again
 * without anything happening twice, so a patient client repeats it (`daemon-restart.ts`). Every other
 * tool types, clicks, opens, closes or writes, and is repeated only when it provably never arrived.
 */
const REPEATABLE_AGENT_TOOLS: ReadonlySet<string> = new Set<string>([
  'terminal.list',
  'terminal.read',
  'terminal.wait',
  'input.wait',
  'account.hint',
  'login.hint',
  'secure.list',
  'browser.list',
  'browser.read',
  'browser.screenshot',
  'browser.tabs',
  'browser.wait_for',
  'browser.console',
  'config.read',
  'config.validate',
]);

/** Whether a tool, by its wire name, may be repeated after a dropped request. */
export const isRepeatableAgentTool = (tool: unknown): boolean =>
  typeof tool === 'string' && REPEATABLE_AGENT_TOOLS.has(tool);

/** Every tool, in the order an agent is shown them. */
export const AGENT_TOOL_NAMES: readonly AgentToolName[] = [
  'terminal.list',
  'terminal.open',
  'terminal.send',
  'terminal.read',
  'terminal.wait',
  'terminal.close',
  'terminal.ask_owner',
  'terminal.request_input',
  'input.wait',
  'account.hint',
  'account.propose',
  'browser.list',
  'browser.open',
  'browser.navigate',
  'browser.click',
  'browser.type',
  'browser.read',
  'browser.screenshot',
  'browser.dialog',
  'browser.tabs',
  'browser.wait_for',
  'browser.console',
  'browser.network',
  'browser.emulate',
  'browser.upload',
  'browser.download',
  'browser.pdf',
  'browser.hover',
  'browser.drag',
  'browser.mouse',
  'browser.press',
  'browser.scroll',
  'browser.select',
  'browser.check',
  'browser.fill_form',
  'browser.highlight',
  'browser.eval',
  'browser.close',
  'browser.ask_owner',
  'browser.request_input',
  'secure.copy',
  'secure.list',
  'secure.discard',
  'secure.paste',
  'secure.preapprove',
];

/** One surface as a list call shows it. An unnamed surface is still listed, by id. */
export const AgentSurfaceSchema = z.strictObject({
  id: z.string().min(1).max(128),
  name: SurfaceNameSchema.optional(),
  title: z.string().max(512),
  /** A throwaway browser page with its own cookies, shared with nothing. */
  incognito: z.literal(true).optional(),
  url: z
    .string()
    .max(AGENT_TOOL_MAX_URL_CHARS * 4)
    .optional(),
  /**
   * For an agent's listing only: whether this agent may act on it. An agent acts on what it opened,
   * and on what a person explicitly handed to it — never on a person's own shell or page by default,
   * nor on anything a person has taken over.
   */
  available: z.boolean().optional(),
  /** A popup: the page that opened it. Listed so an agent can tell which tabs are its own pages' popups. */
  openerId: z.string().min(1).max(128).optional(),
});
export type AgentSurface = z.infer<typeof AgentSurfaceSchema>;

/**
 * What one call answers. `summary` is always a plain sentence an agent can read; the rest depends on
 * the tool — output for a read or a wait, a PNG for a screenshot, a listing for a list.
 */
export const AgentToolResultSchema = z.strictObject({
  summary: z.string().min(1),
  output: z.string().max(AGENT_TOOL_MAX_OUTPUT_CHARS).optional(),
  /** `terminal.wait` only: whether what it waited for happened before the timeout. */
  matched: z.boolean().optional(),
  screenshotBase64: z.string().min(1).optional(),
  /** The screenshot's image type. Absent means PNG. */
  screenshotFormat: BrowserScreenshotFormatSchema.optional(),
  surfaces: z.array(AgentSurfaceSchema).optional(),
  /** `*.request_input` and `input.wait` only: where the request stands. */
  input: InputAgentViewSchema.optional(),
  /** `secure.*` only: what the agent may know about its copies (docs/secure-copy.md), never a value. */
  copies: z
    .array(CopyMetaSchema)
    .max(COPY_MAX_LIVE_PER_SESSION * 3)
    .optional(),
  /** `secure.copy` from a command: how it ended and its masked stderr, never its stdout. */
  command: CopyCommandReportSchema.optional(),
  /** `secure.preapprove` only: the plan card raised for the owner. */
  plan: CopyPlanSchema.optional(),
  /** `account.hint` only: the saved logins for the site, by their non-secret metadata. */
  logins: LoginHintListSchema.optional(),
  /** `account.propose` only: whether the recipe waits on the owner or was applied. */
  recipe: LoginRecipeProposedSchema.optional(),
});
export type AgentToolResult = z.infer<typeof AgentToolResultSchema>;

/**
 * An agent driving a surface right now — the "AGENT · Hadi is typing here" marker.
 *
 * `until` is when the marker lapses unless the agent acts again: the daemon republishes before it
 * does, so a reader shows the marker while `now < until` and needs no second event to clear it.
 */
export const SurfaceDrivingSchema = z.strictObject({
  surface: SurfaceKindSchema,
  /** The terminal id or browser page id — stable for the surface's life. */
  id: z.string().min(1).max(128),
  name: SurfaceNameSchema.optional(),
  agentSessionId: z.string().min(1).max(128),
  agentName: z.string().min(1).max(128).optional(),
  /** The page is incognito: its own throwaway cookies and storage. */
  incognito: z.literal(true).optional(),
  since: InstantSchema,
  until: InstantSchema,
});
export type SurfaceDriving = z.infer<typeof SurfaceDrivingSchema>;

/** An agent opened this surface: the workspace adds it as a tab. */
export const SurfaceOpenedSchema = z.strictObject({
  surface: SurfaceKindSchema,
  id: z.string().min(1).max(128),
  name: SurfaceNameSchema.optional(),
  agentSessionId: z.string().min(1).max(128),
  agentName: z.string().min(1).max(128).optional(),
  incognito: z.literal(true).optional(),
  at: InstantSchema,
});
export type SurfaceOpened = z.infer<typeof SurfaceOpenedSchema>;

/** An agent handed this surface to the owner: their tab comes forward with "Your turn here". */
export const SurfaceAskedSchema = z.strictObject({
  surface: SurfaceKindSchema,
  id: z.string().min(1).max(128),
  name: SurfaceNameSchema.optional(),
  agentSessionId: z.string().min(1).max(128),
  agentName: z.string().min(1).max(128).optional(),
  incognito: z.literal(true).optional(),
  /** What the owner is asked to do there. */
  message: AskOwnerMessageSchema.optional(),
  at: InstantSchema,
});
export type SurfaceAsked = z.infer<typeof SurfaceAskedSchema>;

/** Who took a surface over: a paired device (a person holding it), or somebody at this machine. */
export const SurfaceControllerSchema = z.discriminatedUnion('by', [
  z.strictObject({ by: z.literal('human'), deviceId: z.string().min(1).max(128) }),
  z.strictObject({ by: z.literal('local') }),
]);
export type SurfaceController = z.infer<typeof SurfaceControllerSchema>;

/** A person holding a surface: agent tool calls on it are refused until they hand it back. */
export const SurfaceTakeoverSchema = z.strictObject({
  surface: SurfaceKindSchema,
  id: z.string().min(1).max(128),
  name: SurfaceNameSchema.optional(),
  by: SurfaceControllerSchema,
  since: InstantSchema,
});
export type SurfaceTakeover = z.infer<typeof SurfaceTakeoverSchema>;

/** A surface a person opened and then handed to the agent, so the agent may act on it. */
export const SurfaceHandedSchema = z.strictObject({
  surface: SurfaceKindSchema,
  id: z.string().min(1).max(128),
  name: SurfaceNameSchema.optional(),
  by: SurfaceControllerSchema,
  at: InstantSchema,
});
export type SurfaceHanded = z.infer<typeof SurfaceHandedSchema>;

/**
 * `GET /v1/sessions/:sessionId/surfaces/terminals/control` and `…/surfaces/browser/control` — one kind
 * each, so each is governed by that kind's grant — and the answer to every control change.
 */
export const SurfaceControlViewSchema = z.strictObject({
  sessionId: z.string().min(1),
  driving: z.array(SurfaceDrivingSchema),
  takeovers: z.array(SurfaceTakeoverSchema),
  handed: z.array(SurfaceHandedSchema),
  /** Surfaces an agent opened and that are still alive. Absent from an older daemon. */
  opened: z.array(SurfaceOpenedSchema).default([]),
  /** Surfaces an agent handed to the owner and that the owner has not taken over since. */
  asked: z.array(SurfaceAskedSchema).default([]),
});
export type SurfaceControlView = z.infer<typeof SurfaceControlViewSchema>;

/**
 * `POST /v1/sessions/:sessionId/surfaces/terminals/control` and `…/surfaces/browser/control`: a person takes a surface
 * over from the agent, or hands it back. The answer is the session's {@link SurfaceControlViewSchema}.
 */
export const SurfaceControlRequestSchema = z.strictObject({
  /**
   * `takeover` holds a surface (for a browser: the WHOLE browser — every page shares one active tab and
   * one input stream); `handback` ends a takeover; `handover` gives the agent a surface a person opened,
   * which it may otherwise not touch.
   */
  action: z.enum(['takeover', 'handback', 'handover']),
  /** The surface's name or id. */
  key: SurfaceKeySchema,
});
export type SurfaceControlRequest = z.infer<typeof SurfaceControlRequestSchema>;

/**
 * The session-journal events control changes are published as, on the existing `/v1/events` feed.
 * `surface.driving` carries {@link SurfaceDrivingSchema}; `surface.takeover` carries
 * {@link SurfaceTakeoverSchema}; `surface.handback` carries {@link SurfaceHandbackSchema}; `surface.handed`
 * carries {@link SurfaceHandedSchema}; `surface.opened` carries {@link SurfaceOpenedSchema} and `surface.asked`
 * carries {@link SurfaceAskedSchema}. The daemon replays them on start, so a takeover outlives a restart.
 */
export const SURFACE_EVENT_TYPES = {
  driving: 'surface.driving',
  takeover: 'surface.takeover',
  handback: 'surface.handback',
  handed: 'surface.handed',
  opened: 'surface.opened',
  asked: 'surface.asked',
} as const;

export const SurfaceHandbackSchema = z.strictObject({
  surface: SurfaceKindSchema,
  id: z.string().min(1).max(128),
  name: SurfaceNameSchema.optional(),
  at: InstantSchema,
});
export type SurfaceHandback = z.infer<typeof SurfaceHandbackSchema>;
