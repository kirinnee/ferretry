import {
  AGENT_TOOL_DEFAULT_READ_LINES,
  AGENT_TOOL_DEFAULT_WAIT_MS,
  type AgentSurface,
  type AgentToolCall,
  type AgentToolResult,
  type AuditDetail,
  type AuditOutcome,
  type BrowserActionResult,
  type SurfaceControlRequest,
  type SurfaceController,
  type SurfaceControlView,
  type SurfaceKind,
} from '@ferretry/protocol';
import type { AuditSink } from '../audit/types.ts';
import { BrowserSessionError, type BrowserPageAction, type BrowserSubsystem } from '../browser/runtime/index.ts';
import { TerminalMountError, type TerminalSubsystem } from '../runtime/mounts/terminals.ts';
import type { SurfaceControl } from './control.ts';
import {
  auditHost,
  auditSelector,
  clipOutput,
  controlRefusal,
  isShellForeground,
  surfaceReference,
  terminalInput,
} from './policy.ts';
import type { AgentControlPolicy, AgentToolCaller, AgentToolClock, ResolvedSurface } from './types.ts';

/**
 * Why a tool call was not carried out, in words an agent can act on.
 *
 * `taken_over` is its own code rather than `forbidden`: the agent did nothing wrong, a person is
 * using the surface, and the right response is to wait — not to stop trying for good.
 */
export class AgentToolError extends Error {
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
    this.name = 'AgentToolError';
  }
}

/** How often a wait looks again. */
export const AGENT_TOOL_POLL_MS = 250;
/** How many recent lines a wait for text searches, and how many it hands back. */
const WAIT_SEARCH_LINES = 500;
const WAIT_TAIL_LINES = 40;

export interface AgentToolPorts {
  readonly terminals: Pick<TerminalSubsystem, 'list' | 'create' | 'write' | 'text' | 'foreground' | 'close'>;
  readonly browser: Pick<BrowserSubsystem, 'status' | 'openPage' | 'actOnPage' | 'closePage'>;
  readonly control: SurfaceControl;
  readonly policy: AgentControlPolicy;
  readonly audit: AuditSink;
  readonly clock: AgentToolClock;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

/** The tools that change what a person would see, and so put up the driving marker. */
const DRIVING_TOOLS: ReadonlySet<AgentToolCall['tool']> = new Set([
  'terminal.open',
  'terminal.send',
  'browser.open',
  'browser.navigate',
  'browser.click',
  'browser.type',
]);

const kindOf = (call: AgentToolCall): SurfaceKind => (call.tool.startsWith('terminal.') ? 'terminal' : 'browser');

const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? '' : 's'}`;

/**
 * The agent tools: terminals and browser pages, driven by name.
 *
 * ONE PATH FOR EVERY CALLER, AND EVERY CHECK ON IT. An agent and a person reach the same method; what
 * differs is decided from the {@link AgentToolCaller} the route DERIVED, never from the call:
 *
 * 1. an agent is asked the machine's "What agents may control" switch for this kind first;
 * 2. the surface is looked up inside the caller's own session only — a name from another session
 *    is simply not there;
 * 3. an agent is refused a surface a person has taken over;
 * 4. the act is carried out, and an agent's act puts up the driving marker;
 * 5. one audit record names the tool, the surface and the outcome — with lengths, never the text.
 */
export class AgentToolService {
  constructor(private readonly ports: AgentToolPorts) {}

  async call(caller: AgentToolCaller, call: AgentToolCall): Promise<AgentToolResult> {
    const facts: { surface?: ResolvedSurface } = {};
    try {
      if (caller.kind === 'agent' && !(await this.ports.policy.allows(kindOf(call))))
        throw new AgentToolError('forbidden', controlRefusal(kindOf(call)));
      const result = await this.dispatch(caller, call, facts);
      await this.record(caller, call, facts.surface, 'succeeded');
      return result;
    } catch (error) {
      const refusal = translate(error);
      const failed = refusal === undefined || refusal.code === 'upstream_failed';
      await this.record(caller, call, facts.surface, failed ? 'failed' : 'refused');
      throw refusal ?? error;
    }
  }

  /** Every live driving marker and standing takeover in one session. */
  controlView(sessionId: string): SurfaceControlView {
    return this.ports.control.view(sessionId);
  }

  /** A person takes a surface over from the agent, or hands it back. */
  async control(
    sessionId: string,
    kind: SurfaceKind,
    request: SurfaceControlRequest,
    by: SurfaceController,
    actor: AgentToolCaller & { readonly kind: 'person' },
  ): Promise<SurfaceControlView> {
    let outcome: AuditOutcome = 'refused';
    let surface: ResolvedSurface | undefined;
    try {
      surface = await this.resolve(sessionId, kind, request.key);
      if (request.action === 'takeover') await this.ports.control.takeover(sessionId, surface, by);
      else await this.ports.control.handback(sessionId, surface);
      outcome = 'succeeded';
      return this.ports.control.view(sessionId);
    } catch (error) {
      throw translate(error) ?? error;
    } finally {
      await this.ports.audit.record({
        event: 'surface.control',
        actor: actor.actor,
        subject: sessionId,
        outcome,
        detail: {
          action: request.action,
          surface: surfaceReference(kind, surface?.name ?? surface?.id ?? request.key),
        },
      });
    }
  }

  private async dispatch(
    caller: AgentToolCaller,
    call: AgentToolCall,
    facts: { surface?: ResolvedSurface },
  ): Promise<AgentToolResult> {
    const { sessionId } = caller;
    switch (call.tool) {
      case 'terminal.list':
        return await this.listTerminals(sessionId);
      case 'browser.list':
        return await this.listPages(sessionId);
      case 'terminal.open': {
        const opened = await this.ports.terminals.create(
          sessionId,
          { name: call.name, ...(call.folder === undefined ? {} : { folder: call.folder }) },
          caller.kind === 'agent' ? { by: 'agent', sessionId } : caller.openedBy,
        );
        facts.surface = { surface: 'terminal', id: opened.id, name: call.name };
        if (call.command !== undefined)
          await this.ports.terminals.write(sessionId, opened.id, terminalInput(call.command, ['enter']));
        await this.drove(caller, call, facts.surface);
        return {
          summary: `Opened ${surfaceReference('terminal', call.name)}${call.command === undefined ? '' : ' and started the command'}.`,
        };
      }
      case 'browser.open': {
        const page = await this.ports.browser.openPage(sessionId, call.name, call.url);
        facts.surface = { surface: 'browser', id: page.id, name: call.name };
        await this.drove(caller, call, facts.surface);
        return { summary: `Opened ${surfaceReference('browser', call.name)} at ${page.url}.` };
      }
      default: {
        const surface = await this.resolve(sessionId, kindOf(call), call.name);
        facts.surface = surface;
        if (caller.kind === 'agent') this.assertFree(sessionId, surface);
        const result = await this.act(sessionId, call, surface);
        await this.drove(caller, call, surface);
        return result;
      }
    }
  }

  /** The act itself, on a surface already resolved inside the caller's session. */
  private async act(
    sessionId: string,
    call: Exclude<
      AgentToolCall,
      { readonly tool: 'terminal.list' | 'browser.list' | 'terminal.open' | 'browser.open' }
    >,
    surface: ResolvedSurface,
  ): Promise<AgentToolResult> {
    const reference = surfaceReference(surface.surface, surface.name ?? surface.id);
    switch (call.tool) {
      case 'terminal.send': {
        await this.ports.terminals.write(sessionId, surface.id, terminalInput(call.text, call.keys));
        const parts = [
          ...(call.text === undefined ? [] : [plural(call.text.length, 'character')]),
          ...(call.keys === undefined ? [] : [plural(call.keys.length, 'key')]),
        ];
        return { summary: `Sent ${parts.join(' and ')} to ${reference}.` };
      }
      case 'terminal.read': {
        const lines = call.lines ?? AGENT_TOOL_DEFAULT_READ_LINES;
        const output = clipOutput(await this.ports.terminals.text(sessionId, surface.id, lines));
        return { summary: `The last ${plural(lines, 'line')} of ${reference}.`, output };
      }
      case 'terminal.wait':
        return await this.wait(sessionId, call, surface, reference);
      case 'terminal.close':
        await this.ports.terminals.close(sessionId, surface.id);
        this.ports.control.forget(sessionId, surface);
        return { summary: `Closed ${reference}.` };
      case 'browser.close':
        await this.ports.browser.closePage(sessionId, surface.id);
        this.ports.control.forget(sessionId, surface);
        return { summary: `Closed ${reference}.` };
      default:
        return await this.browse(sessionId, call, surface, reference);
    }
  }

  private async browse(
    sessionId: string,
    call: Extract<
      AgentToolCall,
      { readonly tool: 'browser.navigate' | 'browser.click' | 'browser.type' | 'browser.read' | 'browser.screenshot' }
    >,
    surface: ResolvedSurface,
    reference: string,
  ): Promise<AgentToolResult> {
    const action: BrowserPageAction =
      call.tool === 'browser.navigate'
        ? { action: 'navigate', url: call.url }
        : call.tool === 'browser.click'
          ? { action: 'click', selector: call.selector }
          : call.tool === 'browser.type'
            ? { action: 'type', selector: call.selector, text: call.text }
            : call.tool === 'browser.read'
              ? {
                  action: 'read',
                  ...(call.selector === undefined ? {} : { selector: call.selector }),
                  ...(call.mode === undefined ? {} : { mode: call.mode }),
                }
              : { action: 'screenshot' };
    const answer: BrowserActionResult = await this.ports.browser.actOnPage(sessionId, surface.id, action);
    const page: { readonly url?: string; readonly text?: unknown; readonly screenshotBase64?: unknown } =
      'result' in answer ? answer.result : {};
    const at = page.url === undefined ? '' : ` (now at ${page.url})`;
    if (typeof page.text === 'string') return { summary: `Read ${reference}${at}.`, output: clipOutput(page.text) };
    if (typeof page.screenshotBase64 === 'string')
      return { summary: `A screenshot of ${reference}${at}.`, screenshotBase64: page.screenshotBase64 };
    return { summary: `Done on ${reference}${at}.` };
  }

  /**
   * Waits, inside one bounded request, for text to appear or for the running command to end.
   *
   * THE FIRST LOOK IS ONE POLL INTERVAL LATER, not immediately: a wait for `exit` sent straight after
   * a command would otherwise look before the shell has even started it, find the shell in the
   * foreground, and report a command that never ran as finished.
   */
  private async wait(
    sessionId: string,
    call: Extract<AgentToolCall, { readonly tool: 'terminal.wait' }>,
    surface: ResolvedSurface,
    reference: string,
  ): Promise<AgentToolResult> {
    const deadline = this.ports.clock.now() + (call.timeoutMs ?? AGENT_TOOL_DEFAULT_WAIT_MS);
    const tail = async (): Promise<string> =>
      clipOutput(await this.ports.terminals.text(sessionId, surface.id, WAIT_TAIL_LINES));
    for (;;) {
      await this.ports.sleep(AGENT_TOOL_POLL_MS);
      const matched =
        call.text === undefined
          ? await this.ended(sessionId, surface)
          : (await this.ports.terminals.text(sessionId, surface.id, WAIT_SEARCH_LINES)).includes(call.text);
      if (matched === 'closed') return { summary: `${reference} closed while waiting.`, matched: true };
      if (matched) {
        const what = call.text === undefined ? 'The command ended' : 'The text appeared';
        return { summary: `${what} in ${reference}.`, matched: true, output: await tail() };
      }
      if (this.ports.clock.now() >= deadline)
        return { summary: `Still waiting on ${reference}: the wait timed out.`, matched: false, output: await tail() };
    }
  }

  /** Whether the shell is back in the foreground — or the terminal itself is gone. */
  private async ended(sessionId: string, surface: ResolvedSurface): Promise<boolean | 'closed'> {
    try {
      return isShellForeground(await this.ports.terminals.foreground(sessionId, surface.id));
    } catch (error) {
      if (error instanceof TerminalMountError && error.code === 'not_found') return 'closed';
      throw error;
    }
  }

  private async listTerminals(sessionId: string): Promise<AgentToolResult> {
    const listing = await this.ports.terminals.list(sessionId);
    const surfaces: AgentSurface[] = listing.terminals.map(terminal => ({
      id: terminal.id,
      ...(terminal.name === undefined ? {} : { name: terminal.name }),
      title: terminal.title,
    }));
    return { summary: listed('terminal', surfaces), surfaces };
  }

  private async listPages(sessionId: string): Promise<AgentToolResult> {
    const status = await this.ports.browser.status(sessionId);
    const surfaces: AgentSurface[] = status.pages.map(page => ({
      id: page.id,
      ...(page.name === undefined ? {} : { name: page.name }),
      title: page.title,
      url: page.url,
    }));
    return { summary: listed('browser', surfaces), surfaces };
  }

  /** The surface a name or id addresses, looked up in this session's own listing and nowhere else. */
  private async resolve(sessionId: string, surface: SurfaceKind, key: string): Promise<ResolvedSurface> {
    const candidates: readonly { readonly id: string; readonly name?: string }[] =
      surface === 'terminal'
        ? (await this.ports.terminals.list(sessionId)).terminals
        : (await this.ports.browser.status(sessionId)).pages;
    const found = candidates.find(candidate => candidate.name === key || candidate.id === key);
    if (found === undefined) {
      const open = surface === 'terminal' ? 'terminal.open' : 'browser.open';
      throw new AgentToolError(
        'not_found',
        `There is no ${surfaceReference(surface, key)} in this session. List them with ${surface}.list, or open one with ${open}.`,
      );
    }
    return { surface, id: found.id, ...(found.name === undefined ? {} : { name: found.name }) };
  }

  private assertFree(sessionId: string, surface: ResolvedSurface): void {
    if (this.ports.control.takeoverOf(sessionId, surface) === undefined) return;
    throw new AgentToolError(
      'taken_over',
      `A person has taken over ${surfaceReference(surface.surface, surface.name ?? surface.id)}; wait or ask them.`,
    );
  }

  private async drove(caller: AgentToolCaller, call: AgentToolCall, surface: ResolvedSurface): Promise<void> {
    if (caller.kind !== 'agent' || !DRIVING_TOOLS.has(call.tool)) return;
    // The marker is a courtesy to the person watching; a journal that cannot take it must not fail an
    // act that already happened.
    await this.ports.control
      .drove(caller.sessionId, surface, caller.name === undefined ? {} : { name: caller.name })
      .catch(() => undefined);
  }

  /** One record per call: the tool and the surface by name, and lengths — never what was typed. */
  private async record(
    caller: AgentToolCaller,
    call: AgentToolCall,
    surface: ResolvedSurface | undefined,
    outcome: AuditOutcome,
  ): Promise<void> {
    const key = surface === undefined ? ('name' in call ? call.name : undefined) : (surface.name ?? surface.id);
    const detail: AuditDetail = {
      tool: call.tool,
      by: caller.kind,
      ...(key === undefined ? {} : { surface: surfaceReference(kindOf(call), key) }),
      ...callFacts(call),
    };
    await this.ports.audit.record({
      event: 'agent.tool',
      actor: caller.kind === 'agent' ? { kind: 'host' } : caller.actor,
      subject: caller.sessionId,
      outcome,
      detail,
    });
  }
}

/** The audit-safe facts about a call: how much, never what. */
function callFacts(call: AgentToolCall): AuditDetail {
  switch (call.tool) {
    case 'terminal.open':
      return { ...(call.folder === undefined ? {} : { folder: true }), command: call.command !== undefined };
    case 'terminal.send':
      return {
        ...(call.text === undefined ? {} : { textLength: call.text.length }),
        ...(call.keys === undefined ? {} : { keys: call.keys.length }),
      };
    case 'terminal.read':
      return { lines: call.lines ?? AGENT_TOOL_DEFAULT_READ_LINES };
    case 'terminal.wait':
      return {
        waitFor: call.text === undefined ? 'exit' : 'text',
        timeoutMs: call.timeoutMs ?? AGENT_TOOL_DEFAULT_WAIT_MS,
      };
    case 'browser.open':
      return call.url === undefined ? {} : { host: auditHost(call.url) };
    case 'browser.navigate':
      return { host: auditHost(call.url) };
    case 'browser.click':
      return { selector: auditSelector(call.selector) };
    case 'browser.type':
      return { selector: auditSelector(call.selector), textLength: call.text.length };
    case 'browser.read':
      return { mode: call.mode ?? 'text' };
    default:
      return {};
  }
}

function listed(surface: SurfaceKind, surfaces: readonly AgentSurface[]): string {
  const word = surface === 'terminal' ? 'terminal' : 'browser page';
  if (surfaces.length === 0) return `No ${word}s are open in this session.`;
  const names = surfaces.map(entry => surfaceReference(surface, entry.name ?? entry.id)).join(', ');
  return `${plural(surfaces.length, word)}: ${names}.`;
}

/**
 * The subsystems' own refusals, in this domain's words — or nothing, for a genuine defect, which
 * stays itself so it surfaces as the failure it is. A browser that could not start is the refusal an
 * agent most needs told plainly, with the fix.
 */
function translate(error: unknown): AgentToolError | undefined {
  if (error instanceof AgentToolError) return error;
  if (error instanceof TerminalMountError) return new AgentToolError(error.code, error.message);
  if (!(error instanceof BrowserSessionError)) return undefined;
  if (error.code === 'launch_failed') return new AgentToolError('unavailable', browserUnavailable(error.message));
  if (error.code === 'not_running')
    return new AgentToolError(
      'not_found',
      'The browser is not running in this session. Open a page with browser.open.',
    );
  return new AgentToolError(error.code, error.message);
}

/** One sentence: what is missing, and how to fix it. */
export function browserUnavailable(reason: string): string {
  const first = (reason.split('\n')[0] ?? '').trim().slice(0, 200);
  return `Browser tools could not start a browser on this machine (${first || 'no reason given'}): install Google Chrome or set FY_CHROME_BIN to a Chrome binary, make sure the fyd-browser-worker program is installed beside fyd, then try again.`;
}
