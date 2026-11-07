import { type ConfigDef, defineConfig, defineState, neverLoosens } from '@ferretry/kernel/contract';
import { definePlugin, panel, renderer, route, settingsTab, socket, tool, verb } from '@ferretry/kernel/manifest';
import { FerretsPort } from '@ferretry/core-ferrets/contract';
import { InputTargets } from '@ferretry/core-vault/contract';
import {
  AUDIT,
  BROWSERS_WORDS,
  BrowsersConfigSchema,
  BrowsersPort,
  CONFIGURE,
  GUARD_ACK,
  GUARD_NONE,
  PageChanged,
  SKIP_READ,
  USE,
} from './contract/index.ts';

/** Every browser tool: a ferret's call (or the owner's tools), on `browser.use`, kept as one `agent.tool` entry. */
const TOOL = {
  minimum: 'authenticated',
  caller: 'any',
  capability: USE.browser,
  audit: { record: AUDIT.agentTool },
} as const;
/** Anything that reads or pictures a page is built inside one `Redaction.read`; page holds refuse it (§4.7). */
const SHOWS = { ...TOOL, guard: 'secrets' } as const;
const WRITES = { ...TOOL, guard: GUARD_ACK } as const;

/**
 * Browsers (§2.3): gives ferrets a browser to drive, and lets you take over a page.
 *
 * Routes copied from today's `runtime/mounts/{browser,browser-login,browser-proxy}.ts` (the login window and the
 * per-ferret browser are placed with Accounts by file name in placement.tsv; they are the browser's, see the slice
 * report) and the browser surface control and owner-tools routes of `agent-tools.ts`. Every tool names its `Op`
 * (§4.7); the per-tool input schemas are copied by the port.
 */
export default definePlugin({
  id: 'browsers',
  title: 'Browsers',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['tool', 'command', 'view'],
  words: BROWSERS_WORDS,

  /** Optional (§7.6): the ferret a page belongs to and the name it is grouped under; off, no ferret has pages. */
  uses: { ferrets: FerretsPort },
  provides: { browsers: BrowsersPort },

  actions: {
    routes: [
      route('GET /v1/browser/login', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.browser,
        noStore: true,
        audit: SKIP_READ,
        guard: 'secrets',
      }),
      route('POST /v1/browser/login', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.browser,
        noStore: true,
        audit: { record: AUDIT.browserOpened },
        guard: 'secrets',
      }),
      route('POST /v1/browser/proxy/test', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.browser,
        noStore: true,
        audit: { record: AUDIT.browserProxyTested },
        guard: GUARD_NONE,
      }),
      route('GET /v1/browser/state', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.browser,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('GET /v1/sessions/:sessionId/browser', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.browser,
        noStore: true,
        audit: SKIP_READ,
        guard: 'secrets',
      }),
      route('POST /v1/sessions/:sessionId/browser', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.browser,
        noStore: true,
        audit: { record: AUDIT.browserOpened },
        guard: 'secrets',
      }),
      route('GET /v1/sessions/:sessionId/surfaces/browser/control', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.browser,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('POST /v1/sessions/:sessionId/surfaces/browser/control', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.browser,
        noStore: true,
        audit: { record: AUDIT.surfaceControl },
        guard: GUARD_NONE,
      }),
      route('POST /v1/sessions/:sessionId/surfaces/browser/tools', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.browser,
        noStore: true,
        audit: { record: AUDIT.agentTool },
        guard: 'secrets',
      }),
    ],
    sockets: [
      socket('GET /v1/sessions/:sessionId/browser/stream', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.browser,
        audit: { record: AUDIT.browserOpened },
        guard: 'secrets',
      }),
    ],
    agentTools: [
      tool('browser_list', { ...SHOWS, op: 'read', summary: 'list the pages in the session' }),
      tool('browser_open', { ...WRITES, op: 'open', summary: 'open a named page' }),
      tool('browser_navigate', { ...WRITES, op: 'navigate', summary: 'go to a URL, back, forward or reload' }),
      tool('browser_click', { ...WRITES, op: 'press', summary: 'click an element' }),
      tool('browser_type', { ...WRITES, op: 'type', summary: 'type text into the focused field' }),
      tool('browser_read', { ...SHOWS, op: 'read', summary: "read a page's text or accessibility snapshot" }),
      tool('browser_screenshot', { ...SHOWS, op: 'picture', summary: 'take a screenshot of a page' }),
      tool('browser_dialog', { ...WRITES, op: 'press', summary: 'accept or dismiss a dialog' }),
      tool('browser_tabs', { ...SHOWS, op: 'read', summary: "list a page's tabs and popups" }),
      tool('browser_wait_for', { ...SHOWS, op: 'wait', summary: 'wait for text, an element or a load state' }),
      tool('browser_console', { ...SHOWS, op: 'read', summary: "read a page's console messages" }),
      tool('browser_network', { ...SHOWS, op: 'read', summary: "read a page's network requests" }),
      tool('browser_emulate', { ...WRITES, op: 'navigate', summary: 'emulate a viewport, device or media' }),
      tool('browser_upload', { ...WRITES, op: 'fill', summary: 'upload files into a page' }),
      tool('browser_download', { ...SHOWS, op: 'read', summary: 'download a file a page offers' }),
      tool('browser_pdf', { ...SHOWS, op: 'picture', summary: 'print a page to PDF' }),
      tool('browser_hover', { ...WRITES, op: 'press', summary: 'hover an element' }),
      tool('browser_drag', { ...WRITES, op: 'press', summary: 'drag from one element or point to another' }),
      tool('browser_mouse', { ...WRITES, op: 'press', summary: 'move, press or release the mouse' }),
      tool('browser_press', { ...WRITES, op: 'press', summary: 'press keys' }),
      tool('browser_scroll', { ...WRITES, op: 'press', summary: 'scroll a page or an element' }),
      tool('browser_select', { ...WRITES, op: 'fill', summary: 'choose options in a select' }),
      tool('browser_check', { ...WRITES, op: 'fill', summary: 'check or uncheck a box' }),
      tool('browser_fill_form', { ...WRITES, op: 'fill', summary: 'fill several fields at once' }),
      tool('browser_highlight', { ...SHOWS, op: 'picture', summary: 'outline an element for the owner' }),
      tool('browser_eval', { ...SHOWS, op: 'script', summary: 'run a script in a page and read what it returns' }),
      tool('browser_close', { ...WRITES, op: 'close', summary: 'close a page' }),
      tool('browser_ask_owner', { ...TOOL, guard: GUARD_NONE, summary: 'hand a page to the owner' }),
      tool('browser_request_input', {
        ...TOOL,
        guard: { none: 'raises an input card through the Vault; answers its state, never a value' },
        summary: 'ask the owner to type a password or code into a page',
      }),
    ],
    cli: [
      verb('browser status', { summary: 'show lifecycle, tabs, viewport, viewers, and last actor' }),
      verb('browser start', { summary: 'start the browser without navigating' }),
      verb('browser stop', { summary: 'stop the browser processes; the persistent sign-in profile remains' }),
      verb('browser back', { summary: 'navigate back' }),
      verb('browser forward', { summary: 'navigate forward' }),
      verb('browser reload', { summary: 'reload the current page' }),
      verb('browser open', { summary: "start or reuse this session's browser, optionally navigating" }),
      verb('browser new-page', { summary: 'create and activate a browser page, optionally navigating' }),
      verb('browser activate-page', { summary: 'make a browser page active' }),
      verb('browser close-page', { summary: 'close a browser page' }),
      verb('browser navigate', { summary: 'navigate the shared browser' }),
      verb('browser click', { summary: 'click a selector' }),
      verb('browser type', { summary: 'fill a selector; the text is never logged' }),
      verb('browser read', { summary: 'print visible text (the whole body by default)' }),
      verb('browser screenshot', { summary: 'save an explicit viewport screenshot' }),
      verb('browser resize', { summary: 'resize the browser viewport' }),
      verb('browser login status', { summary: 'show its state, deadline, and connection details' }),
      verb('browser login start', { summary: 'open it; agents lose the browser while it is open' }),
      verb('browser login confirm', { summary: 'mark the profile signed in and leave the window open' }),
      verb('browser login stop', { summary: 'close it' }),
      verb('browser proxy test', {
        summary:
          'check the saved browser proxy, or one given here without saving it; reports reachable, error class, ms, egress IP',
      }),
      verb('browser firewall entry', {
        summary: 'print the line to add to /etc/ferretry/loopback-firewall.conf for this user, from browserPorts',
      }),
      verb('browser firewall script', {
        summary: 'print the root script (install it as /usr/local/sbin/ferretry-loopback-firewall)',
      }),
      verb('browser firewall unit', {
        summary: 'print the systemd unit that applies it (/etc/systemd/system/ferretry-loopback-firewall.service)',
      }),
      verb('browser firewall verify-unit', {
        summary:
          'print the systemd unit that verifies it (/etc/systemd/system/ferretry-loopback-firewall-verify.service)',
      }),
      verb('browser firewall timer', {
        summary: 'print the firewall timer that runs the verify unit',
      }),
      verb('browser page list', { summary: 'list the browser pages in the session' }),
      verb('browser page open', { summary: 'open a named page, starting the browser if it is not running' }),
      verb('browser page navigate', { summary: 'load a URL in a page, or go back, forward or reload' }),
      verb('browser page click', { summary: 'click an element in a page, or a point in it' }),
      verb('browser page type', { summary: 'fill a field in a page; the text is never logged' }),
      verb('browser page hover', { summary: 'move the pointer over an element in a page, or a point in it' }),
      verb('browser page drag', { summary: 'drag from one element to another, or from one point to another' }),
      verb('browser page press', {
        summary: 'press keys in a page, e.g. Enter, ArrowDown, Control+Shift+K; never a secret',
      }),
      verb('browser page scroll', { summary: 'scroll a page: to an element, to a text, by pixels, or by screens' }),
      verb('browser page select', { summary: 'choose options of a select element, by value or label' }),
      verb('browser page check', { summary: 'tick a checkbox or radio button, or untick it with --off' }),
      verb('browser page highlight', {
        summary: 'outline an element so the person watching sees it, or remove the outline with --clear',
      }),
      verb('browser page read', {
        summary: 'print a page’s visible text, its accessibility tree, or a snapshot with refs',
      }),
      verb('browser page screenshot', { summary: 'save a screenshot of a page' }),
      verb('browser page dialog', { summary: 'answer the dialog a page is waiting on (alert, confirm, prompt)' }),
      verb('browser page tabs', { summary: 'list the pages and their popups, or adopt a popup under a name' }),
      verb('browser page wait', {
        summary: 'wait for an element, text, an address, a load state or a time; exits 1 on timeout',
      }),
      verb('browser page console', { summary: 'print a page’s recent console messages and errors, numbered' }),
      verb('browser page network', { summary: 'list a page’s recent requests, or show one by its id (r12)' }),
      verb('browser page emulate', {
        summary: 'make a page look like another device or setting; --reset puts it back',
      }),
      verb('browser page upload', {
        summary: 'give a page files: into a file input, or its file picker; needs the files switch',
      }),
      verb('browser page download', {
        summary: 'save a file the page downloaded into the session’s folder; needs the files switch',
      }),
      verb('browser page pdf', {
        summary: 'print a page to a PDF in the session’s folder (headless browser only); needs the files switch',
      }),
      verb('browser page eval', {
        summary: 'run your own JavaScript in a page, in a world of its own; needs the owner’s Page scripts switch',
      }),
      verb('browser page close', { summary: 'close a page' }),
      verb('browser page ask', {
        summary: 'hand a page to the owner: it comes forward for them with “Your turn here”',
      }),
      verb('browser page takeover', {
        summary: 'take a page over from the agent: its tools are refused there until you hand it back',
      }),
      verb('browser page handback', { summary: 'hand a page you took over back to the agent' }),
      verb('browser page handover', { summary: 'let the agent use a page you opened (it may not otherwise)' }),
      verb('browser page control', { summary: 'show which pages an agent is driving, taken over, or handed to it' }),
    ],
  },

  ui: {
    panels: [panel('ferret.side', { id: 'browser', order: 30 })],
    settings: [settingsTab('browser', { label: 'Browser', order: 55 })],
    renderers: [renderer('reference', { prefix: '%browser' })],
  },

  data: {
    state: [
      /** Chrome's own profile folders: never parsed by Ferretry. */
      defineState({
        name: 'profiles',
        path: 'data/*',
        store: 'opaque',
        format: 1,
        onDamaged: { narrower: 'that profile starts empty; the others are kept' },
      }),
      defineState({ name: 'browsers', path: 'data.json', store: 'json', format: 1 }),
      defineState({
        name: 'x11',
        path: 'x11/*',
        store: 'opaque',
        format: 1,
        onDamaged: { narrower: 'window mode starts a fresh display' },
      }),
    ],
    config: [
      defineConfig({
        file: 'browsers.yaml',
        schema: BrowsersConfigSchema,
        axis: 'configure',
        loosens: neverLoosens,
      }) as ConfigDef,
    ],
    readModels: ['state', 'pages'],
    publishes: [PageChanged],
  },

  hooks: { takes: [{ hook: InputTargets, key: 'page' }] },

  doctor: ['chrome', 'loopback-firewall'],

  permissions: {
    /** Chrome under each name a host installs it as, the private display, the sign-in window's VNC and its bound. */
    spawn: [
      'chrome',
      'chromium',
      'chromium-browser',
      'google-chrome',
      'google-chrome-stable',
      'Google Chrome',
      'Chromium',
      'Xvfb',
      'x11vnc',
      'timeout',
    ],
    /** Uploads come from the ferret's own folder; downloads and PDFs are saved to its downloads root (S51). */
    roots: ['work', 'downloads'],
    /** Chrome's own DevTools endpoint on loopback, which the launcher waits for. */
    network: ['127.0.0.1'],
  },
});
