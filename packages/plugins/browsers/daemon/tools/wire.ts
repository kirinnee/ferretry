import { z } from 'zod';
import { SurfaceKeySchema, SurfaceNameSchema } from '../../contract/index.ts';
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
} from '../../contract/wire/page-lifecycle.ts';
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
} from '../../contract/wire/pointer.ts';
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
} from '../../contract/wire/target.ts';
import {
  AGENT_TOOL_MAX_PATH_CHARS,
  AGENT_TOOL_MAX_SCRIPT_CHARS,
  AGENT_TOOL_MAX_SCRIPT_MS,
  AGENT_TOOL_MAX_SELECTOR_CHARS,
  AGENT_TOOL_MAX_TEXT_CHARS,
  AGENT_TOOL_MAX_UPLOAD_FILES,
} from './limits.ts';
import { AGENT_TOOL_MAX_URL_CHARS, AskOwnerMessageSchema } from '../../contract/wire/limits.ts';

/**
 * The browser tools' calls (§3.3 `tool(... input)`), copied field for field from today's `AgentToolCallSchema`
 * (`protocol/src/lib/agent-tools.ts`), the `browser.*` arms only. `browser.request_input` is the `page` input
 * target's (part b). A tool handler parses its MCP arguments with `{ tool, ...arguments }`.
 */

/** Only web pages: an agent has no business opening `file:`, `javascript:` or `chrome:` URLs. */
const AgentUrlSchema = z
  .string()
  .max(AGENT_TOOL_MAX_URL_CHARS)
  .refine(
    value => URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol),
    'only http and https URLs can be opened',
  );

/** `true` asks the owner to take the surface over; a string says exactly what to do there. */
const AskOwnerSchema = z.union([z.literal(true), AskOwnerMessageSchema]);

const SelectorSchema = z.string().trim().min(1).max(AGENT_TOOL_MAX_SELECTOR_CHARS);

/** The element a browser act names: a ref from a page snapshot (`e12`), or a selector. */
const ElementTargetShape = { selector: SelectorSchema.optional(), ref: BrowserRefSchema.optional() };

/**
 * A file an upload names: a path inside the session's own folder (relative to it, or absolute under it), or
 * an attachment the owner put in this session's chat (`att_` and its sha-256).
 */
const ATTACHMENT_ID_PATTERN = /^att_[a-f0-9]{64}$/u;
const AgentUploadFileSchema = z.union([
  z.string().trim().min(1).max(AGENT_TOOL_MAX_PATH_CHARS),
  z.strictObject({ attachment: z.string().regex(ATTACHMENT_ID_PATTERN, 'an attachment id is att_ and 64 hex digits') }),
]);
export type AgentUploadFile = z.infer<typeof AgentUploadFileSchema>;

/** How `browser.upload` hands files over: into a file input (or a file chooser), or dropped on a dropzone. */
const BrowserUploadModeSchema = z.enum(['input', 'drop']);

/** Where a saved file goes: a path inside the session's own folder. */
const SaveAsSchema = z.string().trim().min(1).max(AGENT_TOOL_MAX_PATH_CHARS);

/** Where in history `browser.navigate` goes instead of to a URL. */
const BrowserHistoryStepSchema = z.enum(['back', 'forward', 'reload']);

export const BrowserToolCallSchema = z.discriminatedUnion('tool', [
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
]);
export type BrowserToolCall = z.infer<typeof BrowserToolCallSchema>;
export type BrowserToolName = BrowserToolCall['tool'];
