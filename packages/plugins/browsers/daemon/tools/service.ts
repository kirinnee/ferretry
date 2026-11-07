import type { KernelPorts, Op, Picture, TargetRef } from '@ferretry/kernel/contract';
import { ApiError } from '@ferretry/kernel/contract';
import { acted, browserTarget, pageTarget, writeAct } from '../pages/acts.ts';
import {
  type BrowserActGuard,
  type BrowserFileAction,
  type BrowserPageAction,
  BrowserSessionError,
  type BrowserSubsystem,
  pendingDialogOf,
} from '../pages/service.ts';
import { NON_TYPING_KEYS } from '../pages/sign-in-watch.ts';
import type { BrowserActionResult, BrowserDownloadNotice, BrowserStatus } from '../pages/wire/browser.ts';
import {
  BROWSER_WAIT_DEFAULT_MS,
  BROWSER_WAIT_SLICE_MS,
  type BrowserDialogInfo,
  type BrowserEmulation,
  type BrowserPageLifecycleRequest,
  type BrowserWaitCondition,
} from '../pages/wire/page-lifecycle.ts';
import type { SurfaceOpener } from '../pages/wire/surface.ts';
import { type BrowserElementTarget, type BrowserTargetFields, browserReadModeOf, browserTargetOf } from '../pages/wire/target.ts';
import { BrowserTransportError } from '../worker/protocol.ts';
import type { SurfaceControl } from './control.ts';
import type { SurfaceControlRequest } from '../../contract/index.ts';
import type { AgentSurface, SurfaceControlView, SurfaceController } from './control-wire.ts';
import type { BrowserFiles } from './files.ts';
import { sizeWords } from './files-policy.ts';
import { AGENT_TOOL_MAX_OUTPUT_CHARS } from './limits.ts';
import type { ResolvedSurface, ToolCaller } from './types.ts';
import type { BrowserToolCall } from './wire.ts';

/**
 * THE BROWSER TOOLS: today's `AgentToolService`, its `browser.*` half, moved.
 *
 * ONE PATH FOR EVERY CALLER, AND EVERY CHECK ON IT. A ferret and a person reach the same method; what differs is
 * decided from the {@link ToolCaller} the half DERIVED from the kernel-stamped standing, never from the call:
 *
 * 1. a ferret is asked the machine's "What agents may control" switches (Browsers, and Files for the file tools);
 *    Page scripts are asked for every caller;
 * 2. the page is looked up inside the caller's own session only — a name from another is simply not there;
 * 3. a ferret acts only on a page IT opened, one a person handed to it, or a popup of those;
 * 4. a ferret is refused a page a person has taken over, checked again inside that page's own queue;
 * 5. every act runs through `kernel.act` with its `Op` (§4.7): the Vault's `InputHolds` decides inside the page's
 *    queue immediately before it, and a write-only act answers an `Ack` (`closeAck`), never page text;
 * 6. what a page says — its text, its address, a dialog's words, a download's name — is a `read`, masked under one
 *    `Redaction.read` for agent and person alike (S16). After a write, where the page is now and what it is showing is
 *    read back as a SEPARATE `read` act, so a hold that refuses reads gets nothing but "Done".
 *
 * The audit record of every act is the kernel's (`agent.tool`, the descriptor's `audit`).
 */

export type BrowserToolErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'conflict'
  | 'forbidden'
  | 'taken_over'
  | 'capacity'
  | 'unavailable'
  | 'upstream_failed';

export class BrowserToolError extends Error {
  constructor(
    readonly code: BrowserToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserToolError';
  }
}

/** A browser tool's answer before it becomes MCP text (today's `AgentToolResult`, its browser fields). */
export interface BrowserToolAnswer {
  readonly summary: string;
  readonly output?: string;
  readonly surfaces?: readonly AgentSurface[];
  readonly matched?: boolean;
  readonly picture?: Picture;
}

/** "What agents may control" (Ferrets' machine switches). */
export interface AgentControlPolicy {
  allows(kind: 'browser' | 'files' | 'scripts'): Promise<boolean>;
}

/** Who each page signs in (part b's `TypedIdentities`, I154/I155). */
export interface TypedIdentityLedger {
  typed(sessionId: string, pageId: string, host: string, text: string): void;
  seen(sessionId: string, pageId: string, host: string | undefined): void;
  cleared(sessionId: string, pageId: string): void;
  forget(sessionId: string): void;
}

/** Where a page script ran, for the Vault's standing fill rules (today's `scriptedOrigins`). */
export interface ScriptedOrigins {
  running?(): () => void;
  scriptedOn(host: string | undefined): void;
}

export interface BrowserToolPorts {
  readonly browser: Pick<
    BrowserSubsystem,
    'status' | 'openPage' | 'actOnPage' | 'filesOnPage' | 'scriptOnPage' | 'closePage' | 'lifecycleOnPage' | 'adoptPage'
  >;
  readonly control: SurfaceControl;
  readonly kernel: Pick<KernelPorts, 'act' | 'redaction' | 'clock'>;
  readonly policy: AgentControlPolicy;
  readonly files: BrowserFiles;
  /** The command-line client's name, for a refusal that tells the owner the command to type. */
  readonly binaryName: string;
  readonly typedIdentities?: TypedIdentityLedger;
  readonly scriptedOrigins?: ScriptedOrigins;
}

/** The tools that change what a person would see, and so put up the driving marker. */
const DRIVING_TOOLS: ReadonlySet<BrowserToolCall['tool']> = new Set([
  'browser.eval',
  'browser.open',
  'browser.navigate',
  'browser.click',
  'browser.type',
  'browser.upload',
  'browser.hover',
  'browser.drag',
  'browser.mouse',
  'browser.press',
  'browser.scroll',
  'browser.select',
  'browser.check',
  'browser.fill_form',
  'browser.highlight',
]);

/** The browser tools that act on a page (every browser tool but list, open, close and ask_owner). */
type PageToolName =
  | 'browser.navigate'
  | 'browser.click'
  | 'browser.type'
  | 'browser.read'
  | 'browser.screenshot'
  | 'browser.hover'
  | 'browser.drag'
  | 'browser.mouse'
  | 'browser.press'
  | 'browser.scroll'
  | 'browser.select'
  | 'browser.check'
  | 'browser.fill_form'
  | 'browser.highlight';

/** The tools that move a file between a page and the session's folder: they need the `files` switch as well as `browser`. */
const FILE_TOOLS: ReadonlySet<BrowserToolCall['tool']> = new Set(['browser.upload', 'browser.download', 'browser.pdf']);

/** The one tool the Browsers switch does not gate: listing what is open (today's `switchOf`). */
const LISTING_TOOLS: ReadonlySet<BrowserToolCall['tool']> = new Set(['browser.list']);

/** Each tool's `Op` (§4.7; the manifest names the same). */
export const TOOL_OPS: Readonly<Record<BrowserToolCall['tool'], Op>> = {
  'browser.list': 'read',
  'browser.open': 'open',
  'browser.navigate': 'navigate',
  'browser.click': 'press',
  'browser.type': 'type',
  'browser.read': 'read',
  'browser.screenshot': 'picture',
  'browser.dialog': 'press',
  'browser.tabs': 'read',
  'browser.wait_for': 'wait',
  'browser.console': 'read',
  'browser.network': 'read',
  'browser.emulate': 'navigate',
  'browser.upload': 'fill',
  'browser.download': 'read',
  'browser.pdf': 'picture',
  'browser.hover': 'press',
  'browser.drag': 'press',
  'browser.mouse': 'press',
  'browser.press': 'press',
  'browser.scroll': 'press',
  'browser.select': 'fill',
  'browser.check': 'fill',
  'browser.fill_form': 'fill',
  'browser.highlight': 'picture',
  'browser.eval': 'script',
  'browser.close': 'close',
  'browser.ask_owner': 'read',
};

/** A page's text as it came back, before redaction: what was read, where the page is now, what its dialog says, and the names its downloads suggested. */
interface PageReading {
  readonly url?: string;
  readonly text?: string;
  readonly dialog?: string;
  /** File names a page suggested for its downloads. */
  readonly names?: readonly string[];
}

type PageRows = BrowserStatus['pages'];

/** The tools that read or change a page's life — a dialog, a wait, its logs, its device. */
type LifecycleCall = Extract<
  BrowserToolCall,
  {
    readonly tool: 'browser.dialog' | 'browser.wait_for' | 'browser.console' | 'browser.network' | 'browser.emulate';
  }
>;

type LifecycleSend = (
  request: BrowserPageLifecycleRequest,
) => ReturnType<BrowserToolPorts['browser']['lifecycleOnPage']>;

/** How far up a popup's opener chain ownership is followed. */
const MAX_OPENER_DEPTH = 8;

const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? '' : 's'}`;

/** A surface as a person writes it: `%browser:app`. */
export const surfaceReference = (key: string): string => `%browser:${key}`;

/** Whether this agent opened the surface itself — the attestation the daemon recorded, never a claim. */
const openedByAgent = (openedBy: SurfaceOpener | undefined, sessionId: string): boolean =>
  openedBy?.by === 'agent' && openedBy.sessionId === sessionId;

/** Keeps the tail of a log: the newest output is what matters. */
export function clipOutput(text: string, limit: number = AGENT_TOOL_MAX_OUTPUT_CHARS): string {
  return text.length <= limit ? text : text.slice(text.length - limit);
}

/** Keeps the START of a page's accessibility tree or snapshot, on a line boundary. */
export function clipReading(text: string, limit: number = AGENT_TOOL_MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const lastLine = head.lastIndexOf('\n');
  return lastLine > 0 ? head.slice(0, lastLine) : head;
}

/** Today's `CONTROL_SETTING`, for the kinds this half asks. */
const CONTROL_SETTING = { browser: 'Browsers', files: 'Files' } as const;

/** The plain sentence an agent is told when the machine's settings switch a kind of control off. */
export function controlRefusal(kind: 'browser' | 'files'): string {
  const setting = CONTROL_SETTING[kind];
  return `This machine does not let agents control ${setting.toLowerCase()}: "What agents may control › ${setting}" is off in this machine's settings. Ask the person to turn it on if you need it.`;
}

/** What an agent is told when it asks for `browser.eval` and the owner has not turned Page scripts on. */
export function pageScriptsRefusal(binaryName: string): string {
  return `browser.eval is off on this machine: "What agents may control › Page scripts" is off, and only the owner can turn it on — in the app (Settings › this machine › What agents may control › Page scripts), with \`${binaryName} machine set agent-control scripts on\`, or with agentControl.pageScripts: true in machine.yaml. Turning it on waits for their confirmation, because a page script can read what a page holds, sign-ins on the shared profile included. Ask them if you need it; the other browser tools work without it.`;
}

export class BrowserTools {
  constructor(private readonly ports: BrowserToolPorts) {}

  async call(caller: ToolCaller, call: BrowserToolCall): Promise<BrowserToolAnswer> {
    try {
      if (caller.kind === 'agent' && !LISTING_TOOLS.has(call.tool) && !(await this.ports.policy.allows('browser')))
        throw new BrowserToolError('forbidden', controlRefusal('browser'));
      if (caller.kind === 'agent' && FILE_TOOLS.has(call.tool) && !(await this.ports.policy.allows('files')))
        throw new BrowserToolError('forbidden', controlRefusal('files'));
      // Page scripts are the owner's to allow for EVERY caller: a paired device with the browser grant
      // must not read the shared profile's sign-ins through a script while the owner has them off.
      if (call.tool === 'browser.eval' && !(await this.ports.policy.allows('scripts')))
        throw new BrowserToolError('forbidden', pageScriptsRefusal(this.ports.binaryName));
      return await this.dispatch(caller, call);
    } catch (error) {
      throw translate(error) ?? error;
    }
  }

  /** Every live driving marker, standing takeover and hand-over of a ferret's pages. */
  async controlView(sessionId: string): Promise<SurfaceControlView> {
    return await this.alive(sessionId, await this.ports.control.view(sessionId, 'browser'));
  }

  /** A person takes a page over from the agent, hands it back, or hands it to the agent. */
  async control(sessionId: string, request: SurfaceControlRequest, by: SurfaceController): Promise<SurfaceControlView> {
    try {
      const surface = await this.resolve(sessionId, request.key);
      if (request.action === 'takeover') await this.ports.control.takeover(sessionId, surface, by);
      else if (request.action === 'handback') await this.ports.control.handback(sessionId, surface);
      else await this.ports.control.hand(sessionId, surface, by);
      return await this.controlView(sessionId);
    } catch (error) {
      throw translate(error) ?? error;
    }
  }

  private async dispatch(caller: ToolCaller, call: BrowserToolCall): Promise<BrowserToolAnswer> {
    const { sessionId } = caller;
    switch (call.tool) {
      case 'browser.list':
        return await this.listPages(caller);
      case 'browser.tabs':
        return await this.tabs(caller, call);
      case 'browser.open': {
        const opener: SurfaceOpener | undefined =
          caller.kind === 'agent' ? { by: 'agent', sessionId } : caller.openedBy;
        let page: { readonly id: string; readonly url: string; readonly incognito?: boolean } | undefined;
        // Opening is a write on the session's browser; where the new page landed is read back under its own hold.
        await writeAct(this.ports.kernel.act, browserTarget(sessionId), 'open', async () => {
          page = await this.ports.browser.openPage(sessionId, call.name, {
            ...(call.url === undefined ? {} : { url: call.url }),
            ...(opener === undefined ? {} : { openedBy: opener }),
            ...(call.incognito === true ? { incognito: true } : {}),
          });
        });
        if (page === undefined) throw new BrowserToolError('upstream_failed', 'The browser opened no page.');
        const surface: ResolvedSurface = {
          surface: 'browser',
          id: page.id,
          name: call.name,
          ...(page.incognito === true ? { incognito: true } : {}),
          opened: true,
        };
        await this.drove(caller, call, surface);
        await this.announce(caller, surface, call.askOwner);
        const kind = call.incognito === true ? 'an incognito page, ' : '';
        const read = await this.readBack(surface, { url: page.url });
        return {
          summary: `Opened ${kind}${surfaceReference(call.name)}${read?.url === undefined ? '' : ` at ${read.url}`}${handedNote(call.askOwner)}.`,
        };
      }
      default: {
        const surface = await this.resolve(sessionId, call.name);
        if (caller.kind === 'agent') await this.assertAgentMay(sessionId, surface);
        const result = await this.onSurface(caller, call, surface);
        await this.drove(caller, call, surface);
        return result;
      }
    }
  }

  private async onSurface(
    caller: ToolCaller,
    call: Exclude<BrowserToolCall, { readonly tool: 'browser.list' | 'browser.tabs' | 'browser.open' }>,
    surface: ResolvedSurface,
  ): Promise<BrowserToolAnswer> {
    const { sessionId } = caller;
    const reference = surfaceReference(surface.name ?? surface.id);
    switch (call.tool) {
      case 'browser.ask_owner':
        if (caller.kind !== 'agent')
          throw new BrowserToolError('bad_request', 'Only an agent hands a surface to its owner; you already have it.');
        await this.announce(caller, surface, call.message ?? true, true);
        return {
          summary: `Asked the owner to take over ${reference}${call.message === undefined ? '' : ' and told them what to do'}. Wait for them: read the surface to see when they are done.`,
        };
      case 'browser.close':
        await writeAct(this.ports.kernel.act, pageTarget(surface.id), 'close', async () => {
          await this.ports.browser.closePage(sessionId, surface.id, this.browserGuard(caller, surface));
        });
        this.ports.control.forget(sessionId, surface);
        return { summary: `Closed ${reference}.` };
      case 'browser.dialog':
      case 'browser.wait_for':
      case 'browser.console':
      case 'browser.network':
      case 'browser.emulate':
        return await this.lifecycle(caller, call, surface, reference);
      case 'browser.upload':
      case 'browser.download':
      case 'browser.pdf':
        return await this.files(caller, call, surface, reference);
      case 'browser.eval':
        return await this.script(caller, call, surface, reference);
      default:
        return await this.browse(caller, call, surface, reference);
    }
  }

  /** `browser.tabs`: the session's pages with their popups, or take on a popup under a name. */
  private async tabs(
    caller: ToolCaller,
    call: Extract<BrowserToolCall, { readonly tool: 'browser.tabs' }>,
  ): Promise<BrowserToolAnswer> {
    if (call.action === 'list') return await this.listPages(caller, true);
    const { sessionId } = caller;
    const surface = await this.resolve(sessionId, call.id ?? '');
    if (caller.kind === 'agent') await this.assertAgentMay(sessionId, surface);
    const reference = surfaceReference(surface.name ?? surface.id);
    if (surface.openerId === undefined)
      throw new BrowserToolError(
        'bad_request',
        `${reference} is not a popup: only a page another page opened can be adopted.`,
      );
    if (surface.name !== undefined) throw new BrowserToolError('conflict', `${reference} already has a name; use it.`);
    const name = call.as ?? '';
    const opener: SurfaceOpener | undefined = caller.kind === 'agent' ? { by: 'agent', sessionId } : caller.openedBy;
    await writeAct(this.ports.kernel.act, pageTarget(surface.id), 'open', async () => {
      await this.ports.browser.adoptPage(sessionId, surface.id, name, opener);
    });
    await this.announce(caller, { ...surface, name, ...(opener === undefined ? {} : { openedBy: opener }) }, undefined);
    return {
      summary: `Adopted the popup ${surface.id} (opened by ${surface.openerId}) as ${surfaceReference(name)}. Use it by that name.`,
    };
  }

  /** The page-lifecycle tools, each as one call to the page's lifecycle port, as one act of its `Op`. */
  private async lifecycle(
    caller: ToolCaller,
    call: LifecycleCall,
    surface: ResolvedSurface,
    reference: string,
  ): Promise<BrowserToolAnswer> {
    const guard = this.browserGuard(caller, surface);
    const target = pageTarget(surface.id);
    const send: LifecycleSend = async request =>
      await this.ports.browser.lifecycleOnPage(caller.sessionId, surface.id, request, guard);
    switch (call.tool) {
      case 'browser.dialog': {
        // Answering is a press; what the dialog said and what the page shows next is read back under the page's hold.
        let out: Awaited<ReturnType<LifecycleSend>> | undefined;
        await writeAct(this.ports.kernel.act, target, 'press', async () => {
          out = await send({
            op: 'dialog',
            action: call.action,
            ...(call.promptText === undefined ? {} : { promptText: call.promptText }),
          });
        });
        const read = await this.readBack(surface, {
          ...(out?.reply.text === undefined ? {} : { text: out.reply.text }),
          ...dialogOf(out?.dialog),
        });
        if (read === undefined) return { summary: `Done on ${reference}.` };
        return { summary: `On ${reference}: ${read.text ?? ''}.${dialogNote(out?.dialog, read.dialog)}` };
      }
      case 'browser.wait_for':
        return await this.waitFor(caller, call, surface, reference, target, send);
      case 'browser.console': {
        const { out, read } = await this.readAct(target, 'read', async () => {
          const out = await send({
            op: 'console',
            ...(call.level === undefined ? {} : { level: call.level }),
            ...(call.since === undefined ? {} : { since: call.since }),
            ...(call.limit === undefined ? {} : { limit: call.limit }),
          });
          return { out, reading: { ...textOf(out.reply.text), ...dialogOf(out.dialog) } };
        });
        return {
          summary: `The console of ${reference}.${dialogNote(out.dialog, read.dialog)}`,
          output: clipOutput(read.text ?? ''),
        };
      }
      case 'browser.network': {
        const { out, read } = await this.readAct(target, 'read', async () => {
          const out = await send({
            op: 'network',
            action: call.action,
            ...(call.id === undefined ? {} : { id: call.id }),
            ...(call.filter === undefined ? {} : { filter: call.filter }),
            ...(call.types === undefined ? {} : { types: call.types }),
          });
          return { out, reading: { ...textOf(out.reply.text), ...dialogOf(out.dialog) } };
        });
        const what = call.action === 'get' ? `Request ${call.id ?? ''} of` : 'The requests of';
        return {
          summary: `${what} ${reference}.${dialogNote(out.dialog, read.dialog)}`,
          output: call.action === 'get' ? clipReading(read.text ?? '') : clipOutput(read.text ?? ''),
        };
      }
      case 'browser.emulate': {
        const { tool: _tool, name: _name, ...emulation } = call;
        let out: Awaited<ReturnType<LifecycleSend>> | undefined;
        await writeAct(this.ports.kernel.act, target, 'navigate', async () => {
          out = await send({ op: 'emulate', emulation: emulation as BrowserEmulation });
        });
        const read = await this.readBack(surface, { ...textOf(out?.reply.text), ...dialogOf(out?.dialog) });
        return {
          summary: `${read?.text ?? 'Emulation applied'} on ${reference}.${dialogNote(out?.dialog, read?.dialog)}`,
        };
      }
    }
  }

  /**
   * `browser.wait_for`: ONE SECOND AT A TIME, with the takeover guard between slices, so a wait ends the
   * moment a person takes the page over. A dialog that opens ends it too, since it blocks the page: the result says so.
   * Each slice is one `wait` act, so a hold that begins mid-wait refuses the next slice.
   */
  // read-scoped: none — it answers matched or not, as today; every word of the page it shows (a dialog) comes back through readAct's Redaction.read
  private async waitFor(
    caller: ToolCaller,
    call: Extract<BrowserToolCall, { readonly tool: 'browser.wait_for' }>,
    surface: ResolvedSurface,
    reference: string,
    target: TargetRef,
    send: LifecycleSend,
  ): Promise<BrowserToolAnswer> {
    const condition = waitConditionOf(call);
    const { clock } = this.ports.kernel;
    if (condition.kind === 'time') {
      for (let left = condition.ms; left > 0; left -= BROWSER_WAIT_SLICE_MS) {
        await clock.sleep(Math.min(BROWSER_WAIT_SLICE_MS, left) as Parameters<typeof clock.sleep>[0]);
        if (caller.kind === 'agent') await this.assertFree(caller.sessionId, surface);
      }
      return { summary: `Waited ${String(condition.ms)} ms on ${reference}.`, matched: true };
    }
    const timeoutMs = call.timeoutMs ?? BROWSER_WAIT_DEFAULT_MS;
    const deadline = clock.nowMs() + timeoutMs;
    for (let waited = 0; ; ) {
      const slice = Math.max(1, Math.min(BROWSER_WAIT_SLICE_MS, timeoutMs - waited));
      const { out, read } = await this.readAct(target, 'wait', async () => {
        const out = await send({ op: 'wait', condition, timeoutMs: slice });
        return { out, reading: dialogOf(out.dialog) };
      });
      waited += slice;
      if (out.reply.matched === true) return { summary: `The wait on ${reference} is over: it happened.`, matched: true };
      if (out.dialog !== undefined)
        return {
          summary: `The wait on ${reference} stopped: the page is blocked by a dialog.${dialogNote(out.dialog, read.dialog)}`,
          matched: false,
        };
      if (waited >= timeoutMs || clock.nowMs() >= deadline)
        return {
          summary: `Still waiting on ${reference}: the wait timed out after ${String(timeoutMs)} ms.`,
          matched: false,
        };
    }
  }

  private async browse(
    caller: ToolCaller,
    call: Extract<BrowserToolCall, { readonly tool: PageToolName }>,
    surface: ResolvedSurface,
    reference: string,
  ): Promise<BrowserToolAnswer> {
    const op = TOOL_OPS[call.tool];
    const target = pageTarget(surface.id);
    const act = async (): Promise<BrowserActionResult> => {
      try {
        return await this.ports.browser.actOnPage(
          caller.sessionId,
          surface.id,
          pageActionOf(call),
          this.browserGuard(caller, surface),
        );
      } catch (error) {
        // An act that failed partway may still have moved the page or typed into it (the browser runtime clears too).
        this.ports.typedIdentities?.cleared(caller.sessionId, surface.id);
        throw error;
      }
    };
    if (op === 'read') {
      // A read is ONE act: what the page says is masked inside it.
      const { out: answer, read } = await this.readAct(target, 'read', async () => {
        const answer = await act();
        return { out: answer, reading: readingOf(answer) };
      });
      this.noted(caller, surface, call, answer);
      const at = read.url === undefined ? '' : ` (now at ${read.url})`;
      const check = notesOf(answer, surface.id, read);
      if (read.text === undefined || call.tool !== 'browser.read') return { summary: `Done on ${reference}${at}.${check}` };
      const mode = browserReadModeOf(call);
      if (call.find !== undefined && read.text === '')
        return { summary: `Nothing in the snapshot of ${reference} contains that text${at}.${check}`, output: '' };
      const output = mode === 'text' ? clipOutput(read.text) : clipReading(read.text);
      const clipped = output.length < read.text.length ? CLIPPED_SNAPSHOT_NOTE : '';
      const refs = mode === 'snapshot' ? REFS_NOTE : '';
      return { summary: `Read ${reference}${at}.${refs}${clipped}${check}`, output };
    }
    if (op === 'picture') {
      // A picture cannot be masked: the act runner refuses it for the whole of a hold (I116). Its words are read back.
      let answer: BrowserActionResult | undefined;
      const picture = acted<'picture'>(
        await this.ports.kernel.act(target, 'picture', async () => {
          answer = await act();
          const page = 'result' in answer ? (answer.result as { screenshotBase64?: unknown; screenshotFormat?: unknown }) : {};
          const base64 = typeof page.screenshotBase64 === 'string' ? page.screenshotBase64 : '';
          return {
            kind: 'picture' as const,
            mime: page.screenshotFormat === 'jpeg' ? ('image/jpeg' as const) : ('image/png' as const),
            bytes: Buffer.from(base64, 'base64'),
          };
        }),
      );
      if (answer !== undefined) this.noted(caller, surface, call, answer);
      const read = answer === undefined ? undefined : await this.readBack(surface, readingOf(answer));
      const at = read?.url === undefined ? '' : ` (now at ${read.url})`;
      const check = answer === undefined || read === undefined ? '' : notesOf(answer, surface.id, read);
      if (picture.bytes.byteLength > 0) return { summary: `A screenshot of ${reference}${at}.${check}`, picture };
      return { summary: `Done on ${reference}${at}.${check}` };
    }
    // A write answers an Ack; where the page is now and what it shows is read back as its own `read` act.
    let answer: BrowserActionResult | undefined;
    await writeAct(this.ports.kernel.act, target, op, async () => {
      answer = await act();
    });
    if (answer === undefined) return { summary: `Done on ${reference}.` };
    this.noted(caller, surface, call, answer);
    const read = await this.readBack(surface, readingOf(answer));
    if (read === undefined) return { summary: `Done on ${reference}.` };
    const at = read.url === undefined ? '' : ` (now at ${read.url})`;
    const secret = 'result' in answer && answer.result.passwordField === true ? passwordNote(call.tool) : '';
    return { summary: `Done on ${reference}${at}.${secret}${notesOf(answer, surface.id, read)}` };
  }

  /**
   * WHO THE PAGE IS SIGNING IN (part b's `TypedIdentities`), from what the daemon saw this act do. Kept: the agent's
   * type or fill into ONE identifier box (never beside a password field), or its click on an element that showed one
   * email. Kept as it was: an act that cannot change who signs in (a read, a hover, Enter or Tab). CLEARED: everything
   * else that could — a navigation, typing anything else, a key that types, raw mouse moves, a click at a bare point
   * — and any act by a person. A missing record is the safe state.
   */
  private noted(
    caller: ToolCaller,
    surface: ResolvedSurface,
    call: Extract<BrowserToolCall, { readonly tool: PageToolName }>,
    answer: BrowserActionResult,
  ): void {
    const identities = this.ports.typedIdentities;
    if (identities === undefined || !('result' in answer)) return;
    const result = answer.result as Parameters<typeof identityAfter>[1] & { readonly url?: string };
    const next = identityAfter(call, result, caller.kind === 'agent');
    if (next === 'keep') identities.seen(caller.sessionId, surface.id, pageHostOf(result.url));
    else if (next === 'clear') identities.cleared(caller.sessionId, surface.id);
    else identities.typed(caller.sessionId, surface.id, next.host, next.username);
  }

  /**
   * An agent's own script, in an isolated world on its page (owner-gated: checked in {@link call}). A script reads
   * AND writes (§4.7 `script`), so it is one act whose text is masked inside it.
   */
  private async script(
    caller: ToolCaller,
    call: Extract<BrowserToolCall, { readonly tool: 'browser.eval' }>,
    surface: ResolvedSurface,
    reference: string,
  ): Promise<BrowserToolAnswer> {
    const element = call.ref !== undefined || call.selector !== undefined ? elementTargetOf(call) : undefined;
    const guard = this.browserGuard(caller, surface);
    const scripts = this.ports.scriptedOrigins;
    let ran = false;
    let finished: (() => void) | undefined;
    try {
      const { out: answer, read } = await this.readAct(pageTarget(surface.id), 'script', async () => {
        const answer = await this.ports.browser.scriptOnPage(
          caller.sessionId,
          surface.id,
          {
            source: call.function,
            ...(element === undefined ? {} : { target: element }),
            ...(call.timeoutMs === undefined ? {} : { timeoutMs: call.timeoutMs }),
          },
          async page => {
            await guard?.(page);
            // The LAST thing before the script runs, inside the page's queue. While it runs, no standing rule fills
            // anywhere, and the host it is about to run on is tainted for the rules at once.
            finished = scripts?.running?.();
            scripts?.scriptedOn(await page.host?.().catch(() => undefined));
            // A script can type or choose an account on any page of the session: who they sign in is no longer known.
            this.ports.typedIdentities?.forget(caller.sessionId);
            ran = true;
          },
        );
        // The origin of the world the script ACTUALLY ran in, and where it left the page: each is tainted too.
        scripts?.scriptedOn(hostOf(answer.scriptOrigin));
        scripts?.scriptedOn(hostOf(answer.result.url));
        return {
          out: answer,
          reading: { url: answer.result.url, text: answer.text, ...dialogOf(pendingDialogOf(answer.result)) },
        };
      });
      const output = clipReading(read.text ?? '');
      const clipped = output.length < (read.text ?? '').length ? ' It was clipped to fit: return less.' : '';
      return {
        summary: `Ran your script on ${reference} (now at ${read.url ?? ''}).${clipped}${humanCheckNote(answer, surface.id)}${dialogNote(pendingDialogOf(answer.result), read.dialog)}`,
        output,
      };
    } catch (error) {
      // The script may have run and moved the page, and where it ran or ended can't be read: it may have been any host.
      if (ran) scripts?.scriptedOn(undefined);
      throw error;
    } finally {
      finished?.();
    }
  }

  /**
   * The file tools (S51). An upload hands the page the files the kernel's `work` root confined to the session's
   * folder; a download or a PDF is staged by the browser and SAVED into that folder — never over an existing file
   * unless asked.
   */
  private async files(
    caller: ToolCaller,
    call: Extract<BrowserToolCall, { readonly tool: 'browser.upload' | 'browser.download' | 'browser.pdf' }>,
    surface: ResolvedSurface,
    reference: string,
  ): Promise<BrowserToolAnswer> {
    const { sessionId } = caller;
    const guard = this.browserGuard(caller, surface);
    const target = pageTarget(surface.id);
    if (call.tool === 'browser.upload') {
      const prepared = await this.ports.files.prepareUpload(sessionId, call.files);
      let answer: Awaited<ReturnType<BrowserToolPorts['browser']['filesOnPage']>> | undefined;
      await writeAct(this.ports.kernel.act, target, 'fill', async () => {
        answer = await this.ports.browser.filesOnPage(
          sessionId,
          surface.id,
          {
            action: 'upload',
            target: elementTargetOf(call),
            paths: prepared.files.map(file => file.path),
            mode: call.mode ?? 'input',
          },
          guard,
        );
      });
      const started = answer?.result.downloads ?? [];
      const read =
        answer === undefined
          ? undefined
          : await this.readBack(surface, {
              url: answer.result.url,
              ...(started.length === 0 ? {} : { names: started.map(notice => notice.name) }),
            });
      const how = call.mode === 'drop' ? 'Dropped' : 'Gave';
      const at = read?.url === undefined ? '' : ` (now at ${read.url})`;
      const notes =
        answer === undefined || read === undefined
          ? ''
          : `${humanCheckNote(answer, surface.id)}${downloadsNote(started, read.names)}`;
      return {
        summary: `${how} ${plural(prepared.files.length, 'file')} (${sizeWords(prepared.files.reduce((sum, file) => sum + file.size, 0))}) ${call.mode === 'drop' ? 'onto' : 'to'} ${reference}${at}.${notes}`,
      };
    }
    const action: BrowserFileAction =
      call.tool === 'browser.download'
        ? { action: 'download', ...(call.id === undefined ? {} : { downloadId: call.id }) }
        : { action: 'pdf' };
    // A download is a read of the page and a PDF a picture of it (§4.7): the file never leaves the act while held.
    const { out: answer, read } = await this.readAct(target, call.tool === 'browser.pdf' ? 'picture' : 'read', async () => {
      const answer = await this.ports.browser.filesOnPage(sessionId, surface.id, action, guard);
      if (answer.staged === undefined) throw new BrowserToolError('upstream_failed', 'The browser staged no file to save.');
      return { out: answer, reading: { names: [answer.staged.name] } };
    });
    const staged = answer.staged;
    if (staged === undefined) throw new BrowserToolError('upstream_failed', 'The browser staged no file to save.');
    const name = read.names?.[0] ?? staged.name;
    const saved = await this.ports.files.save(
      sessionId,
      { ...staged, name },
      { saveAs: call.saveAs, overwrite: call.overwrite === true },
    );
    const what = call.tool === 'browser.pdf' ? 'Printed' : 'Saved';
    return {
      summary: `${what} ${reference} as ${saved.saved} (${sizeWords(saved.size)}) in this session's folder.${humanCheckNote(answer, surface.id)}`,
    };
  }

  /**
   * One act that reads (`read`, `wait`, `script`, `picture`): `work` runs inside the page's queue and returns what it
   * read, which is masked under ONE `Redaction.read` before the act ends. A refused act throws its fixed sentence.
   */
  private async readAct<T>(
    target: TargetRef,
    op: 'read' | 'wait' | 'script' | 'picture',
    work: () => Promise<{ readonly out: T; readonly reading: PageReading }>,
  ): Promise<{ readonly out: T; readonly read: PageReading }> {
    let out: T | undefined;
    let read: PageReading = {};
    const answer = await this.ports.kernel.act(target, op, async () => {
      const done = await work();
      out = done.out;
      read = await this.scrubbed(done.reading);
      if (op === 'picture') return { kind: 'picture' as const, mime: 'application/pdf' as const, bytes: new Uint8Array() };
      return { kind: 'content' as const };
    });
    if (!answer.ok) acted(answer);
    if (out === undefined) throw new BrowserToolError('upstream_failed', 'The page act answered nothing.');
    return { out, read };
  }

  /**
   * What a page shows after a write — where it is, what its dialog says, what its downloads are named — as a `read`
   * act of its own, masked. A hold that refuses reads gives nothing back: the caller then says only "Done".
   */
  private async readBack(surface: ResolvedSurface, reading: PageReading): Promise<PageReading | undefined> {
    let read: PageReading | undefined;
    const answer = await this.ports.kernel.act(pageTarget(surface.id), 'read', async () => {
      read = await this.scrubbed(reading);
      return { kind: 'content' as const };
    });
    return answer.ok ? read : undefined;
  }

  /** A page's reading with every vault secret masked, under one vault open — or refused, never served raw. */
  private async scrubbed(reading: PageReading): Promise<PageReading> {
    // A reading carries only the parts a page returned, so an empty one has nothing to mask.
    if (Object.keys(reading).length === 0) return reading;
    try {
      return await this.ports.kernel.redaction.read(scrub => ({
        ...(reading.url === undefined ? {} : { url: scrub.text(reading.url) }),
        ...(reading.text === undefined ? {} : { text: scrub.text(reading.text) }),
        ...(reading.dialog === undefined ? {} : { dialog: scrub.text(reading.dialog) }),
        ...(reading.names === undefined ? {} : { names: reading.names.map(name => scrub.text(name)) }),
      }));
    } catch {
      throw new BrowserToolError(
        'unavailable',
        'The page was acted on, but this machine could not open its secret store to mask secrets in what the page shows, so that is withheld. Try again shortly.',
      );
    }
  }

  /**
   * The check the browser runs INSIDE the page's own queue, right before an agent's act: a takeover that landed
   * while the act was waiting its turn still refuses it. Holds and pending input are the act runner's (§4.7).
   */
  private browserGuard(caller: ToolCaller, surface: ResolvedSurface): BrowserActGuard | undefined {
    if (caller.kind !== 'agent') return undefined;
    return async () => await this.assertFree(caller.sessionId, surface);
  }

  /** The pages, each one an agent may not use left out (today's `listPages` + `listed`). */
  private async listPages(caller: ToolCaller, tabs = false): Promise<BrowserToolAnswer> {
    const status = await this.ports.browser.status(caller.sessionId);
    const rows = await Promise.all(
      status.pages.map(async page =>
        this.listed(
          caller,
          {
            surface: 'browser',
            id: page.id,
            title: page.title,
            url: page.url,
            ...(page.name === undefined ? {} : { name: page.name }),
            ...(page.openedBy === undefined ? {} : { openedBy: page.openedBy }),
            ...(page.openerId === undefined ? {} : { openerId: page.openerId }),
            ...(page.incognito === true ? { incognito: true } : {}),
          },
          status.pages,
        ),
      ),
    );
    // A title and an address are what the page says: masked, for agent and person alike (S16).
    const visible = rows.filter((row): row is AgentSurface => row !== undefined);
    const masked = await this.ports.kernel.redaction.read(scope =>
      visible.map(row => ({
        ...row,
        title: scope.text(row.title),
        ...(row.url === undefined ? {} : { url: scope.text(row.url) }),
      })),
    );
    const listing = shown(masked);
    const popups = (listing.surfaces ?? []).filter(row => row.openerId !== undefined && row.name === undefined);
    if (!tabs || popups.length === 0) return listing;
    return {
      ...listing,
      summary: `${listing.summary} Popups with no name yet: ${popups.map(row => row.id).join(', ')}; give one a name with browser.tabs (action "adopt", id, as).`,
    };
  }

  /**
   * One row of a listing — or nothing, for a surface an agent may not use. An agent sees its own
   * surfaces and the ones handed to it, and never so much as the name, title or URL of a person's.
   */
  private async listed(
    caller: ToolCaller,
    row: ResolvedSurface & { readonly title: string; readonly url?: string },
    pages?: PageRows,
  ): Promise<AgentSurface | undefined> {
    const base: AgentSurface = {
      id: row.id,
      ...(row.name === undefined ? {} : { name: row.name }),
      title: row.title,
      ...(row.incognito === true ? { incognito: true } : {}),
      ...(row.url === undefined ? {} : { url: row.url }),
      ...(row.openerId === undefined ? {} : { openerId: row.openerId }),
    };
    if (caller.kind !== 'agent') return base;
    const available = await this.assertAgentMay(caller.sessionId, row, pages).then(
      () => true,
      () => false,
    );
    return available ? { ...base, available } : undefined;
  }

  /** The page a name or id addresses, looked up in this session's own listing and nowhere else. */
  private async resolve(sessionId: string, key: string): Promise<ResolvedSurface> {
    const found = (await this.ports.browser.status(sessionId)).pages.find(
      candidate => candidate.name === key || candidate.id === key,
    );
    if (found === undefined)
      throw new BrowserToolError(
        'not_found',
        `There is no ${surfaceReference(key)} in this session. List them with browser.list, or open one with browser.open.`,
      );
    return {
      surface: 'browser',
      id: found.id,
      ...(found.name === undefined ? {} : { name: found.name }),
      ...(found.openedBy === undefined ? {} : { openedBy: found.openedBy }),
      ...(found.incognito === true ? { incognito: true } : {}),
      ...(found.openerId === undefined ? {} : { openerId: found.openerId }),
      url: found.url,
    };
  }

  /** Whether an agent may act on this surface now: it is the agent's, and nobody is holding it. */
  private async assertAgentMay(sessionId: string, surface: ResolvedSurface, pages?: PageRows): Promise<void> {
    const mine =
      openedByAgent(surface.openedBy, sessionId) ||
      (await this.ports.control.isHanded(sessionId, surface)) ||
      (await this.popupOfMine(sessionId, surface, pages));
    if (!mine)
      throw new BrowserToolError(
        'forbidden',
        `${surfaceReference(surface.name ?? surface.id)} is a person's, not yours: you may use it only if they hand it to you. Ask them, or open your own.`,
      );
    await this.assertFree(sessionId, surface);
  }

  /**
   * Whether a page is a popup of one of the agent's own: its opener chain — the opener records the
   * daemon keeps, never a claim — ends at a page this agent opened or was handed.
   */
  private async popupOfMine(sessionId: string, surface: ResolvedSurface, known?: PageRows): Promise<boolean> {
    if (surface.openerId === undefined) return false;
    const pages = known ?? (await this.ports.browser.status(sessionId)).pages;
    let openerId: string | undefined = surface.openerId;
    for (let depth = 0; depth < MAX_OPENER_DEPTH && openerId !== undefined; depth += 1) {
      const opener = pages.find(page => page.id === openerId);
      if (opener === undefined) return false;
      const resolved: ResolvedSurface = {
        surface: 'browser',
        id: opener.id,
        ...(opener.name === undefined ? {} : { name: opener.name }),
        ...(opener.openedBy === undefined ? {} : { openedBy: opener.openedBy }),
      };
      if (openedByAgent(opener.openedBy, sessionId) || (await this.ports.control.isHanded(sessionId, resolved)))
        return true;
      openerId = opener.openerId;
    }
    return false;
  }

  /** Whether a person holds THIS page. Holding one tab holds nothing else. */
  private async assertFree(sessionId: string, surface: ResolvedSurface): Promise<void> {
    const takeover = await this.ports.control.takeoverOf(sessionId, surface);
    if (takeover === undefined) return;
    throw new BrowserToolError(
      'taken_over',
      `A person has taken over ${surfaceReference(surface.name ?? surface.id)}; wait or ask them.`,
    );
  }

  private async drove(caller: ToolCaller, call: BrowserToolCall, surface: ResolvedSurface): Promise<void> {
    if (caller.kind !== 'agent' || !DRIVING_TOOLS.has(call.tool)) return;
    // The marker is a courtesy to the person watching; a record that cannot take it must not fail an
    // act that already happened.
    await this.ports.control
      .drove(caller.sessionId, surface, caller.name === undefined ? {} : { name: caller.name })
      .catch(() => undefined);
  }

  /**
   * Tells the owner's workspace about a surface the AGENT opened (a tab appears) and, when it asked for
   * them, hands it over ("your turn here"). Like the driving marker it is a courtesy to a person
   * watching: a record that cannot take it must not fail an act that already happened — except an
   * explicit ask, whose failure the agent must hear about, since the owner would never be told.
   */
  private async announce(
    caller: ToolCaller,
    surface: ResolvedSurface,
    askOwner: true | string | undefined,
    explicit = false,
  ): Promise<void> {
    if (caller.kind !== 'agent') return;
    const agent = caller.name === undefined ? {} : { name: caller.name };
    const message = typeof askOwner === 'string' ? askOwner : undefined;
    await this.ports.control.opened(caller.sessionId, surface, agent).catch(() => undefined);
    if (askOwner === undefined) return;
    const asking = this.ports.control.asked(caller.sessionId, surface, agent, message);
    if (explicit) await asking;
    else await asking.catch(() => undefined);
  }

  /** What is still alive: a close is not recorded, so a gone page must not keep a tab or an ask. */
  private async alive(sessionId: string, view: SurfaceControlView): Promise<SurfaceControlView> {
    if (view.opened.length === 0 && view.asked.length === 0) return view;
    const live = new Set((await this.ports.browser.status(sessionId)).pages.map(row => row.id));
    return {
      ...view,
      opened: view.opened.filter(entry => live.has(entry.id)),
      asked: view.asked.filter(entry => live.has(entry.id)),
    };
  }
}

const textOf = (text: string | undefined): { readonly text?: string } => (text === undefined ? {} : { text });

/** What an act's answer says that is the PAGE's words: where it is now, what it read, its dialog, its downloads' names. */
function readingOf(answer: BrowserActionResult): PageReading {
  const page: { readonly url?: string; readonly text?: unknown; readonly downloads?: readonly BrowserDownloadNotice[] } =
    'result' in answer ? answer.result : {};
  const started = page.downloads ?? [];
  return {
    ...(page.url === undefined ? {} : { url: page.url }),
    ...(typeof page.text === 'string' ? { text: page.text } : {}),
    ...dialogOf(pendingDialogOf(page)),
    ...(started.length === 0 ? {} : { names: started.map(notice => notice.name) }),
  };
}

/** The notes after an act: a human check, a dialog, the downloads it started. */
function notesOf(answer: BrowserActionResult, pageId: string, read: PageReading): string {
  const page = 'result' in answer ? answer.result : undefined;
  const started = page?.downloads ?? [];
  return (
    humanCheckNote(answer, pageId) + dialogNote(pendingDialogOf(page), read.dialog) + downloadsNote(started, read.names)
  );
}

/** The one thing a `browser.wait_for` waits for. The call schema already holds it to exactly one. */
// read-scoped: none — it builds the condition from the call and reads nothing
function waitConditionOf(call: Extract<BrowserToolCall, { readonly tool: 'browser.wait_for' }>): BrowserWaitCondition {
  const target = browserTargetOf(call);
  if (target !== undefined && target.kind !== 'point')
    return { kind: 'element', target, state: call.state ?? 'visible' };
  if (call.text !== undefined) return { kind: 'text', text: call.text };
  if (call.textGone !== undefined) return { kind: 'textGone', text: call.textGone };
  if (call.url !== undefined) return { kind: 'url', url: call.url };
  if (call.load !== undefined) return { kind: 'load', state: call.load };
  return { kind: 'time', ms: call.time ?? 1 };
}

const dialogOf = (dialog: BrowserDialogInfo | undefined): { readonly dialog?: string } =>
  dialog === undefined ? {} : { dialog: dialog.message };

/** Told after any act on a page that has a dialog waiting: what it says, and what to do. */
function dialogNote(dialog: BrowserDialogInfo | undefined, scrubbedMessage: string | undefined): string {
  if (dialog === undefined) return '';
  return ` A ${dialog.type} dialog is waiting on this page: "${scrubbedMessage ?? ''}". The page can do nothing until it is answered: use browser.dialog with accept or dismiss (it is dismissed on its own after 30 seconds).`;
}

/** The browser's own action for a page tool's call. */
export function pageActionOf(call: Extract<BrowserToolCall, { readonly tool: PageToolName }>): BrowserPageAction {
  const element = elementOfCall(call);
  switch (call.tool) {
    case 'browser.navigate':
      return call.url === undefined ? { action: call.history ?? 'reload' } : { action: 'navigate', url: call.url };
    case 'browser.click':
      return {
        action: 'click',
        ...element,
        ...(call.x === undefined || call.y === undefined ? {} : { x: call.x, y: call.y }),
        ...(call.button === undefined ? {} : { button: call.button }),
        ...(call.double === true ? { double: true } : {}),
        ...(call.modifiers === undefined ? {} : { modifiers: call.modifiers }),
      };
    case 'browser.type':
      return {
        action: 'type',
        ...element,
        text: call.text,
        ...(call.submit === true ? { submit: true } : {}),
        ...(call.slowly === true ? { slowly: true } : {}),
      };
    case 'browser.read':
      return {
        action: 'read',
        ...element,
        mode: browserReadModeOf(call),
        ...(call.find === undefined ? {} : { find: call.find }),
        ...(call.depth === undefined ? {} : { depth: call.depth }),
        ...(call.boxes === true ? { boxes: true } : {}),
      };
    case 'browser.screenshot':
      return {
        action: 'screenshot',
        ...element,
        ...(call.fullPage === true ? { fullPage: true } : {}),
        ...(call.format === undefined ? {} : { format: call.format }),
      };
    case 'browser.hover':
      return { action: 'hover', ...element, ...pointOf(call) };
    case 'browser.drag': {
      const { tool: _tool, name: _name, ...ends } = call;
      return { action: 'drag', ...ends };
    }
    case 'browser.mouse': {
      const { tool: _tool, name: _name, action: mouseAction, ...rest } = call;
      return { action: 'mouse', mouseAction, ...rest };
    }
    case 'browser.press':
      return { action: 'press', keys: call.keys, ...element };
    case 'browser.scroll':
      return {
        action: 'scroll',
        ...element,
        ...(call.text === undefined ? {} : { text: call.text }),
        ...(call.deltaX === undefined ? {} : { deltaX: call.deltaX }),
        ...(call.deltaY === undefined ? {} : { deltaY: call.deltaY }),
        ...(call.pages === undefined ? {} : { pages: call.pages }),
      };
    case 'browser.select':
      return { action: 'select', ...element, values: call.values };
    case 'browser.check':
      return { action: 'check', ...element, checked: call.checked };
    case 'browser.fill_form':
      return { action: 'fill-form', fields: call.fields };
    case 'browser.highlight':
      return { action: 'highlight', ...element, ...(call.clear === true ? { clear: true as const } : {}) };
  }
}

/** The element an upload aims at, as the browser takes it. */
function elementTargetOf(fields: BrowserTargetFields): BrowserElementTarget {
  return fields.ref !== undefined
    ? { kind: 'ref', ref: fields.ref }
    : { kind: 'selector', selector: fields.selector as string };
}

/** What an agent is told when a page has started downloads: each one's name and size, and how to keep it. */
function downloadsNote(downloads: readonly BrowserDownloadNotice[], names: readonly string[] | undefined): string {
  return downloads
    .map((notice, index) => {
      const name = names?.[index] ?? notice.name;
      if (notice.state === 'failed') return ` A download (${name}) failed.`;
      if (notice.state === 'downloading')
        return ` A download started: ${name} is still arriving — save it with browser_download (id ${notice.id}) in a moment.`;
      return ` A download started: ${name}, ${sizeWords(notice.size ?? 0)} — save it with browser_download (id ${notice.id}).`;
    })
    .join('');
}

/** What a page act did to who the page signs in: named someone, changed nothing, or may have changed it unseen. */
type IdentityAfter = 'keep' | 'clear' | { readonly host: string; readonly username: string };

/** The rules {@link BrowserTools} applies, decided from the call and what the browser saw it do. */
function identityAfter(
  call: Extract<BrowserToolCall, { readonly tool: PageToolName }>,
  result: {
    readonly identifierHost?: string | undefined;
    readonly identifierFields?: readonly { readonly index: number; readonly host: string }[] | undefined;
    readonly clickedIdentity?: { readonly host: string; readonly username: string } | undefined;
    readonly passwordField?: true | undefined;
  },
  byAgent: boolean,
): IdentityAfter {
  if (LEAVES_SIGN_IN.has(call.tool)) return 'keep';
  if (!byAgent) return 'clear';
  const password = result.passwordField === true;
  switch (call.tool) {
    case 'browser.type':
      return result.identifierHost === undefined || password
        ? 'clear'
        : { host: result.identifierHost, username: call.text };
    case 'browser.fill_form': {
      const [only, ...more] = result.identifierFields ?? [];
      const entry = only === undefined ? undefined : call.fields[only.index];
      const text = entry?.text ?? entry?.value;
      return password || only === undefined || more.length > 0 || text === undefined
        ? 'clear'
        : { host: only.host, username: text };
    }
    case 'browser.click':
      if (result.clickedIdentity !== undefined) return result.clickedIdentity;
      return call.ref === undefined && call.selector === undefined ? 'clear' : 'keep';
    case 'browser.press':
      return call.keys.every(key => NON_TYPING_KEYS.has(key)) ? 'keep' : 'clear';
    default:
      return 'clear';
  }
}

/** The page acts that cannot change who a page signs in: it is kept through them. */
const LEAVES_SIGN_IN: ReadonlySet<string> = new Set([
  'browser.read',
  'browser.screenshot',
  'browser.hover',
  'browser.scroll',
  'browser.highlight',
  'browser.select',
  'browser.check',
]);

/** A page URL's host, lowercase, or `undefined` when there is none to read. */
function pageHostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).host.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** The element fields of a page tool's call, if it carries any. */
function elementOfCall(call: object): { selector?: string; ref?: string } {
  const { selector, ref } = call as { selector?: unknown; ref?: unknown };
  return {
    ...(typeof selector === 'string' ? { selector } : {}),
    ...(typeof ref === 'string' ? { ref } : {}),
  };
}

function pointOf(call: { readonly x?: number | undefined; readonly y?: number | undefined }) {
  return call.x === undefined || call.y === undefined ? {} : { x: call.x, y: call.y };
}

/**
 * Told when an act put text in a password field. A real secret never belongs in a tool call: it would
 * sit in the agent's transcript. The owner types it, on a page handed to them.
 */
function passwordNote(tool: PageToolName): string {
  const wrote = tool === 'browser.fill_form' ? 'filled' : 'typed into';
  return ` That act ${wrote} a password field. A real secret must never go in a tool call: hand the page to the owner with browser_ask_owner so they type it themselves.`;
}

/** Told after a snapshot: the refs in it are what every act accepts. */
const REFS_NOTE = ' Pass a ref from it (ref: "e12") to any browser tool instead of a selector.';
/** Told when a snapshot was longer than one answer holds. */
const CLIPPED_SNAPSHOT_NOTE =
  ' It was clipped to fit: read one part with a ref or selector, ask for less depth, or find a text.';

const handedNote = (askOwner: true | string | undefined): string =>
  askOwner === undefined ? '' : ' and asked the owner to take over (wait for them)';

/** A listing's result: the rows the caller may see, and a sentence naming them. */
function shown(surfaces: readonly AgentSurface[]): BrowserToolAnswer {
  if (surfaces.length === 0) return { summary: 'No browser pages are open for you in this session.', surfaces };
  const names = surfaces.map(entry => surfaceReference(entry.name ?? entry.id)).join(', ');
  return { summary: `${plural(surfaces.length, 'browser page')}: ${names}.`, surfaces };
}

/**
 * The subsystems' own refusals, in this domain's words — or nothing, for a genuine defect, which stays itself so it
 * surfaces as the failure it is. A refused act (a hold) answers its fixed sentence (I120).
 */
export function translate(error: unknown): BrowserToolError | undefined {
  if (error instanceof BrowserToolError) return error;
  if (error instanceof BrowserTransportError) return fromWorker(error);
  if (error instanceof ApiError && error.status === 409) return new BrowserToolError('conflict', error.message);
  if (!(error instanceof BrowserSessionError)) return undefined;
  if (error.code === 'launch_failed') return new BrowserToolError('unavailable', browserUnavailable(error.message));
  if (error.code === 'not_running')
    return new BrowserToolError(
      'not_found',
      'The browser is not running in this session. Open a page with browser.open.',
    );
  return new BrowserToolError(error.code, error.message);
}

/**
 * The worker's refusal of an act — a ref the page no longer knows, an element that never appeared — in
 * this domain's words, without the transport's "browser action failed:" prefix.
 */
function fromWorker(error: BrowserTransportError): BrowserToolError {
  const message = error.message.replace(/^browser action failed: /u, '');
  switch (error.code) {
    case 'launch_failed':
      return new BrowserToolError('unavailable', browserUnavailable(message));
    case 'not_running':
      return new BrowserToolError(
        'not_found',
        'The browser is not running in this session. Open a page with browser.open.',
      );
    case 'profile_busy':
    case 'login_window_open':
      return new BrowserToolError('conflict', message);
    default:
      return new BrowserToolError(error.code as BrowserToolErrorCode, message);
  }
}

/** One sentence: what is missing, and how to fix it. */
export function browserUnavailable(reason: string): string {
  const first = (reason.split('\n')[0] ?? '').trim().slice(0, 200);
  return `Browser tools could not start a browser on this machine (${first || 'no reason given'}): install Google Chrome or set FY_CHROME_BIN to a Chrome binary, then try again.`;
}

/**
 * What an agent is told when the page it just acted on appears to be asking for a human check: that it is one, and
 * that the owner solves it — never the agent. Empty otherwise.
 */
function humanCheckNote(answer: BrowserActionResult, pageId: string): string {
  if (!('result' in answer)) return '';
  const page = answer.result.pages.find(candidate => candidate.id === (answer.result.actedPageId ?? pageId));
  if (page?.challenge === undefined) return '';
  return ' The page appears to be showing a human check (a captcha or a "checking your browser" page). Do not try to solve or get around it: ask your owner to take the page over in Ferretry and solve it themselves, then carry on.';
}

/**
 * The host a page is on, as a standing rule's login domains name it (`github.com`, a port when there is one), or
 * `undefined` when there is none to read (`about:blank` inherits its opener's origin, so it may be any).
 */
function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).host.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}
