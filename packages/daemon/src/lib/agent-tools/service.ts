import {
  AGENT_TOOL_DEFAULT_READ_LINES,
  AGENT_TOOL_DEFAULT_WAIT_MS,
  type AgentSurface,
  type AgentToolCall,
  type AgentToolResult,
  type AuditDetail,
  type AuditOutcome,
  type BrowserActionResult,
  type InputAgentView,
  type SurfaceController,
  type SurfaceControlRequest,
  type SurfaceControlView,
  type SurfaceKind,
  type SurfaceOpener,
} from '@ferretry/protocol';
import type { AuditSink } from '../audit/types.ts';
import { type BrowserPageAction, BrowserSessionError, type BrowserSubsystem } from '../browser/runtime/index.ts';
import type { AgentControlPolicy } from '../fleet/agent-control.ts';
import { InputRequestError } from '../input-requests/errors.ts';
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
import type { AgentInputPort, AgentToolCaller, AgentToolClock, ResolvedSurface } from './types.ts';

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
  /** The owner's input requests; absent where none are wired, which refuses the two input tools. */
  readonly input?: AgentInputPort;
  /** Masks the values the daemon just typed out of any screen text handed to the agent. */
  readonly scrub?: (sessionId: string, text: string) => string;
  /**
   * When the quarantine on a terminal ends (epoch milliseconds), or nothing when it is not quarantined. `names` are
   * every way the terminal is known. An agent's read and wait are refused while it is quarantined.
   */
  readonly quarantinedUntil?: (sessionId: string, names: readonly (string | undefined)[]) => number | undefined;
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

/** The kind of surface a call is about; `input.wait` is about a request, not a surface. */
const kindOf = (call: AgentToolCall): SurfaceKind | undefined =>
  call.tool === 'input.wait' ? undefined : call.tool.startsWith('terminal.') ? 'terminal' : 'browser';

const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? '' : 's'}`;

/** Whether this agent opened the surface itself — the attestation the daemon recorded, never a claim. */
const openedByAgent = (openedBy: SurfaceOpener | undefined, sessionId: string): boolean =>
  openedBy?.by === 'agent' && openedBy.sessionId === sessionId;

/**
 * The agent tools: terminals and browser pages, driven by name.
 *
 * ONE PATH FOR EVERY CALLER, AND EVERY CHECK ON IT. An agent and a person reach the same method; what
 * differs is decided from the {@link AgentToolCaller} the route DERIVED, never from the call:
 *
 * 1. an agent is asked the machine's "What agents may control" switch for this kind first;
 * 2. the surface is looked up inside the caller's own session only — a name from another session
 *    is simply not there;
 * 3. an agent acts only on a surface IT opened, or one a person handed to it — a person's own shell
 *    or page is theirs unless they say otherwise;
 * 4. an agent is refused a surface a person has taken over — that one tab or terminal only; it keeps
 *    working everywhere else. For a page the check is repeated inside that page's own queue, so a
 *    takeover that lands while an act waits its turn still wins;
 * 5. the act is carried out, and an agent's act puts up the driving marker;
 * 6. one audit record names the tool, the surface and the outcome — with lengths, never the text.
 */
export class AgentToolService {
  constructor(private readonly ports: AgentToolPorts) {}

  async call(caller: AgentToolCaller, call: AgentToolCall): Promise<AgentToolResult> {
    const facts: { surface?: ResolvedSurface } = {};
    try {
      const kind = kindOf(call);
      if (caller.kind === 'agent' && kind !== undefined && !(await this.ports.policy.allows(kind)))
        throw new AgentToolError('forbidden', controlRefusal(kind));
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

  /**
   * Records a call that was refused before it could name a session — a missing or unknown credential,
   * or a body that is not a call — so credential guessing and stale credentials leave a trace.
   */
  async refusedCaller(reason: string): Promise<void> {
    await this.ports.audit.record({
      event: 'agent.tool',
      actor: { kind: 'host' },
      outcome: 'refused',
      detail: { by: 'agent', reason },
    });
  }

  /** Every live driving marker, standing takeover and hand-over of one kind in one session. */
  async controlView(sessionId: string, surface: SurfaceKind): Promise<SurfaceControlView> {
    return await this.alive(sessionId, surface, await this.ports.control.view(sessionId, surface));
  }

  /** A person takes a surface over from the agent, hands it back, or hands it to the agent. */
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
      else if (request.action === 'handback') await this.ports.control.handback(sessionId, surface);
      else await this.ports.control.hand(sessionId, surface, by);
      outcome = 'succeeded';
      return await this.controlView(sessionId, kind);
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
        return await this.listTerminals(caller);
      case 'browser.list':
        return await this.listPages(caller);
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
        await this.announce(caller, facts.surface, call.askOwner);
        return {
          summary: `Opened ${surfaceReference('terminal', call.name)}${call.command === undefined ? '' : ' and started the command'}${handedNote(call.askOwner)}.`,
        };
      }
      case 'browser.open': {
        const opener: SurfaceOpener | undefined =
          caller.kind === 'agent' ? { by: 'agent', sessionId } : caller.openedBy;
        const page = await this.ports.browser.openPage(sessionId, call.name, {
          ...(call.url === undefined ? {} : { url: call.url }),
          ...(opener === undefined ? {} : { openedBy: opener }),
          ...(call.incognito === true ? { incognito: true } : {}),
        });
        facts.surface = {
          surface: 'browser',
          id: page.id,
          name: call.name,
          ...(page.incognito ? { incognito: true } : {}),
        };
        await this.drove(caller, call, facts.surface);
        await this.announce(caller, facts.surface, call.askOwner);
        const kind = call.incognito === true ? 'an incognito page, ' : '';
        return {
          summary: `Opened ${kind}${surfaceReference('browser', call.name)} at ${page.url}${handedNote(call.askOwner)}.`,
        };
      }
      case 'input.wait': {
        const input = this.inputPort(caller);
        const view = await input.agentView(sessionId, call.id, call.timeoutMs ?? AGENT_TOOL_DEFAULT_WAIT_MS);
        return { summary: inputSummary(view), input: view };
      }
      default: {
        const surface = await this.resolve(
          sessionId,
          call.tool.startsWith('terminal.') ? 'terminal' : 'browser',
          call.name,
        );
        facts.surface = surface;
        if (caller.kind === 'agent') await this.assertAgentMay(sessionId, surface);
        const result = await this.act(caller, call, surface);
        await this.drove(caller, call, surface);
        return result;
      }
    }
  }

  /** The act itself, on a surface already resolved inside the caller's session and cleared for it. */
  private async act(
    caller: AgentToolCaller,
    call: Exclude<
      AgentToolCall,
      { readonly tool: 'terminal.list' | 'browser.list' | 'terminal.open' | 'browser.open' | 'input.wait' }
    >,
    surface: ResolvedSurface,
  ): Promise<AgentToolResult> {
    const { sessionId } = caller;
    const reference = surfaceReference(surface.surface, surface.name ?? surface.id);
    switch (call.tool) {
      case 'terminal.send':
        // The check and the keystrokes are one turn in the session: a request cannot be raised on this
        // pane between them, and the secure write cannot land in the middle of them.
        return await this.exclusively(sessionId, async () => {
          const pending = this.ports.input?.pendingOn(sessionId, { kind: 'terminal', key: surface.name ?? surface.id });
          if (pending !== undefined)
            throw new AgentToolError(
              'conflict',
              `an input request is pending on ${reference}; wait for !${pending} (input.wait) and do not type there yourself`,
            );
          await this.ports.terminals.write(sessionId, surface.id, terminalInput(call.text, call.keys));
          const parts = [
            ...(call.text === undefined ? [] : [plural(call.text.length, 'character')]),
            ...(call.keys === undefined ? [] : [plural(call.keys.length, 'key')]),
          ];
          return { summary: `Sent ${parts.join(' and ')} to ${reference}.` };
        });
      case 'terminal.read': {
        this.assertReadable(caller, surface, reference);
        const lines = call.lines ?? AGENT_TOOL_DEFAULT_READ_LINES;
        const output = clipOutput(
          this.scrubbed(sessionId, await this.ports.terminals.text(sessionId, surface.id, lines)),
        );
        return { summary: `The last ${plural(lines, 'line')} of ${reference}.`, output };
      }
      case 'terminal.wait':
        return await this.wait(caller, call, surface, reference);
      case 'terminal.request_input': {
        if (caller.kind !== 'agent')
          throw new AgentToolError(
            'bad_request',
            'Only an agent asks its owner for a value; you already have the terminal.',
          );
        const view = await this.inputPort(caller).raise(sessionId, {
          target: { kind: 'terminal', key: surface.name ?? surface.id },
          prompt: call.prompt,
          sensitivity: call.sensitivity,
          submit: call.submit ?? 'offer-owner',
          ...(call.expiresInSeconds === undefined ? {} : { expiresInSeconds: call.expiresInSeconds }),
          ...(call.blocking === undefined ? {} : { blocking: call.blocking }),
          ...(call.chain === undefined ? {} : { chain: call.chain }),
        });
        return {
          summary: `Asked the owner for the value (!${view.id}) for ${reference}. Wait with input.wait; do not type there yourself.`,
          input: view,
        };
      }
      case 'terminal.ask_owner':
      case 'browser.ask_owner':
        if (caller.kind !== 'agent')
          throw new AgentToolError('bad_request', 'Only an agent hands a surface to its owner; you already have it.');
        await this.announce(caller, surface, call.message ?? true, true);
        return {
          summary: `Asked the owner to take over ${reference}${call.message === undefined ? '' : ' and told them what to do'}. Wait for them: read the surface to see when they are done.`,
        };
      case 'terminal.close':
        return await this.exclusively(sessionId, async () => {
          await this.ports.terminals.close(sessionId, surface.id);
          this.ports.control.forget(sessionId, surface);
          return { summary: `Closed ${reference}.` };
        });
      case 'browser.close':
        await this.ports.browser.closePage(sessionId, surface.id, this.browserGuard(caller, surface));
        this.ports.control.forget(sessionId, surface);
        return { summary: `Closed ${reference}.` };
      default:
        return await this.browse(caller, call, surface, reference);
    }
  }

  private async browse(
    caller: AgentToolCaller,
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
    const answer: BrowserActionResult = await this.ports.browser.actOnPage(
      caller.sessionId,
      surface.id,
      action,
      this.browserGuard(caller, surface),
    );
    const page: { readonly url?: string; readonly text?: unknown; readonly screenshotBase64?: unknown } =
      'result' in answer ? answer.result : {};
    const at = page.url === undefined ? '' : ` (now at ${page.url})`;
    const check = humanCheckNote(answer, surface.id);
    if (typeof page.text === 'string')
      return {
        summary: `Read ${reference}${at}.${check}`,
        output: clipOutput(this.scrubbed(caller.sessionId, page.text)),
      };
    if (typeof page.screenshotBase64 === 'string')
      return { summary: `A screenshot of ${reference}${at}.${check}`, screenshotBase64: page.screenshotBase64 };
    return { summary: `Done on ${reference}${at}.${check}` };
  }

  /**
   * The check the browser runs INSIDE the page's own queue, right before an agent's act: a takeover
   * that landed while the act was waiting its turn still refuses it.
   */
  private browserGuard(caller: AgentToolCaller, surface: ResolvedSurface): (() => Promise<void>) | undefined {
    return caller.kind === 'agent' ? async () => await this.assertFree(caller.sessionId, surface) : undefined;
  }

  /**
   * Waits, inside one bounded request, for text to appear or for the running command to end.
   *
   * THE FIRST LOOK IS ONE POLL INTERVAL LATER, not immediately: a wait for `exit` sent straight after
   * a command would otherwise look before the shell has even started it, find the shell in the
   * foreground, and report a command that never ran as finished. An agent's wait also stops the moment
   * a person takes the terminal over.
   */
  private async wait(
    caller: AgentToolCaller,
    call: Extract<AgentToolCall, { readonly tool: 'terminal.wait' }>,
    surface: ResolvedSurface,
    reference: string,
  ): Promise<AgentToolResult> {
    const { sessionId } = caller;
    this.assertReadable(caller, surface, reference);
    const deadline = this.ports.clock.now() + (call.timeoutMs ?? AGENT_TOOL_DEFAULT_WAIT_MS);
    const tail = async (): Promise<string> =>
      clipOutput(this.scrubbed(sessionId, await this.ports.terminals.text(sessionId, surface.id, WAIT_TAIL_LINES)));
    for (;;) {
      await this.ports.sleep(AGENT_TOOL_POLL_MS);
      if (caller.kind === 'agent') await this.assertFree(sessionId, surface);
      this.assertReadable(caller, surface, reference);
      // The predicate sees what the agent may see: a value the daemon just typed is masked BEFORE the match,
      // so neither "matched" nor "not matched" can tell the agent whether a guess is in the hidden text.
      const matched =
        call.text === undefined
          ? await this.ended(sessionId, surface)
          : this.scrubbed(
              sessionId,
              await this.ports.terminals.text(sessionId, surface.id, WAIT_SEARCH_LINES),
            ).includes(call.text);
      if (matched === 'closed') return { summary: `${reference} closed while waiting.`, matched: true };
      if (matched) {
        const what = call.text === undefined ? 'The command ended' : 'The text appeared';
        return { summary: `${what} in ${reference}.`, matched: true, output: await tail() };
      }
      if (this.ports.clock.now() >= deadline)
        return { summary: `Still waiting on ${reference}: the wait timed out.`, matched: false, output: await tail() };
    }
  }

  /**
   * An agent does not read a terminal the daemon just typed a secret into: masking can only hide a value it can
   * recognise, so the terminal is closed to the agent's eyes until the window ends. Typing stays allowed.
   */
  private assertReadable(caller: AgentToolCaller, surface: ResolvedSurface, reference: string): void {
    if (caller.kind !== 'agent') return;
    const until = this.ports.quarantinedUntil?.(caller.sessionId, [surface.name, surface.id]);
    if (until === undefined) return;
    throw new AgentToolError(
      'conflict',
      `${reference} is quarantined until ${new Date(until).toISOString()}: the owner's secret was just typed there, so you cannot read it for a short while. You can still send keys. Try again after that time, or ask the owner.`,
    );
  }

  /** Runs `work` as one turn in the session when input requests are wired; just runs it where they are not. */
  private async exclusively<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    return this.ports.input === undefined ? await work() : await this.ports.input.exclusive(sessionId, work);
  }

  /** Screen text with the values the daemon just typed masked; text unchanged where no mask is wired. */
  private scrubbed(sessionId: string, text: string): string {
    return this.ports.scrub === undefined ? text : this.ports.scrub(sessionId, text);
  }

  private inputPort(caller: AgentToolCaller): AgentInputPort {
    if (caller.kind !== 'agent')
      throw new AgentToolError('bad_request', 'Only an agent raises or waits on an input request.');
    if (this.ports.input === undefined)
      throw new AgentToolError('unavailable', 'Input requests are not available on this machine.');
    return this.ports.input;
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

  private async listTerminals(caller: AgentToolCaller): Promise<AgentToolResult> {
    const listing = await this.ports.terminals.list(caller.sessionId);
    const surfaces = await Promise.all(
      listing.terminals.map(async terminal =>
        this.listed(caller, {
          surface: 'terminal',
          id: terminal.id,
          title: terminal.title,
          ...(terminal.name === undefined ? {} : { name: terminal.name }),
          ...(terminal.openedBy === undefined ? {} : { openedBy: terminal.openedBy }),
        }),
      ),
    );
    return shown('terminal', surfaces);
  }

  private async listPages(caller: AgentToolCaller): Promise<AgentToolResult> {
    const status = await this.ports.browser.status(caller.sessionId);
    const surfaces = await Promise.all(
      status.pages.map(async page =>
        this.listed(caller, {
          surface: 'browser',
          id: page.id,
          title: page.title,
          url: page.url,
          ...(page.name === undefined ? {} : { name: page.name }),
          ...(page.openedBy === undefined ? {} : { openedBy: page.openedBy }),
          ...(page.incognito === true ? { incognito: true } : {}),
        }),
      ),
    );
    return shown('browser', surfaces);
  }

  /**
   * One row of a listing — or nothing, for a surface an agent may not use. An agent sees its own
   * surfaces and the ones handed to it, and never so much as the name, title or URL of a person's.
   */
  private async listed(
    caller: AgentToolCaller,
    row: ResolvedSurface & { readonly title: string; readonly url?: string },
  ): Promise<AgentSurface | undefined> {
    const base: AgentSurface = {
      id: row.id,
      ...(row.name === undefined ? {} : { name: row.name }),
      title: row.title,
      ...(row.incognito === true ? { incognito: true } : {}),
      ...(row.url === undefined ? {} : { url: row.url }),
    };
    if (caller.kind !== 'agent') return base;
    const available = await this.assertAgentMay(caller.sessionId, row).then(
      () => true,
      () => false,
    );
    return available ? { ...base, available } : undefined;
  }

  /** The surface a name or id addresses, looked up in this session's own listing and nowhere else. */
  private async resolve(sessionId: string, surface: SurfaceKind, key: string): Promise<ResolvedSurface> {
    const candidates: readonly {
      readonly id: string;
      readonly name?: string;
      readonly openedBy?: SurfaceOpener;
      readonly incognito?: true;
    }[] =
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
    return {
      surface,
      id: found.id,
      ...(found.name === undefined ? {} : { name: found.name }),
      ...(found.openedBy === undefined ? {} : { openedBy: found.openedBy }),
      ...(found.incognito === true ? { incognito: true } : {}),
    };
  }

  /** Whether an agent may act on this surface now: it is the agent's, and nobody is holding it. */
  private async assertAgentMay(sessionId: string, surface: ResolvedSurface): Promise<void> {
    if (!openedByAgent(surface.openedBy, sessionId) && !(await this.ports.control.isHanded(sessionId, surface)))
      throw new AgentToolError(
        'forbidden',
        `${surfaceReference(surface.surface, surface.name ?? surface.id)} is a person's, not yours: you may use it only if they hand it to you. Ask them, or open your own.`,
      );
    await this.assertFree(sessionId, surface);
  }

  /** Whether a person holds THIS surface. Holding one tab or terminal holds nothing else. */
  private async assertFree(sessionId: string, surface: ResolvedSurface): Promise<void> {
    const takeover = await this.ports.control.takeoverOf(sessionId, surface);
    if (takeover === undefined) return;
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

  /**
   * Tells the owner's workspace about a surface the AGENT opened (a tab appears) and, when it asked for
   * them, hands it over ("your turn here"). Like the driving marker it is a courtesy to a person
   * watching: a journal that cannot take it must not fail an act that already happened — except an
   * explicit ask, whose failure the agent must hear about, since the owner would never be told.
   */
  private async announce(
    caller: AgentToolCaller,
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

  /** What is still alive: a close is not journaled, so a gone surface must not keep a tab or an ask. */
  private async alive(sessionId: string, kind: SurfaceKind, view: SurfaceControlView): Promise<SurfaceControlView> {
    if (view.opened.length === 0 && view.asked.length === 0) return view;
    const live = new Set(
      (kind === 'terminal'
        ? (await this.ports.terminals.list(sessionId)).terminals
        : (await this.ports.browser.status(sessionId)).pages
      ).map(row => row.id),
    );
    return {
      ...view,
      opened: view.opened.filter(entry => live.has(entry.id)),
      asked: view.asked.filter(entry => live.has(entry.id)),
    };
  }

  /** One record per call: the tool and the surface by name, and lengths — never what was typed. */
  private async record(
    caller: AgentToolCaller,
    call: AgentToolCall,
    surface: ResolvedSurface | undefined,
    outcome: AuditOutcome,
  ): Promise<void> {
    const key = surface === undefined ? ('name' in call ? call.name : undefined) : (surface.name ?? surface.id);
    const kind = kindOf(call);
    const detail: AuditDetail = {
      tool: call.tool,
      by: caller.kind,
      ...(key === undefined || kind === undefined ? {} : { surface: surfaceReference(kind, key) }),
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
      return {
        ...(call.folder === undefined ? {} : { folder: true }),
        command: call.command !== undefined,
        ...(call.askOwner === undefined ? {} : { askOwner: true }),
      };
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
      return {
        ...(call.url === undefined ? {} : { host: auditHost(call.url) }),
        ...(call.incognito === true ? { incognito: true } : {}),
        ...(call.askOwner === undefined ? {} : { askOwner: true }),
      };
    case 'terminal.ask_owner':
    case 'browser.ask_owner':
      return { message: call.message !== undefined };
    case 'browser.navigate':
      return { host: auditHost(call.url) };
    case 'browser.click':
      return { selector: auditSelector(call.selector) };
    case 'browser.type':
      return { selector: auditSelector(call.selector), textLength: call.text.length };
    case 'browser.read':
      return { mode: call.mode ?? 'text' };
    case 'terminal.request_input':
      return { sensitivity: call.sensitivity };
    case 'input.wait':
      return { timeoutMs: call.timeoutMs ?? AGENT_TOOL_DEFAULT_WAIT_MS };
    default:
      return {};
  }
}

/** Where an input request stands, in one sentence an agent can act on. */
function inputSummary(view: InputAgentView): string {
  const card = `!${view.id}`;
  switch (view.state) {
    case 'pending':
      return `${card} is still waiting for the owner. Wait again with input.wait; do not type there yourself.`;
    case 'delivering':
      return `${card}: the owner's value is being typed now. Wait again with input.wait.`;
    case 'delivered':
      return `${card}: the owner typed the value${view.submitted === true ? ' and pressed Enter' : ''}. Read the terminal to see what happened.`;
    case 'refused':
      return `${card} was refused${view.reason === undefined ? '' : ` (${view.reason})`}: the value was not typed. Look at the terminal, then raise a new request if it is still needed.`;
    case 'expired':
      return `${card} expired without an answer.`;
    case 'cancelled':
      return `${card} was cancelled${view.reason === undefined ? '' : ` (${view.reason})`}.`;
  }
}

const handedNote = (askOwner: true | string | undefined): string =>
  askOwner === undefined ? '' : ' and asked the owner to take over (wait for them)';

/** A listing's result: the rows the caller may see, and a sentence naming them. */
function shown(surface: SurfaceKind, rows: readonly (AgentSurface | undefined)[]): AgentToolResult {
  const surfaces = rows.filter((row): row is AgentSurface => row !== undefined);
  const word = surface === 'terminal' ? 'terminal' : 'browser page';
  if (surfaces.length === 0) return { summary: `No ${word}s are open for you in this session.`, surfaces };
  const names = surfaces.map(entry => surfaceReference(surface, entry.name ?? entry.id)).join(', ');
  return { summary: `${plural(surfaces.length, word)}: ${names}.`, surfaces };
}

/**
 * The subsystems' own refusals, in this domain's words — or nothing, for a genuine defect, which
 * stays itself so it surfaces as the failure it is. A browser that could not start is the refusal an
 * agent most needs told plainly, with the fix.
 */
function translate(error: unknown): AgentToolError | undefined {
  if (error instanceof AgentToolError) return error;
  if (error instanceof InputRequestError)
    return new AgentToolError(error.code === 'gone' ? 'not_found' : error.code, error.message);
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

/**
 * What an agent is told when the page it just acted on appears to be asking for a human check
 * (docs/browser-mode.md): that it is one, and that the owner solves it — never the agent. Empty otherwise.
 */
function humanCheckNote(answer: BrowserActionResult, pageId: string): string {
  if (!('result' in answer)) return '';
  const page = answer.result.pages.find(candidate => candidate.id === (answer.result.actedPageId ?? pageId));
  if (page?.challenge === undefined) return '';
  return ' The page appears to be showing a human check (a captcha or a "checking your browser" page). Do not try to solve or get around it: ask your owner to take the page over in Ferretry and solve it themselves, then carry on.';
}
