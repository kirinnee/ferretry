import { type ConfigDef, defineConfig, defineState, neverLoosens } from '@ferretry/kernel/contract';
import { GatePort } from '@ferretry/core-gate/contract';
import { definePlugin, panel, renderer, route, settingsTab, socket, tool, verb } from '@ferretry/kernel/manifest';
import { AgentControlPort, FerretsPort } from '@ferretry/core-ferrets/contract';
import { InputTargets, VaultPort } from '@ferretry/core-vault/contract';
import { PairingWindowPort } from '@ferretry/plugin-access/contract';
import { ShareWindowPort } from '@ferretry/plugin-catalogs/contract';
import { ConnectionsPort } from '@ferretry/plugin-connections/contract';
import { ConversationPort, ReferenceCatalog } from '@ferretry/plugin-conversation/contract';
import { TerminalsPort } from '@ferretry/plugin-terminals/contract';
import {
  AUDIT,
  BROWSERS_WORDS,
  BrowsersConfigSchema,
  BrowsersPort,
  CONFIGURE,
  GUARD_ACK,
  GUARD_NONE,
  GUARD_OPEN_URL,
  PageChanged,
  SKIP_BY_SERVICE,
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

/** Every verb that talks to a ferret's browser names the ferret three ways, and prints JSON on request. */
const FERRET_OPTION = {
  flag: '-s, --session, --ferret <id>',
  help: 'act on this ferret yourself; without it, act as the ferret this runs inside',
} as const;
const JSON_OPTION = { flag: '--json', help: 'print the answer as JSON' } as const;

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

  /**
   * Optional (§7.6): the ferret a page belongs to and the name it is grouped under (Ferrets; off, no ferret has pages),
   * and the one reader of a ferret's own pane (Terminals), for closing the browsers left under it (D2 #19; off, none
   * is closed). Terminals uses neither Browsers nor the Warden, so this edge makes no cycle.
   * Conversation (lead ruling 2026-11-07): Off, nothing asks Browsers for the composer's `%browser` menu.
   * Agent control (core Ferrets, bound by the kernel): the owner's "What agents may control" switches, read on every tool call;
   * unbound, every agent act of a kind is refused (fail closed).
   */
  uses: {
    ferrets: FerretsPort,
    agentControl: AgentControlPort,
    terminals: TerminalsPort,
    conversation: ConversationPort,
    /**
     * Whether a credential was live, and which origins are the app's (docs/pairing.md, "Never show it to an agent"): Access's
     * pairing code, Catalogs' share invite and Connections' advertisement. Off or unbound, each is unknown, and unknown is live.
     */
    connections: ConnectionsPort,
    pairingWindow: PairingWindowPort,
    shareWindow: ShareWindowPort,
  },
  /**
   * The Vault: input requests raised from a page (`browser_request_input`), and what a ferret did to a page and where
   * page scripts ran, told to its sign-in lock (lead DECISIONS-2 #5, I98–I100).
   */
  needs: { vault: VaultPort, gate: GatePort },
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
      route('GET /v1/ferrets/:ferretId/browser', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.browser,
        noStore: true,
        audit: SKIP_READ,
        guard: 'secrets',
      }),
      route('POST /v1/ferrets/:ferretId/browser', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.browser,
        noStore: true,
        audit: { record: AUDIT.browserOpened },
        guard: 'secrets',
      }),
      route('GET /v1/ferrets/:ferretId/surfaces/browser/control', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.browser,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('POST /v1/ferrets/:ferretId/surfaces/browser/control', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.browser,
        noStore: true,
        audit: { record: AUDIT.surfaceControl },
        guard: GUARD_NONE,
      }),
      route('POST /v1/ferrets/:ferretId/surfaces/browser/tools', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.browser,
        noStore: true,
        audit: { record: AUDIT.agentTool },
        guard: 'secrets',
      }),
      /** Today's `runtime/mounts/system-open.ts`: only a caller ON this machine (`privilegedOnly`, from the carrier). */
      route('POST /v1/system/open-url', {
        minimum: 'operator',
        caller: 'any',
        privilegedOnly: true,
        noStore: true,
        audit: SKIP_BY_SERVICE,
        guard: GUARD_OPEN_URL,
      }),
    ],
    sockets: [
      socket('GET /v1/ferrets/:ferretId/browser/stream', {
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
      verb('browser status', {
        summary: 'show lifecycle, tabs, viewport, viewers, and last actor',
        args: [],
        options: [FERRET_OPTION, JSON_OPTION],
      }),
      verb('browser start', {
        summary: 'start the browser without navigating',
        args: [],
        options: [FERRET_OPTION, JSON_OPTION],
      }),
      verb('browser stop', {
        summary: 'stop the browser processes; the persistent sign-in profile remains',
        args: [],
        options: [FERRET_OPTION, JSON_OPTION],
      }),
      verb('browser close', {
        summary: 'the same as stop (the v4 spelling)',
        options: [FERRET_OPTION, JSON_OPTION],
      }),
      verb('browser back', { summary: 'navigate back', args: [], options: [FERRET_OPTION, JSON_OPTION] }),
      verb('browser forward', { summary: 'navigate forward', args: [], options: [FERRET_OPTION, JSON_OPTION] }),
      verb('browser reload', { summary: 'reload the current page', args: [], options: [FERRET_OPTION, JSON_OPTION] }),
      verb('browser open', {
        summary: "start or reuse this session's browser, optionally navigating",
        args: [{ name: 'url', help: 'URL to open', optional: true }],
        options: [FERRET_OPTION, JSON_OPTION],
      }),
      verb('browser new-page', {
        summary: 'create and activate a browser page, optionally navigating',
        args: [{ name: 'url', help: 'URL to open in the new tab', optional: true }],
        options: [FERRET_OPTION, JSON_OPTION],
      }),
      verb('browser activate-page', {
        summary: 'make a browser page active',
        args: [{ name: 'pageId', help: 'tab to activate' }],
        options: [FERRET_OPTION, JSON_OPTION],
      }),
      verb('browser close-page', {
        summary: 'close a browser page',
        args: [{ name: 'pageId', help: 'tab to close' }],
        options: [FERRET_OPTION, JSON_OPTION],
      }),
      verb('browser navigate', {
        summary: 'navigate the shared browser',
        args: [{ name: 'url', help: 'URL to navigate to' }],
        options: [FERRET_OPTION, JSON_OPTION],
      }),
      verb('browser goto', {
        summary: 'the same as navigate (the v4 spelling)',
        options: [FERRET_OPTION, JSON_OPTION],
      }),
      verb('browser click', {
        summary: 'click a selector',
        args: [{ name: 'selector', help: 'selector to click; shell-quote selectors containing spaces' }],
        options: [FERRET_OPTION, JSON_OPTION],
      }),
      verb('browser type', {
        summary: 'fill a selector; the text is never logged',
        args: [
          { name: 'selector', help: 'selector to fill' },
          {
            name: 'text',
            help: 'text to type; use -- before text that starts with a dash',
            optional: true,
            variadic: true,
          },
        ],
        options: [
          FERRET_OPTION,
          {
            flag: '--stdin',
            help: 'read the text from standard input, never the command line; use it for anything sensitive',
          },
          { flag: '--secret <NAME>', help: 'type a stored secret by name (not available in this build: says so)' },
          JSON_OPTION,
        ],
      }),
      verb('browser read', {
        summary: 'print visible text (the whole body by default)',
        args: [{ name: 'selector', help: 'selector to read', optional: true }],
        options: [FERRET_OPTION, JSON_OPTION],
      }),
      verb('browser screenshot', {
        summary: 'save an explicit viewport screenshot',
        args: [{ name: 'file', help: 'path to write the PNG to' }],
        options: [FERRET_OPTION, JSON_OPTION],
      }),
      verb('browser resize', {
        summary: 'resize the browser viewport',
        args: [
          { name: 'width', help: 'viewport width in pixels' },
          { name: 'height', help: 'viewport height in pixels' },
        ],
        options: [FERRET_OPTION, JSON_OPTION],
      }),
      verb('browser login status', {
        summary: 'show its state, deadline, and connection details',
        args: [],
        options: [JSON_OPTION],
      }),
      verb('browser login start', {
        summary: 'open it; agents lose the browser while it is open',
        args: [],
        options: [
          { flag: '-m, --minutes <n>', help: 'how long to keep it open; the daemon owns the maximum' },
          JSON_OPTION,
        ],
      }),
      verb('browser login confirm', {
        summary: 'mark the profile signed in and leave the window open',
        args: [],
        options: [JSON_OPTION],
      }),
      verb('browser login stop', {
        summary: 'close it',
        args: [],
        options: [{ flag: '--primed', help: 'also mark the profile signed in' }, JSON_OPTION],
      }),
      verb('browser login close', {
        summary: 'the same as stop for the sign-in window (the v4 spelling)',
        options: [{ flag: '--primed', help: 'also mark the profile signed in' }, JSON_OPTION],
      }),
      verb('browser proxy test', {
        summary:
          'check the saved browser proxy, or one given here without saving it; reports reachable, error class, ms, egress IP',
        args: [],
        options: [
          {
            flag: '--url <address>',
            help: 'try this proxy instead of the saved one: http://, https:// or socks5:// host and port',
          },
          { flag: '--bypass <list>', help: 'comma-separated hosts that skip the proxy (needs --url)' },
          { flag: '--username-secret <name>', help: 'NAME of the secret holding the proxy user name (needs --url)' },
          { flag: '--password-secret <name>', help: 'NAME of the secret holding the proxy password (needs --url)' },
          JSON_OPTION,
        ],
      }),
      verb('browser firewall entry', {
        summary: 'print the line to add to /etc/ferretry/loopback-firewall.conf for this user, from browserPorts',
        args: [],
      }),
      verb('browser firewall script', {
        summary: 'print the root script (install it as /usr/local/sbin/ferretry-loopback-firewall)',
        args: [],
      }),
      verb('browser firewall unit', {
        summary: 'print the systemd unit that applies it (/etc/systemd/system/ferretry-loopback-firewall.service)',
        args: [],
      }),
      verb('browser firewall verify-unit', {
        summary:
          'print the systemd unit that verifies it (/etc/systemd/system/ferretry-loopback-firewall-verify.service)',
        args: [],
      }),
      verb('browser firewall timer', {
        summary: 'print the firewall timer that runs the verify unit',
        args: [],
      }),
      verb('browser page list', {
        summary: 'list the browser pages in the session',
        args: [],
        options: [FERRET_OPTION, JSON_OPTION],
      }),
      verb('browser page open', {
        summary: 'open a named page, starting the browser if it is not running',
        args: [
          { name: 'name', help: 'its name: a lowercase letter, then letters, digits or dashes' },
          { name: 'url', help: 'an http or https URL to load', optional: true },
        ],
        options: [
          FERRET_OPTION,
          { flag: '--incognito', help: 'a throwaway page with its own cookies, shared with nothing; gone when closed' },
          {
            flag: '--ask [message]',
            help: 'hand it to the owner at once: their tab comes forward with "Your turn here"; optionally say what to do',
          },
          JSON_OPTION,
        ],
      }),
      verb('browser page navigate', {
        summary: 'load a URL in a page, or go back, forward or reload',
        args: [
          { name: 'name', help: "the page's name or id" },
          { name: 'url', help: 'an http or https URL, or back, forward or reload' },
        ],
        options: [FERRET_OPTION, JSON_OPTION],
      }),
      verb('browser page click', {
        summary: 'click an element in a page, or a point in it',
        args: [
          { name: 'name', help: "the page's name or id" },
          {
            name: 'target',
            help: 'a ref from read --snapshot (e12), a point (120,340), or a selector; shell-quote spaces',
          },
        ],
        options: [
          FERRET_OPTION,
          { flag: '--double', help: 'a double click' },
          { flag: '--right', help: 'the right button' },
          JSON_OPTION,
        ],
      }),
      verb('browser page type', {
        summary: 'fill a field in a page; the text is never logged',
        args: [
          { name: 'name', help: "the page's name or id" },
          { name: 'target', help: 'a ref from read --snapshot (e12), or a selector' },
          {
            name: 'text',
            help: 'text to type; use -- before text that starts with a dash',
            optional: true,
            variadic: true,
          },
        ],
        options: [
          FERRET_OPTION,
          { flag: '--submit', help: 'press Enter after the text' },
          { flag: '--slowly', help: 'type key by key, for a field that reacts to each keystroke' },
          {
            flag: '--stdin',
            help: 'read the text from standard input, never the command line; use it for anything sensitive',
          },
          { flag: '--secret <NAME>', help: 'type a stored secret by name (not available in this build: says so)' },
          JSON_OPTION,
        ],
      }),
      verb('browser page hover', {
        summary: 'move the pointer over an element in a page, or a point in it',
        args: [
          { name: 'name', help: "the page's name or id" },
          { name: 'target', help: 'a ref from read --snapshot (e12), a point (120,340), or a selector' },
        ],
        options: [FERRET_OPTION, JSON_OPTION],
      }),
      verb('browser page drag', {
        summary: 'drag from one element to another, or from one point to another',
        args: [
          { name: 'name', help: "the page's name or id" },
          { name: 'from', help: 'where it starts: a ref (e12), a point (120,340), or a selector' },
          { name: 'to', help: 'where it ends, the same kind of target' },
        ],
        options: [
          FERRET_OPTION,
          { flag: '--steps <n>', help: 'by points only: how many moves on the way (1 to 100)' },
          JSON_OPTION,
        ],
      }),
      verb('browser page press', {
        summary: 'press keys in a page, e.g. Enter, ArrowDown, Control+Shift+K; never a secret',
        args: [
          { name: 'name', help: "the page's name or id" },
          { name: 'keys', help: 'one to 32 keys, pressed in order', variadic: true },
        ],
        options: [
          FERRET_OPTION,
          { flag: '--on <target>', help: 'focus this element first: a ref or a selector' },
          JSON_OPTION,
        ],
      }),
      verb('browser page scroll', {
        summary: 'scroll a page: to an element, to a text, by pixels, or by screens',
        args: [{ name: 'name', help: "the page's name or id" }],
        options: [
          FERRET_OPTION,
          { flag: '--to <target>', help: 'scroll this element into view: a ref or a selector' },
          { flag: '--text <text>', help: 'scroll to the first place this text shows' },
          { flag: '--by <dx,dy>', help: 'scroll by this many pixels, e.g. 0,600 or 0,-600' },
          { flag: '--pages <n>', help: 'scroll by screens: 1 is one down, -1 one up' },
          JSON_OPTION,
        ],
      }),
      verb('browser page select', {
        summary: 'choose options of a select element, by value or label',
        args: [
          { name: 'name', help: "the page's name or id" },
          { name: 'target', help: 'a ref from read --snapshot (e12), or a selector' },
          { name: 'values', help: 'the options to choose', variadic: true },
        ],
        options: [FERRET_OPTION, JSON_OPTION],
      }),
      verb('browser page check', {
        summary: 'tick a checkbox or radio button, or untick it with --off',
        args: [
          { name: 'name', help: "the page's name or id" },
          { name: 'target', help: 'a ref from read --snapshot (e12), or a selector' },
        ],
        options: [FERRET_OPTION, { flag: '--off', help: 'untick instead of tick' }, JSON_OPTION],
      }),
      verb('browser page highlight', {
        summary: 'outline an element so the person watching sees it, or remove the outline with --clear',
        args: [
          { name: 'name', help: "the page's name or id" },
          { name: 'target', help: 'a ref from read --snapshot (e12), or a selector', optional: true },
        ],
        options: [FERRET_OPTION, { flag: '--clear', help: 'remove the outline' }, JSON_OPTION],
      }),
      verb('browser page read', {
        summary: 'print a page’s visible text, its accessibility tree, or a snapshot with refs',
        args: [{ name: 'name', help: "the page's name or id" }],
        options: [
          FERRET_OPTION,
          { flag: '--a11y', help: 'the accessibility tree instead of the text' },
          { flag: '--snapshot', help: 'the accessibility tree with a ref per element, which click and type accept' },
          { flag: '--find <text>', help: 'with --snapshot: only the lines containing this text' },
          { flag: '--selector <target>', help: 'read only this part of the page: a ref or a selector' },
          JSON_OPTION,
        ],
      }),
      verb('browser page screenshot', {
        summary: 'save a screenshot of a page',
        args: [
          { name: 'name', help: "the page's name or id" },
          { name: 'file', help: 'where to write the image' },
        ],
        options: [
          FERRET_OPTION,
          { flag: '--full-page', help: 'the whole page, not only what is in view' },
          { flag: '--jpeg', help: 'a JPEG instead of a PNG' },
          { flag: '--of <target>', help: 'one element only: a ref or a selector' },
          JSON_OPTION,
        ],
      }),
      verb('browser page dialog', {
        summary: 'answer the dialog a page is waiting on: accept or dismiss it, with the reply to type if it asks one',
        args: [
          { name: 'name', help: "the page's name or id" },
          { name: 'action', help: 'accept or dismiss' },
        ],
        options: [FERRET_OPTION, { flag: '--text <answer>', help: "a prompt's answer; only with accept" }, JSON_OPTION],
      }),
      verb('browser page tabs', {
        summary: 'list the pages and their popups, or adopt a popup under a name',
        args: [
          { name: 'action', help: 'list (the default) or adopt (default: "list")', optional: true },
          { name: 'id', help: "adopt: the popup's id from the list", optional: true },
          { name: 'as', help: 'adopt: the name to give it', optional: true },
        ],
        options: [FERRET_OPTION, JSON_OPTION],
      }),
      verb('browser page wait', {
        summary: 'wait for an element, text, an address, a load state or a time; exits 1 on timeout',
        args: [{ name: 'name', help: "the page's name or id" }],
        options: [
          FERRET_OPTION,
          { flag: '--ref <ref>', help: 'an element ref from read --snapshot' },
          { flag: '--selector <selector>', help: 'an element selector' },
          {
            flag: '--state <state>',
            help: 'with --ref or --selector: visible (the default), hidden, attached or detached',
          },
          { flag: '--text <text>', help: 'wait until this text is on the page' },
          { flag: '--text-gone <text>', help: 'wait until this text is gone' },
          { flag: '--url <part>', help: 'wait until the address contains this' },
          { flag: '--load <state>', help: 'wait for load, domcontentloaded or networkidle' },
          { flag: '--time <ms>', help: 'just wait this many milliseconds (up to 25000)' },
          { flag: '-t, --timeout <ms>', help: 'how long to wait in all (default: "10000")' },
          JSON_OPTION,
        ],
      }),
      verb('browser page console', {
        summary: 'print a page’s recent console messages and errors, numbered',
        args: [{ name: 'name', help: "the page's name or id" }],
        options: [
          FERRET_OPTION,
          { flag: '--level <level>', help: 'this level and worse: error, warning, info, log or debug' },
          { flag: '--since <n>', help: 'only entries after this number' },
          { flag: '--limit <n>', help: 'at most this many, newest kept (100 by default)' },
          JSON_OPTION,
        ],
      }),
      verb('browser page network', {
        summary: 'list a page’s recent requests, or show one by its id (r12)',
        args: [
          { name: 'name', help: "the page's name or id" },
          {
            name: 'request',
            help: 'a request id from the list: show it, with its response body if it is text',
            optional: true,
          },
        ],
        options: [
          FERRET_OPTION,
          { flag: '--filter <text>', help: 'list: only URLs containing this' },
          {
            flag: '--type <kind>',
            help: 'list: only these kinds (xhr, fetch, document, script, …); repeat or comma-separate',
          },
          JSON_OPTION,
        ],
      }),
      verb('browser page emulate', {
        summary: 'make a page look like another device or setting; --reset puts it back',
        args: [{ name: 'name', help: "the page's name or id" }],
        options: [
          FERRET_OPTION,
          { flag: '--viewport <WxH>', help: 'the viewport in CSS pixels, like 390x844' },
          { flag: '--color-scheme <scheme>', help: 'light, dark or no-preference' },
          { flag: '--reduced-motion <value>', help: 'reduce or no-preference' },
          { flag: '--forced-colors <value>', help: 'active or none' },
          { flag: '--contrast <value>', help: 'more, less, custom or no-preference' },
          { flag: '--print', help: 'lay the page out as for print' },
          { flag: '--geolocation <lat,lon[,accuracy]>', help: 'a position, accuracy in metres' },
          { flag: '--locale <tag>', help: 'a language tag, like en-US' },
          { flag: '--timezone <name>', help: 'an IANA timezone, like Europe/Berlin' },
          { flag: '--cpu-throttle <rate>', help: 'slow the CPU down this many times (1 is none)' },
          { flag: '--offline', help: 'cut the network' },
          { flag: '--latency <ms>', help: 'add this much network delay' },
          { flag: '--throughput <kbps>', help: 'limit the network to this many kilobits per second' },
          { flag: '--permission <name>', help: "grant a permission to the page's site; repeat or comma-separate" },
          { flag: '--reset', help: 'put everything back as it was' },
          JSON_OPTION,
        ],
      }),
      verb('browser page upload', {
        summary: 'give a page files: into a file input, or its file picker; needs the files switch',
        args: [
          { name: 'name', help: "the page's name or id" },
          { name: 'target', help: 'a ref from read --snapshot (e12), or a selector' },
          { name: 'files', help: "paths in the session's folder, or att_… attachment ids", variadic: true },
        ],
        options: [
          FERRET_OPTION,
          { flag: '--drop', help: 'drop them on a dropzone that has no file input' },
          JSON_OPTION,
        ],
      }),
      verb('browser page download', {
        summary: 'save a file the page downloaded into the session’s folder; needs the files switch',
        args: [
          { name: 'name', help: "the page's name or id" },
          {
            name: 'saveAs',
            help: "where to save it, inside the session's folder; downloads/<its name> when absent",
            optional: true,
          },
        ],
        options: [
          FERRET_OPTION,
          { flag: '--id <id>', help: 'which download (dl-1, from the act that started it); the latest when absent' },
          { flag: '--overwrite', help: 'replace a file that is already there' },
          JSON_OPTION,
        ],
      }),
      verb('browser page pdf', {
        summary: 'print a page to a PDF in the session’s folder (headless browser only); needs the files switch',
        args: [
          { name: 'name', help: "the page's name or id" },
          { name: 'saveAs', help: "where to save it, inside the session's folder", optional: true },
        ],
        options: [FERRET_OPTION, { flag: '--overwrite', help: 'replace a file that is already there' }, JSON_OPTION],
      }),
      verb('browser page eval', {
        summary: 'run your own JavaScript in a page, in a world of its own; needs the owner’s Page scripts switch',
        args: [
          { name: 'name', help: "the page's name or id" },
          { name: 'function', help: 'a function expression: "() => document.title", or "(element) => …" with --of' },
        ],
        options: [
          FERRET_OPTION,
          { flag: '--of <target>', help: 'hand the function one element: a ref or a selector' },
          { flag: '--timeout <ms>', help: 'stop it after this long (up to 10000)' },
          JSON_OPTION,
        ],
      }),
      verb('browser page close', {
        summary: 'close a page',
        args: [{ name: 'name', help: "the page's name or id" }],
        options: [FERRET_OPTION, JSON_OPTION],
      }),
      verb('browser page ask', {
        summary: 'hand a page to the owner: it comes forward for them with “Your turn here”',
        args: [
          { name: 'name', help: "the page's name or id" },
          { name: 'message', help: 'what the owner should do there; never a secret', optional: true, variadic: true },
        ],
        options: [FERRET_OPTION, JSON_OPTION],
      }),
      verb('browser page takeover', {
        summary: 'take a page over from the agent: its tools are refused there until you hand it back',
        args: [{ name: 'name', help: "the page's name or id" }],
        options: [FERRET_OPTION, JSON_OPTION],
      }),
      verb('browser page handback', {
        summary: 'hand a page you took over back to the agent',
        args: [{ name: 'name', help: "the page's name or id" }],
        options: [FERRET_OPTION, JSON_OPTION],
      }),
      verb('browser page handover', {
        summary: 'let the agent use a page you opened (it may not otherwise)',
        args: [{ name: 'name', help: "the page's name or id" }],
        options: [FERRET_OPTION, JSON_OPTION],
      }),
      verb('browser page control', {
        summary: 'show which pages an agent is driving, taken over, or handed to it',
        args: [],
        options: [FERRET_OPTION, JSON_OPTION],
      }),
    ],
  },

  ui: {
    panels: [
      panel('ferret.side', { id: 'browser', order: 30 }),
      // Settings › This device › Open links in (S-0519): where a tap on an external link opens.
      panel('device.settings', { id: 'open-links-in', order: 25 }),
    ],
    settings: [settingsTab('browser', { label: 'Browser', order: 55 })],
    renderers: [renderer('reference', { prefix: '%browser' })],
  },

  /** Never reached by a ferret, through any root: browser profiles (cookies, sign-ins) and the X11 session folder (`PrivacyDecl`). */
  privacy: {
    private: ['data', 'x11'],
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

  hooks: {
    takes: [
      { hook: InputTargets, key: 'page' },
      /** The composer's `%browser` menu is this plugin's: the pages the ferret's browser holds (reference.catalog). */
      { hook: ReferenceCatalog, key: '%browser' },
    ],
  },

  doctor: ['chrome', 'loopback-firewall'],

  permissions: {
    /**
     * Chrome under each name a host installs it as, the private display, the sign-in window's VNC and its bound, and
     * the browser worker process (lead decision, port-browsers r1): Node over the source entry, or the compiled worker
     * under each name a release ships it as (`daemon/worker/program.ts` `BROWSER_WORKER_NAMES`). `kill` sends the
     * SIGTERM that closes a browser left under a ferret's pane (`daemon/leftovers.ts`), never anything else.
     */
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
      'node',
      'fyd-browser-worker',
      'fyd-browser-worker-darwin-arm64',
      'fyd-browser-worker-linux-arm64',
      'fyd-browser-worker-linux-x64-baseline',
      'kill',
      /** The operating system's opener for one web address (`daemon/open-url`): one argv element, never a shell. */
      'open',
      'xdg-open',
      'rundll32',
    ],
    /** The link opener alone starts detached (today's `BunDetachedLauncher`): it outlives the daemon's process group. */
    detached: ['open', 'xdg-open', 'rundll32'],
    /** Who holds a loopback port, proved from `/proc` (`daemon/worker/control/adapters/listener-prover.ts`). */
    hostFacts: true,
    /** Uploads come from the ferret's own folder, and downloads and PDFs are saved into it (S51). */
    roots: ['work'],
    /** Chrome's own DevTools endpoint on loopback, which the launcher waits for. */
    network: ['127.0.0.1'],
  },
});
