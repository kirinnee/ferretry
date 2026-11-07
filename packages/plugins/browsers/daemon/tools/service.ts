import type { Content, KernelPorts, Op, Picture, RedactionScope, TargetRef } from '@ferretry/kernel/contract';
import { acted, browserTarget, pageTarget, writeAct } from '../pages/acts.ts';
import { type BrowserActGuard, type BrowserPageAction, BrowserSessionError, type BrowserSubsystem } from '../pages/service.ts';
import type { BrowserActionResult, BrowserStatus } from '../pages/wire/browser.ts';
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
import type { AgentSurface, SurfaceControlView } from './control-wire.ts';
import type { BrowserFiles } from './files.ts';
import { AGENT_TOOL_MAX_OUTPUT_CHARS } from './limits.ts';
import type { BrowserToolCall } from './wire.ts';
import type { ResolvedSurface, ToolCaller } from './types.ts';

/**
 * THE BROWSER TOOLS (today's `AgentToolService`, its `browser.*` half), driven by name.
 *
 * ONE PATH FOR EVERY CALLER, AND EVERY CHECK ON IT. A ferret and a person reach the same method; what differs is
 * decided from the {@link ToolCaller} the half DERIVED from the kernel-stamped standing, never from the call:
 *
 * 1. a ferret is asked the machine's "What agents may control" switch for files and page scripts;
 * 2. the page is looked up inside the caller's own session only — a name from another is simply not there;
 * 3. a ferret acts only on a page IT opened, one a person handed to it, or a popup of those;
 * 4. a ferret is refused a page a person has taken over, checked again inside that page's own queue;
 * 5. the act runs through `kernel.act` with its `Op` (§4.7): the Vault's `InputHolds` decides inside the page's
 *    queue immediately before it, and a write-only act answers an `Ack` (`closeAck`), never page text;
 * 6. page text, a page's address, its title and a dialog's words are `reads`, masked under one `Redaction.read`
 *    for agent and person alike (S16); screenshots are not masked, so holds refuse them for the whole window.
 *
 * Every act's audit record is the kernel's (`agent.tool`, the descriptor's `audit`).
 */

export class BrowserToolError extends Error {
  constructor(
    readonly code:
      | 'bad_request'
      | 'not_found'
      | 'conflict'
      | 'forbidden'
      | 'taken_over'
      | 'capacity'
      | 'unavailable'
      | 'upstream_failed',
    message: string,
  ) {
    super(message);
    this.name = 'BrowserToolError';
  }
}

/** A browser tool's answer before it becomes MCP text: a sentence, and maybe text read, rows, or a picture. */
export interface BrowserToolAnswer {
  readonly summary: string;
  readonly output?: string;
  readonly surfaces?: readonly AgentSurface[];
  readonly matched?: boolean;
  readonly picture?: Picture;
}

/** "What agents may control" (Ferrets' machine switches): asked for a ferret's file tools and page scripts. */
export interface AgentControlPolicy {
  allows(kind: 'files' | 'scripts'): Promise<boolean>;
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
}

/** The tools that move a file between a page and the ferret's folder: they need the `files` switch too. */
const FILE_TOOLS: ReadonlySet<BrowserToolCall['tool']> = new Set(['browser.upload', 'browser.download', 'browser.pdf']);

/** The tools whose act puts up the driving marker. */
const DRIVING_TOOLS: ReadonlySet<string> = new Set<BrowserToolCall['tool']>([
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

/** The page tools carried out as one `actOnPage`. */
type PageToolCall = Extract<
  BrowserToolCall,
  {
    readonly tool:
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
  }
>;

/** Each tool's `Op` (the manifest names the same; §4.7). */
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

/** How far up a popup's opener chain ownership is followed. */
const MAX_OPENER_DEPTH = 8;

const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? '' : 's'}`;

/** A surface as a person writes it: `%browser:app`. */
export const surfaceReference = (key: string): string => `%browser:${key}`;

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

/** Whether this agent opened the surface itself — the attestation the daemon recorded, never a claim. */
const openedByAgent = (openedBy: SurfaceOpener | undefined, sessionId: string): boolean =>
  openedBy?.by === 'agent' && openedBy.sessionId === sessionId;

export function controlRefusal(kind: 'files' | 'scripts', binaryName: string): string {
  if (kind === 'scripts')
    return `browser.eval is off on this machine: "What agents may control › Page scripts" is off, and only the owner can turn it on — in the app (Settings › this machine › What agents may control › Page scripts), with \`${binaryName} machine set agent-control scripts on\`. Turning it on waits for their confirmation, because a page script can read what a page holds, sign-ins on the shared profile included. Ask them if you need it; the other browser tools work without it.`;
  return `This machine does not let agents control files: "What agents may control › Files" is off in this machine's settings. Ask the person to turn it on if you need it.`;
}

export class BrowserTools {
  constructor(private readonly ports: BrowserToolPorts) {}

  async call(caller: ToolCaller, call: BrowserToolCall): Promise<BrowserToolAnswer> {
    try {
      if (caller.kind === 'agent' && FILE_TOOLS.has(call.tool) && !(await this.ports.policy.allows('files')))
        throw new BrowserToolError('forbidden', controlRefusal('files', this.ports.binaryName));
      // Page scripts are the owner's to allow for EVERY caller: a paired device with the browser grant must not read
      // the shared profile's sign-ins through a script while the owner has them off.
      if (call.tool === 'browser.eval' && !(await this.ports.policy.allows('scripts')))
        throw new BrowserToolError('forbidden', controlRefusal('scripts', this.ports.binaryName));
      return await this.dispatch(caller, call);
    } catch (error) {
      throw translate(error) ?? error;
    }
  }

  /** Every live driving marker, standing takeover and hand-over in one session. */
  async controlView(sessionId: string): Promise<SurfaceControlView> {
    return await this.alive(sessionId, await this.ports.control.view(sessionId, 'browser'));
  }

  /** A person takes a page over from the agent, hands it back, or hands it to the agent. */
  async control(
    sessionId: string,
    request: { readonly action: 'takeover' | 'handback' | 'handover'; readonly key: string },
    by: Parameters<SurfaceControl['takeover']>[2],
  ): Promise<SurfaceControlView> {
    const surface = await this.resolve(sessionId, request.key);
    if (request.action === 'takeover') await this.ports.control.takeover(sessionId, surface, by);
    else if (request.action === 'handback') await this.ports.control.handback(sessionId, surface);
    else await this.ports.control.hand(sessionId, surface, by);
    return await this.controlView(sessionId);
  }

  private async dispatch(caller: ToolCaller, call: BrowserToolCall): Promise<BrowserToolAnswer> {
    const { sessionId } = caller;
    switch (call.tool) {
      case 'browser.list':
        return await this.listPages(caller);
      case 'browser.tabs':
        return await this.tabs(caller, call);
      case 'browser.open':
        return await this.open(caller, call);
      default: {
        const surface = await this.resolve(sessionId, call.name);
        if (caller.kind === 'agent') await this.assertAgentMay(sessionId, surface);
        const answer = await this.act(caller, call, surface);
        await this.drove(caller, call.tool, surface);
        return answer;
      }
    }
  }

  private async open(
    caller: ToolCaller,
    call: Extract<BrowserToolCall, { readonly tool: 'browser.open' }>,
  ): Promise<BrowserToolAnswer> {
    const { sessionId } = caller;
    const opener: SurfaceOpener | undefined = caller.kind === 'agent' ? { by: 'agent', sessionId } : caller.openedBy;
    let opened: { readonly id: string; readonly incognito: boolean } | undefined;
    await writeAct(this.ports.kernel.act, browserTarget(sessionId), 'open', async () => {
      const page = await this.ports.browser.openPage(sessionId, call.name, {
        ...(call.url === undefined ? {} : { url: call.url }),
        ...(opener === undefined ? {} : { openedBy: opener }),
        ...(call.incognito === true ? { incognito: true } : {}),
      });
      // The daemon's own page id, which the act runner keys the page by: never a page-derived string.
      opened = { id: page.id, incognito: page.incognito === true };
    });
    if (opened === undefined) throw new BrowserToolError('upstream_failed', 'The browser opened no page.');
    const surface: ResolvedSurface = {
      surface: 'browser',
      id: opened.id,
      name: call.name,
      ...(opened.incognito ? { incognito: true as const } : {}),
      opened: true,
    };
    await this.drove(caller, call.tool, surface);
    await this.announce(caller, surface, call.askOwner);
    const at = await this.whereNow(sessionId, surface);
    const kind = call.incognito === true ? 'an incognito page, ' : '';
    return { summary: `Opened ${kind}${surfaceReference(call.name)}${at}${handedNote(call.askOwner)}.` };
  }

  /** The act itself, on a page already resolved inside the caller's session and cleared for it. */
  private async act(caller: ToolCaller, call: BrowserToolCall, surface: ResolvedSurface): Promise<BrowserToolAnswer> {
    const reference = surfaceReference(surface.name ?? surface.id);
    const target = pageTarget(surface.id);
    const guard = this.browserGuard(caller, surface);
    switch (call.tool) {
      case 'browser.ask_owner':
        if (caller.kind !== 'agent')
          throw new BrowserToolError('bad_request', 'Only an agent hands a surface to its owner; you already have it.');
        await this.announce(caller, surface, call.message ?? true, true);
        return {
          summary: `Asked the owner to take over ${reference}${call.message === undefined ? '' : ' and told them what to do'}. Wait for them: read the surface to see when they are done.`,
        };
      case 'browser.close':
        await writeAct(this.ports.kernel.act, target, 'close', async () => {
          await this.ports.browser.closePage(caller.sessionId, surface.id, guard);
        });
        this.ports.control.forget(caller.sessionId, surface);
        return { summary: `Closed ${reference}.` };
      case 'browser.dialog':
        await writeAct(this.ports.kernel.act, target, 'press', async () => {
          await this.ports.browser.lifecycleOnPage(
            caller.sessionId,
            surface.id,
            { op: 'dialog', action: call.action, ...(call.promptText === undefined ? {} : { promptText: call.promptText }) },
            guard,
          );
        });
        return { summary: `Answered the dialog on ${reference} (${call.action}).${await this.notes(caller.sessionId, surface)}` };
      case 'browser.emulate': {
        const { tool: _tool, name: _name, ...emulation } = call;
        await writeAct(this.ports.kernel.act, target, 'navigate', async () => {
          await this.ports.browser.lifecycleOnPage(
            caller.sessionId,
            surface.id,
            { op: 'emulate', emulation: emulation as BrowserEmulation },
            guard,
          );
        });
        return { summary: `Emulation applied on ${reference}.${await this.notes(caller.sessionId, surface)}` };
      }
      case 'browser.wait_for':
        return await this.waitFor(caller, call, surface, reference, target, guard);
      case 'browser.console':
      case 'browser.network':
        return await this.log(caller, call, surface, reference, target, guard);
      case 'browser.upload':
      case 'browser.download':
      case 'browser.pdf':
        return await this.filesOn(caller, call, surface, reference, target, guard);
      case 'browser.eval':
        return await this.script(caller, call, surface, reference, target, guard);
      case 'browser.list':
      case 'browser.tabs':
      case 'browser.open':
        throw new BrowserToolError('bad_request', 'That tool names no page.');
      default:
        return await this.browse(caller, call, surface, reference, target, guard);
    }
  }

  /** The page tools carried out as one `actOnPage`: a write answers an Ack and reads where the page is after. */
  private async browse(
    caller: ToolCaller,
    call: PageToolCall,
    surface: ResolvedSurface,
    reference: string,
    target: TargetRef,
    guard: BrowserActGuard | undefined,
  ): Promise<BrowserToolAnswer> {
    const op = TOOL_OPS[call.tool];
    const run = async (): Promise<BrowserActionResult> =>
      await this.ports.browser.actOnPage(caller.sessionId, surface.id, pageActionOf(call), guard);
    if (op === 'read') {
      const mode = browserReadModeOf(call as Parameters<typeof browserReadModeOf>[0]);
      const content = acted<'read'>(
        await this.ports.kernel.act(target, 'read', async () => {
          const answer = await run();
          const page = 'result' in answer ? answer.result : undefined;
          const text = page !== undefined && 'text' in page && typeof page.text === 'string' ? page.text : '';
          return await this.ports.kernel.redaction.read(scope => ({
            kind: 'content' as const,
            text: scope.text(text),
            data: { at: page === undefined ? null : scope.text(page.url), check: checkNote(answer, surface.id) },
          }));
        }),
      );
      const { at, check } = content.data as { at: string | null; check: string };
      const now = at === null ? '' : ` (now at ${at})`;
      const text = content.text ?? '';
      if (call.tool === 'browser.read' && call.find !== undefined && text === '')
        return { summary: `Nothing in the snapshot of ${reference} contains that text${now}.${check}`, output: '' };
      const output = mode === 'text' ? clipOutput(text) : clipReading(text);
      const clipped = output.length < text.length ? CLIPPED_SNAPSHOT_NOTE : '';
      const refs = mode === 'snapshot' ? REFS_NOTE : '';
      return { summary: `Read ${reference}${now}.${refs}${clipped}${check}`, output };
    }
    if (op === 'picture') {
      const picture = acted<'picture'>(
        await this.ports.kernel.act(target, 'picture', async () => {
          const answer = await run();
          const page = 'result' in answer ? answer.result : undefined;
          const base64 = page !== undefined && 'screenshotBase64' in page ? page.screenshotBase64 : '';
          const jpeg = page !== undefined && 'screenshotFormat' in page && page.screenshotFormat === 'jpeg';
          return { kind: 'picture' as const, mime: jpeg ? ('image/jpeg' as const) : ('image/png' as const), bytes: Buffer.from(String(base64), 'base64') };
        }),
      );
      if (call.tool === 'browser.highlight')
        return { summary: `${call.clear === true ? 'Cleared the outline on' : 'Outlined it on'} ${reference}.${await this.notes(caller.sessionId, surface)}` };
      return { summary: `A screenshot of ${reference}.${await this.notes(caller.sessionId, surface)}`, picture };
    }
    await writeAct(this.ports.kernel.act, target, op, run);
    return { summary: `Done on ${reference}${await this.whereNow(caller.sessionId, surface)}.${await this.notes(caller.sessionId, surface)}` };
  }

  /**
   * `browser.wait_for`: ONE SECOND AT A TIME, with the takeover guard between slices, so a wait ends the moment a
   * person takes the page over. A dialog that opens ends it too, since it blocks the page.
   */
  private async waitFor(
    caller: ToolCaller,
    call: Extract<BrowserToolCall, { readonly tool: 'browser.wait_for' }>,
    surface: ResolvedSurface,
    reference: string,
    target: TargetRef,
    guard: BrowserActGuard | undefined,
  ): Promise<BrowserToolAnswer> {
    const condition = waitConditionOf(call);
    const { clock } = this.ports.kernel;
    if (condition.kind === 'time') {
      for (let left = condition.ms; left > 0; left -= BROWSER_WAIT_SLICE_MS) {
        await clock.sleep(Math.min(BROWSER_WAIT_SLICE_MS, left) as never);
        if (caller.kind === 'agent') await this.assertFree(caller.sessionId, surface);
      }
      return { summary: `Waited ${String(condition.ms)} ms on ${reference}.`, matched: true };
    }
    const timeoutMs = call.timeoutMs ?? BROWSER_WAIT_DEFAULT_MS;
    const deadline = clock.nowMs() + timeoutMs;
    for (let waited = 0; ; ) {
      const slice = Math.max(1, Math.min(BROWSER_WAIT_SLICE_MS, timeoutMs - waited));
      const content = acted<'wait'>(
        await this.ports.kernel.act(target, 'wait', async () => {
          const out = await this.ports.browser.lifecycleOnPage(
            caller.sessionId,
            surface.id,
            { op: 'wait', condition, timeoutMs: slice },
            guard,
          );
          return await this.ports.kernel.redaction.read(scope => ({
            kind: 'content' as const,
            data: { matched: out.reply.matched === true, dialog: dialogWords(scope, out.dialog) },
          }));
        }),
      );
      waited += slice;
      const { matched, dialog } = content.data as { matched: boolean; dialog: string | null };
      if (matched) return { summary: `The wait on ${reference} is over: it happened.`, matched: true };
      if (dialog !== null)
        return { summary: `The wait on ${reference} stopped: the page is blocked by a dialog.${dialog}`, matched: false };
      if (waited >= timeoutMs || clock.nowMs() >= deadline)
        return { summary: `Still waiting on ${reference}: the wait timed out after ${String(timeoutMs)} ms.`, matched: false };
    }
  }

  /** `browser.console` and `browser.network`: one log read, masked. */
  private async log(
    caller: ToolCaller,
    call: Extract<BrowserToolCall, { readonly tool: 'browser.console' | 'browser.network' }>,
    surface: ResolvedSurface,
    reference: string,
    target: TargetRef,
    guard: BrowserActGuard | undefined,
  ): Promise<BrowserToolAnswer> {
    const request: BrowserPageLifecycleRequest =
      call.tool === 'browser.console'
        ? {
            op: 'console',
            ...(call.level === undefined ? {} : { level: call.level }),
            ...(call.since === undefined ? {} : { since: call.since }),
            ...(call.limit === undefined ? {} : { limit: call.limit }),
          }
        : {
            op: 'network',
            action: call.action,
            ...(call.id === undefined ? {} : { id: call.id }),
            ...(call.filter === undefined ? {} : { filter: call.filter }),
            ...(call.types === undefined ? {} : { types: call.types }),
          };
    const content = acted<'read'>(
      await this.ports.kernel.act(target, 'read', async () => {
        const out = await this.ports.browser.lifecycleOnPage(caller.sessionId, surface.id, request, guard);
        return await this.ports.kernel.redaction.read(scope => ({
          kind: 'content' as const,
          text: scope.text(out.reply.text ?? ''),
          data: { dialog: dialogWords(scope, out.dialog) ?? '' },
        }));
      }),
    );
    const dialog = (content.data as { dialog: string }).dialog;
    if (call.tool === 'browser.console')
      return { summary: `The console of ${reference}.${dialog}`, output: clipOutput(content.text ?? '') };
    const what = call.action === 'get' ? `Request ${call.id ?? ''} of` : 'The requests of';
    return {
      summary: `${what} ${reference}.${dialog}`,
      output: call.action === 'get' ? clipReading(content.text ?? '') : clipOutput(content.text ?? ''),
    };
  }

  /** An agent's own script, in an isolated world on its page (owner-gated: checked in {@link call}). */
  private async script(
    caller: ToolCaller,
    call: Extract<BrowserToolCall, { readonly tool: 'browser.eval' }>,
    surface: ResolvedSurface,
    reference: string,
    target: TargetRef,
    guard: BrowserActGuard | undefined,
  ): Promise<BrowserToolAnswer> {
    const element = call.ref !== undefined || call.selector !== undefined ? elementTargetOf(call) : undefined;
    const content = acted<'script'>(
      await this.ports.kernel.act(target, 'script', async () => {
        const answer = await this.ports.browser.scriptOnPage(
          caller.sessionId,
          surface.id,
          {
            source: call.function,
            ...(element === undefined ? {} : { target: element }),
            ...(call.timeoutMs === undefined ? {} : { timeoutMs: call.timeoutMs }),
          },
          guard,
        );
        return await this.ports.kernel.redaction.read(scope => ({
          kind: 'content' as const,
          text: scope.text(answer.text),
          data: { at: scope.text(answer.result.url), check: checkNote(answer, surface.id) },
        }));
      }),
    );
    const { at, check } = content.data as { at: string; check: string };
    const text = content.text ?? '';
    const output = clipReading(text);
    const clipped = output.length < text.length ? ' It was clipped to fit: return less.' : '';
    return { summary: `Ran your script on ${reference} (now at ${at}).${clipped}${check}`, output };
  }

  /**
   * The file tools (S51). An upload hands the page the files the folder fence accepted under the ferret's own folder;
   * a download or a PDF is staged by the browser and saved under the ferret's downloads root, never over a file
   * unless asked.
   */
  private async filesOn(
    caller: ToolCaller,
    call: Extract<BrowserToolCall, { readonly tool: 'browser.upload' | 'browser.download' | 'browser.pdf' }>,
    surface: ResolvedSurface,
    reference: string,
    target: TargetRef,
    guard: BrowserActGuard | undefined,
  ): Promise<BrowserToolAnswer> {
    const { sessionId } = caller;
    if (call.tool === 'browser.upload') {
      const prepared = await this.ports.files.prepareUpload(sessionId, call.files);
      await writeAct(this.ports.kernel.act, target, 'fill', async () => {
        await this.ports.browser.filesOnPage(
          sessionId,
          surface.id,
          { action: 'upload', target: elementTargetOf(call), paths: prepared.files.map(file => file.path), mode: call.mode ?? 'input' },
          guard,
        );
      });
      const how = call.mode === 'drop' ? 'Dropped' : 'Gave';
      const size = sizeWords(prepared.files.reduce((sum, file) => sum + file.size, 0));
      return {
        summary: `${how} ${plural(prepared.files.length, 'file')} (${size}) ${call.mode === 'drop' ? 'onto' : 'to'} ${reference}${await this.whereNow(sessionId, surface)}.${await this.notes(sessionId, surface)}`,
      };
    }
    const op = call.tool === 'browser.pdf' ? 'picture' : 'read';
    let saved: { readonly saved: string; readonly size: number } | undefined;
    const save = async (): Promise<void> => {
      const answer = await this.ports.browser.filesOnPage(
        sessionId,
        surface.id,
        call.tool === 'browser.download' ? { action: 'download', ...(call.id === undefined ? {} : { downloadId: call.id }) } : { action: 'pdf' },
        guard,
      );
      if (answer.staged === undefined) throw new BrowserToolError('upstream_failed', 'The browser staged no file to save.');
      saved = await this.ports.files.save(sessionId, answer.staged, { saveAs: call.saveAs, overwrite: call.overwrite === true });
    };
    if (op === 'picture') {
      acted<'picture'>(
        await this.ports.kernel.act(target, 'picture', async () => {
          await save();
          return { kind: 'picture' as const, mime: 'application/pdf' as const, bytes: new Uint8Array() };
        }),
      );
    } else {
      acted<'read'>(
        await this.ports.kernel.act(target, 'read', async (): Promise<Content> => {
          await save();
          return { kind: 'content' };
        }),
      );
    }
    if (saved === undefined) throw new BrowserToolError('upstream_failed', 'The browser staged no file to save.');
    const what = call.tool === 'browser.pdf' ? 'Printed' : 'Saved';
    const name = await this.ports.kernel.redaction.read(scope => scope.text(saved?.saved ?? ''));
    return { summary: `${what} ${reference} as ${name} (${sizeWords(saved.size)}) in this ferret's downloads folder.` };
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
      throw new BrowserToolError('bad_request', `${reference} is not a popup: only a page another page opened can be adopted.`);
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

  /** The pages, each title and address masked; an agent sees only its own and the ones handed to it. */
  private async listPages(caller: ToolCaller, tabs = false): Promise<BrowserToolAnswer> {
    const status = await this.ports.browser.status(caller.sessionId);
    const rows: AgentSurface[] = [];
    for (const page of status.pages) {
      const row: ResolvedSurface = {
        surface: 'browser',
        id: page.id,
        ...(page.name === undefined ? {} : { name: page.name }),
        ...(page.openedBy === undefined ? {} : { openedBy: page.openedBy }),
        ...(page.openerId === undefined ? {} : { openerId: page.openerId }),
        ...(page.incognito === true ? { incognito: true as const } : {}),
      };
      const available =
        caller.kind !== 'agent' ||
        (await this.assertAgentMay(caller.sessionId, row, status.pages).then(
          () => true,
          () => false,
        ));
      if (!available) continue;
      rows.push(
        await this.ports.kernel.redaction.read(scope => ({
          id: page.id,
          ...(page.name === undefined ? {} : { name: page.name }),
          title: scope.text(page.title),
          url: scope.text(page.url),
          ...(page.incognito === true ? { incognito: true as const } : {}),
          ...(page.openerId === undefined ? {} : { openerId: page.openerId }),
          ...(caller.kind === 'agent' ? { available: true } : {}),
        })) as AgentSurface,
      );
    }
    const listing: BrowserToolAnswer =
      rows.length === 0
        ? { summary: 'No browser pages are open for you in this session.', surfaces: rows }
        : {
            summary: `${plural(rows.length, 'browser page')}: ${rows.map(row => surfaceReference(row.name ?? row.id)).join(', ')}.`,
            surfaces: rows,
          };
    const popups = rows.filter(row => row.openerId !== undefined && row.name === undefined);
    if (!tabs || popups.length === 0) return listing;
    return {
      ...listing,
      summary: `${listing.summary} Popups with no name yet: ${popups.map(row => row.id).join(', ')}; give one a name with browser.tabs (action "adopt", id, as).`,
    };
  }

  /** Where a page is now, masked, as a `read` under the page's hold: ` (now at …)`, or nothing. */
  private async whereNow(sessionId: string, surface: ResolvedSurface): Promise<string> {
    const read = await this.ports.kernel.act(pageTarget(surface.id), 'read', async () => {
      const status = await this.ports.browser.status(sessionId);
      const page = status.pages.find(each => each.id === surface.id);
      return await this.ports.kernel.redaction.read(scope => ({
        kind: 'content' as const,
        text: page === undefined ? '' : scope.text(page.url),
      }));
    });
    return read.ok && read.value.text !== undefined && read.value.text !== '' ? ` (now at ${read.value.text})` : '';
  }

  /** The human-check note read after an act, as a `read` under the page's hold. */
  private async notes(sessionId: string, surface: ResolvedSurface): Promise<string> {
    const status = await this.ports.browser.status(sessionId).catch(() => undefined);
    const page = status?.pages.find(each => each.id === surface.id);
    return page?.challenge === undefined ? '' : HUMAN_CHECK_NOTE;
  }

  /**
   * The check the browser runs INSIDE the page's own queue, right before an agent's act: a takeover that landed
   * while the act was waiting its turn still refuses it. Holds are the act runner's (§4.7), not this guard's.
   */
  private browserGuard(caller: ToolCaller, surface: ResolvedSurface): BrowserActGuard | undefined {
    if (caller.kind !== 'agent') return undefined;
    return async () => await this.assertFree(caller.sessionId, surface);
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
    };
  }

  /** Whether an agent may act on this page now: it is the agent's, and nobody is holding it. */
  private async assertAgentMay(sessionId: string, surface: ResolvedSurface, pages?: BrowserStatus['pages']): Promise<void> {
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

  /** Whether a page is a popup of one of the agent's own: its opener chain ends at a page this agent opened or was handed. */
  private async popupOfMine(sessionId: string, surface: ResolvedSurface, known?: BrowserStatus['pages']): Promise<boolean> {
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

  /** Whether a person holds THIS page. Holding one page holds nothing else. */
  private async assertFree(sessionId: string, surface: ResolvedSurface): Promise<void> {
    const takeover = await this.ports.control.takeoverOf(sessionId, surface);
    if (takeover === undefined) return;
    throw new BrowserToolError('taken_over', `A person has taken over ${surfaceReference(surface.name ?? surface.id)}; wait or ask them.`);
  }

  private async drove(caller: ToolCaller, tool: string, surface: ResolvedSurface): Promise<void> {
    if (caller.kind !== 'agent' || !DRIVING_TOOLS.has(tool)) return;
    // The marker is a courtesy to the person watching; a record that cannot take it must not fail an act that happened.
    await this.ports.control
      .drove(caller.sessionId, surface, caller.name === undefined ? {} : { name: caller.name })
      .catch(() => undefined);
  }

  /** Tells the owner about a page the AGENT opened and, when it asked for them, hands it over ("your turn here"). */
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

/** A dialog's words, masked, as the note after an act: ` A confirm dialog is waiting …`, or `null`. */
function dialogWords(scope: RedactionScope, dialog: BrowserDialogInfo | undefined): string | null {
  if (dialog === undefined) return null;
  return ` A ${dialog.type} dialog is waiting on this page: "${scope.text(dialog.message)}". The page can do nothing until it is answered: use browser.dialog with accept or dismiss (it is dismissed on its own after 30 seconds).`;
}

/** The one thing a `browser.wait_for` waits for. The call schema already holds it to exactly one. */
function waitConditionOf(call: Extract<BrowserToolCall, { readonly tool: 'browser.wait_for' }>): BrowserWaitCondition {
  const target = browserTargetOf(call);
  if (target !== undefined && target.kind !== 'point') return { kind: 'element', target, state: call.state ?? 'visible' };
  if (call.text !== undefined) return { kind: 'text', text: call.text };
  if (call.textGone !== undefined) return { kind: 'textGone', text: call.textGone };
  if (call.url !== undefined) return { kind: 'url', url: call.url };
  if (call.load !== undefined) return { kind: 'load', state: call.load };
  return { kind: 'time', ms: call.time ?? 1 };
}

/** The browser's own action for a page tool's call. */
export function pageActionOf(call: PageToolCall): BrowserPageAction {
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

/** The element an act aims at, as the browser takes it. */
function elementTargetOf(fields: BrowserTargetFields): BrowserElementTarget {
  return fields.ref !== undefined ? { kind: 'ref', ref: fields.ref } : { kind: 'selector', selector: fields.selector as string };
}

/** The element fields of a page tool's call, if it carries any. */
function elementOfCall(call: object): { selector?: string; ref?: string } {
  const { selector, ref } = call as { selector?: unknown; ref?: unknown };
  return { ...(typeof selector === 'string' ? { selector } : {}), ...(typeof ref === 'string' ? { ref } : {}) };
}

function pointOf(call: { readonly x?: number | undefined; readonly y?: number | undefined }) {
  return call.x === undefined || call.y === undefined ? {} : { x: call.x, y: call.y };
}

/** Told after a snapshot: the refs in it are what every act accepts. */
const REFS_NOTE = ' Pass a ref from it (ref: "e12") to any browser tool instead of a selector.';
/** Told when a snapshot was longer than one answer holds. */
const CLIPPED_SNAPSHOT_NOTE = ' It was clipped to fit: read one part with a ref or selector, ask for less depth, or find a text.';

const HUMAN_CHECK_NOTE =
  ' The page appears to be showing a human check (a captcha or a "checking your browser" page). Do not try to solve or get around it: ask your owner to take the page over in Ferretry and solve it themselves, then carry on.';

const handedNote = (askOwner: true | string | undefined): string =>
  askOwner === undefined ? '' : ' and asked the owner to take over (wait for them)';

/** What an agent is told when the page it just read appears to be asking for a human check (I124). */
function checkNote(answer: object, pageId: string): string {
  const result = (answer as { readonly result?: unknown }).result as { readonly pages?: readonly { readonly id: string; readonly challenge?: unknown }[]; readonly actedPageId?: string } | undefined;
  const page = result?.pages?.find(candidate => candidate.id === (result.actedPageId ?? pageId));
  return page?.challenge === undefined ? '' : HUMAN_CHECK_NOTE;
}

/** "1.2 MB". */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One sentence: what is missing, and how to fix it. */
export function browserUnavailable(reason: string): string {
  const first = (reason.split('\n')[0] ?? '').trim().slice(0, 200);
  return `Browser tools could not start a browser on this machine (${first || 'no reason given'}): install Google Chrome or set FY_CHROME_BIN to a Chrome binary, then try again.`;
}

/** The subsystems' own refusals, in this domain's words — or nothing, for a genuine defect. */
export function translate(error: unknown): BrowserToolError | undefined {
  if (error instanceof BrowserToolError) return error;
  if (error instanceof BrowserTransportError) {
    const message = error.message.replace(/^browser action failed: /u, '');
    if (error.code === 'launch_failed') return new BrowserToolError('unavailable', browserUnavailable(message));
    if (error.code === 'not_running')
      return new BrowserToolError('not_found', 'The browser is not running in this session. Open a page with browser.open.');
    if (error.code === 'profile_busy' || error.code === 'login_window_open') return new BrowserToolError('conflict', message);
    return new BrowserToolError(error.code as BrowserToolError['code'], message);
  }
  if (!(error instanceof BrowserSessionError)) return undefined;
  if (error.code === 'launch_failed') return new BrowserToolError('unavailable', browserUnavailable(error.message));
  if (error.code === 'not_running')
    return new BrowserToolError('not_found', 'The browser is not running in this session. Open a page with browser.open.');
  return new BrowserToolError(error.code, error.message);
}
