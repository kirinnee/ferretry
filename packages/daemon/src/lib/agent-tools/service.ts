import {
  AGENT_TOOL_DEFAULT_READ_LINES,
  AGENT_TOOL_DEFAULT_WAIT_MS,
  type AgendaId,
  type AgentSurface,
  type AgentToolCall,
  type AgentToolResult,
  type AuditDetail,
  type AuditOutcome,
  BROWSER_WAIT_DEFAULT_MS,
  BROWSER_WAIT_SLICE_MS,
  type BrowserActionResult,
  type BrowserDialogInfo,
  type BrowserDownloadNotice,
  type BrowserElementTarget,
  type BrowserEmulation,
  type BrowserPageLifecycleRequest,
  type BrowserTargetFields,
  type BrowserWaitCondition,
  browserReadModeOf,
  browserTargetOf,
  COPY_HANDLE_PREFIX,
  type CopyMeta,
  copyHandle,
  INPUT_SINGLE_FIELD_ID,
  type InputAgentView,
  type SurfaceController,
  type SurfaceControlRequest,
  type SurfaceControlView,
  type SurfaceKind,
  type SurfaceOpener,
  strongestSensitivity,
} from '@ferretry/protocol';
import { AGENT_FILE_LIMITS, AgentFileError, type AgentFiles, extensionOf, sizeWords } from '../agent-files/index.ts';
import type { AuditSink } from '../audit/types.ts';
import {
  type BrowserActGuard,
  type BrowserFileAction,
  type BrowserLifecycleOutcome,
  type BrowserPageAction,
  BrowserSessionError,
  type BrowserSubsystem,
  pendingDialogOf,
} from '../browser/runtime/index.ts';
import { BrowserTransportError } from '../browser/transport/worker-protocol.ts';
import type { AgentControlPolicy } from '../fleet/agent-control.ts';
import { InputRequestError } from '../input-requests/errors.ts';
import { TerminalMountError, type TerminalSubsystem } from '../runtime/mounts/terminals.ts';
import type { TextRedactor } from '../secrets/redaction.ts';
import { SecureCopyError } from '../secure-copy/errors.ts';
import type { SurfaceControl } from './control.ts';
import {
  auditHost,
  auditSelector,
  clipOutput,
  clipReading,
  controlRefusal,
  isShellForeground,
  pageScriptsRefusal,
  surfaceReference,
  terminalInput,
} from './policy.ts';
import type {
  AgentCopyPort,
  AgentInputPort,
  AgentPlanPort,
  AgentToolCaller,
  AgentToolClock,
  ResolvedSurface,
} from './types.ts';

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

/** What a result that carries pane-derived text was read from. */
interface PaneBinding {
  readonly caller: AgentToolCaller;
  readonly surface: ResolvedSurface;
  readonly reference: string;
}

/** How often a wait looks again. */
export const AGENT_TOOL_POLL_MS = 250;
/** How many recent lines a wait for text searches, and how many it hands back. */
const WAIT_SEARCH_LINES = 500;
const WAIT_TAIL_LINES = 40;

export interface AgentToolPorts {
  readonly terminals: Pick<TerminalSubsystem, 'list' | 'create' | 'write' | 'text' | 'foreground' | 'close'>;
  readonly browser: Pick<
    BrowserSubsystem,
    'status' | 'openPage' | 'actOnPage' | 'filesOnPage' | 'scriptOnPage' | 'closePage' | 'lifecycleOnPage' | 'adoptPage'
  >;
  /** What the file tools may reach: the session's own folder and its attachments, nothing else. */
  readonly files: Pick<AgentFiles, 'prepareUpload' | 'save'>;
  readonly control: SurfaceControl;
  readonly policy: AgentControlPolicy;
  readonly audit: AuditSink;
  /**
   * Masks every secret the vault holds in what a PAGE hands back — its text, its snapshot, the address it
   * is at — before an agent or a person reads it, as the operator's screen and transcript reads are. A
   * page can show a secret the agent never typed (a dashboard's API key); the agent's context and its
   * harness transcript must not keep it. Fails closed: a vault that cannot be opened withholds the text.
   */
  readonly redactor: Pick<TextRedactor, 'batch'>;
  /** The command-line client's name, for a refusal that tells the owner the command to type. */
  readonly binaryName: string;
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
  /** Secure copies (docs/secure-copy.md); absent where none are wired, which refuses the `secure.*` tools. */
  readonly copy?: AgentCopyPort;
  /** A ferret's paste plans, for `secure.preapprove`; absent where none are wired. */
  readonly plans?: AgentPlanPort;
}

/** Page tools that hand back a PICTURE of a page: no mask can be drawn on pixels, so a hold refuses them to its end. */
const PAGE_PICTURES: ReadonlySet<string> = new Set(['browser.screenshot', 'browser.pdf', 'browser.highlight']);
/** Page tools that hand back what a page SAYS: masked always, and refused during a hold until the page moves on. */
const PAGE_TEXT: ReadonlySet<string> = new Set([
  'browser.read',
  'browser.eval',
  'browser.console',
  'browser.network',
  'browser.wait_for',
]);
/** Page tools that put text into a page (a script can too): refused while the owner is being asked for a value on it. */
const PAGE_TYPING: ReadonlySet<string> = new Set([
  'browser.type',
  'browser.fill_form',
  'browser.press',
  'browser.eval',
]);

/** The tools that change what a person would see, and so put up the driving marker. */
const DRIVING_TOOLS: ReadonlySet<AgentToolCall['tool']> = new Set([
  'browser.eval',
  'terminal.open',
  'terminal.send',
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
const FILE_TOOLS: ReadonlySet<AgentToolCall['tool']> = new Set(['browser.upload', 'browser.download', 'browser.pdf']);

/** A page's text as it came back, before redaction: what was read, where the page is now, what its dialog says, and the names its downloads suggested. */
interface PageReading {
  readonly url?: string;
  readonly text?: string;
  readonly dialog?: string;
  /** File names a page suggested for its downloads. */
  readonly names?: readonly string[];
}

/** What a call learned that the audit should keep, beside what the call itself said. */
interface CallFacts {
  surface?: ResolvedSurface;
  pane?: ResolvedSurface;
  detail?: AuditDetail;
}

type PageRows = Awaited<ReturnType<AgentToolPorts['browser']['status']>>['pages'];

/** The tools that read or change a page's life — a dialog, a wait, its logs, its device. */
type LifecycleCall = Extract<
  AgentToolCall,
  {
    readonly tool: 'browser.dialog' | 'browser.wait_for' | 'browser.console' | 'browser.network' | 'browser.emulate';
  }
>;

/** How far up a popup's opener chain ownership is followed. */
const MAX_OPENER_DEPTH = 8;

/** The kind of surface a call is about; `input.wait` is about a request and `secure.*` about a copy, not a surface. */
const kindOf = (call: AgentToolCall): SurfaceKind | undefined =>
  call.tool === 'input.wait' || call.tool.startsWith('secure.')
    ? undefined
    : call.tool.startsWith('terminal.')
      ? 'terminal'
      : 'browser';

/**
 * Which "What agents may control" switch a call needs: its surface's, and for a secure copy the switch of what it
 * reads — running a command is terminal control, reading a page is browser control.
 */
const switchOf = (call: AgentToolCall): SurfaceKind | undefined =>
  call.tool === 'secure.copy'
    ? call.source.kind === 'command'
      ? 'terminal'
      : 'browser'
    : call.tool === 'secure.paste'
      ? 'terminal'
      : kindOf(call);

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

  /** The pane each pane-derived result was read from, so the transport can ask once more at the last moment. */
  private readonly bindings = new WeakMap<AgentToolResult, PaneBinding>();

  async call(caller: AgentToolCaller, call: AgentToolCall): Promise<AgentToolResult> {
    const facts: CallFacts = {};
    let result: AgentToolResult;
    try {
      const kind = switchOf(call);
      if (caller.kind === 'agent' && kind !== undefined && !(await this.ports.policy.allows(kind)))
        throw new AgentToolError('forbidden', controlRefusal(kind));
      if (caller.kind === 'agent' && FILE_TOOLS.has(call.tool) && !(await this.ports.policy.allows('files')))
        throw new AgentToolError('forbidden', controlRefusal('files'));
      // Page scripts are the owner's to allow for EVERY caller: a paired device with the browser grant
      // must not read the shared profile's sign-ins through a script while the owner has them off.
      if (call.tool === 'browser.eval' && !(await this.ports.policy.allows('scripts')))
        throw new AgentToolError('forbidden', pageScriptsRefusal(this.ports.binaryName));
      result = await this.dispatch(caller, call, facts);
      await this.record(caller, call, facts, 'succeeded');
    } catch (error) {
      const refusal = await this.heldOrMasked(caller, call.tool, facts.surface, translate(error) ?? error);
      const failed = !(refusal instanceof AgentToolError) || refusal.code === 'upstream_failed';
      await this.record(caller, call, facts, failed ? 'failed' : 'refused');
      throw refusal;
    }
    const pane = facts.pane ?? facts.surface;
    if (pane === undefined || (result.output === undefined && result.input?.observed === undefined)) return result;
    this.bindings.set(result, {
      caller,
      surface: pane,
      reference: surfaceReference(pane.surface, pane.name ?? pane.id),
    });
    return this.publish(result);
  }

  /**
   * The last step before anything leaves the daemon: a hold that began during the capture, the redaction or the
   * audit record is honoured here, synchronously. Screen text is refused; the foreground facts of a nested input
   * view are dropped. A transport calls it again right before it serialises, so a hold taken after the service
   * answered still wins; a result that read no pane passes through.
   */
  publish(result: AgentToolResult): AgentToolResult {
    const bound = this.bindings.get(result);
    if (bound === undefined) return result;
    if (result.output !== undefined) this.assertReadable(bound.caller, bound.surface, bound.reference);
    if (result.input?.observed === undefined) return result;
    if (this.ports.quarantinedUntil?.(bound.caller.sessionId, [bound.surface.name, bound.surface.id]) === undefined)
      return result;
    const { observed: _hidden, ...input } = result.input;
    return { ...result, input };
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

  private async dispatch(caller: AgentToolCaller, call: AgentToolCall, facts: CallFacts): Promise<AgentToolResult> {
    const { sessionId } = caller;
    switch (call.tool) {
      case 'terminal.list':
        return await this.listTerminals(caller);
      case 'browser.list':
        return await this.listPages(caller);
      case 'browser.tabs':
        return await this.tabs(caller, call, facts);
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
      case 'secure.copy': {
        if (caller.kind !== 'agent')
          throw new AgentToolError('bad_request', 'Only an agent seals a value; you can read it yourself.');
        const captured = await this.copyPort().capture(sessionId, {
          name: call.name,
          source: call.source,
          ...(call.expiresInSeconds === undefined ? {} : { expiresInSeconds: call.expiresInSeconds }),
        });
        // The program a command copy ran, by base name: it ran outside any terminal, so the audit is where it shows.
        facts.detail = {
          copyLength: captured.copy.length,
          transcript: captured.copy.exposure.transcript,
          ...(captured.copy.from.program === undefined ? {} : { program: captured.copy.from.program }),
        };
        return {
          summary: copiedSummary(captured.copy),
          copies: [captured.copy],
          ...(captured.command === undefined ? {} : { command: captured.command }),
        };
      }
      case 'secure.list': {
        const copies = this.copyPort().list(sessionId);
        return {
          summary:
            copies.length === 0
              ? 'This session holds no copies.'
              : liveCopies(copies.filter(copy => copy.state === 'live').length),
          copies: [...copies],
        };
      }
      case 'secure.discard': {
        const copy = this.copyPort().discard(sessionId, bareCopyName(call.handle));
        return { summary: `${copy.handle} is ${copy.state}: its value is gone from the daemon.`, copies: [copy] };
      }
      case 'secure.paste': {
        if (caller.kind !== 'agent')
          throw new AgentToolError(
            'bad_request',
            'Only an agent pastes a secure copy; the owner allows it on the card.',
          );
        const name = bareCopyName(call.handle);
        if (call.to.kind === 'secret') return await this.pasteToStore(sessionId, caller, call, call.to.name, name);
        const surface = await this.resolve(sessionId, 'terminal', call.to.name);
        facts.surface = surface;
        await this.assertAgentMay(sessionId, surface);
        const reference = surfaceReference('terminal', surface.name ?? surface.id);
        const view = await this.inputPort(caller).raise(sessionId, {
          target: { kind: 'terminal', key: surface.name ?? surface.id },
          prompt: call.prompt,
          sensitivity: 'secret',
          submit: call.submit ?? 'offer-owner',
          source: { kind: 'sealed', name },
          ...(call.expiresInSeconds === undefined ? {} : { expiresInSeconds: call.expiresInSeconds }),
        });
        return {
          summary:
            view.state === 'delivered'
              ? `Pasted ${copyHandle(name)} into ${reference} under a rule the owner approved in advance (!${view.id}). The terminal is unreadable for about two minutes.`
              : `Asked the owner to allow pasting ${copyHandle(name)} into ${reference} (!${view.id}). Wait with input.wait; do not type there yourself.`,
          input: view,
        };
      }
      case 'secure.preapprove': {
        if (caller.kind !== 'agent')
          throw new AgentToolError('bad_request', 'Only an agent asks for pastes to be approved in advance.');
        if (this.ports.plans === undefined)
          throw new AgentToolError('unavailable', 'Secure copy is not available on this daemon.');
        const plan = await this.ports.plans.propose(sessionId, call.items, call.expiresInSeconds);
        return {
          summary: `Asked the owner to approve ${plural(plan.items.length, 'paste')} in advance (!${plan.agendaItemId}). Until they answer, each paste asks them.`,
          plan,
        };
      }
      case 'input.wait': {
        const input = this.inputPort(caller);
        const view = await input.agentView(sessionId, call.id, call.timeoutMs ?? AGENT_TOOL_DEFAULT_WAIT_MS);
        if (view.observed === undefined) return { summary: inputSummary(view), input: view };
        facts.pane = await this.paneOf(input, sessionId, call.id);
        if (facts.pane !== undefined) return { summary: inputSummary(view), input: view };
        const { observed: _unbound, ...unbound } = view;
        return { summary: inputSummary(view), input: unbound };
      }
      default: {
        const surface = await this.resolve(
          sessionId,
          call.tool.startsWith('terminal.') ? 'terminal' : 'browser',
          call.name,
        );
        facts.surface = surface;
        if (caller.kind === 'agent') await this.assertAgentMay(sessionId, surface);
        if (surface.surface === 'browser') await this.guardPage(caller, call.tool, surface);
        const result = await this.act(caller, call, surface, facts);
        // A hold that began while the page was being read wins: what the read saw may hold the value.
        if (surface.surface === 'browser') await this.assertPageReadable(caller, call.tool, surface);
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
      {
        readonly tool:
          | 'terminal.list'
          | 'browser.list'
          | 'browser.tabs'
          | 'terminal.open'
          | 'browser.open'
          | 'input.wait'
          | 'secure.copy'
          | 'secure.list'
          | 'secure.discard'
          | 'secure.paste'
          | 'secure.preapprove';
      }
    >,
    surface: ResolvedSurface,
    facts: CallFacts,
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
        const output = clipOutput(await this.readText(caller, surface, reference, lines));
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
          ...(call.label === undefined
            ? { sensitivity: call.sensitivity }
            : { fields: [{ id: INPUT_SINGLE_FIELD_ID, label: call.label, sensitivity: call.sensitivity }] }),
          ...raiseOptions(call),
        });
        return {
          summary: `Asked the owner for the value (!${view.id}) for ${reference}. Wait with input.wait; do not type there yourself.`,
          input: view,
        };
      }
      case 'browser.request_input': {
        if (caller.kind !== 'agent')
          throw new AgentToolError(
            'bad_request',
            'Only an agent asks its owner for values; you already have the page.',
          );
        const view = await this.inputPort(caller).raise(sessionId, {
          target: { kind: 'browser', key: surface.name ?? surface.id },
          prompt: call.prompt,
          fields: call.fields.map(field => ({
            id: field.id,
            ...(field.label === undefined ? {} : { label: field.label }),
            sensitivity: field.sensitivity,
            element:
              field.ref === undefined
                ? { kind: 'selector' as const, selector: field.selector ?? '' }
                : { kind: 'ref' as const, ref: field.ref },
          })),
          ...raiseOptions(call),
        });
        return {
          summary: `Asked the owner for ${plural(call.fields.length, 'value')} (!${view.id}) for ${reference}. Wait with input.wait; do not type into those fields yourself.`,
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
      case 'browser.dialog':
      case 'browser.wait_for':
      case 'browser.console':
      case 'browser.network':
      case 'browser.emulate':
        return await this.lifecycle(caller, call, surface, reference, facts);
      case 'browser.upload':
      case 'browser.download':
      case 'browser.pdf':
        return await this.files(caller, call, surface, reference, facts);
      case 'browser.eval':
        return await this.script(caller, call, surface, reference, facts);
      default:
        return await this.browse(caller, call, surface, reference, facts);
    }
  }

  /** `browser.tabs`: the session's pages with their popups, or take on a popup under a name. */
  private async tabs(
    caller: AgentToolCaller,
    call: Extract<AgentToolCall, { readonly tool: 'browser.tabs' }>,
    facts: CallFacts,
  ): Promise<AgentToolResult> {
    if (call.action === 'list') return await this.listPages(caller, true);
    const { sessionId } = caller;
    const surface = await this.resolve(sessionId, 'browser', call.id ?? '');
    facts.surface = surface;
    if (caller.kind === 'agent') await this.assertAgentMay(sessionId, surface);
    const reference = surfaceReference('browser', surface.name ?? surface.id);
    if (surface.openerId === undefined)
      throw new AgentToolError(
        'bad_request',
        `${reference} is not a popup: only a page another page opened can be adopted.`,
      );
    if (surface.name !== undefined) throw new AgentToolError('conflict', `${reference} already has a name; use it.`);
    const name = call.as ?? '';
    const opener: SurfaceOpener | undefined = caller.kind === 'agent' ? { by: 'agent', sessionId } : caller.openedBy;
    await this.ports.browser.adoptPage(sessionId, surface.id, name, opener);
    facts.surface = { ...surface, name, ...(opener === undefined ? {} : { openedBy: opener }) };
    await this.announce(caller, facts.surface, undefined);
    return {
      summary: `Adopted the popup ${surface.id} (opened by ${surface.openerId}) as ${surfaceReference('browser', name)}. Use it by that name.`,
    };
  }

  /** The page-lifecycle tools, each as one call to the page's lifecycle port. */
  private async lifecycle(
    caller: AgentToolCaller,
    call: LifecycleCall,
    surface: ResolvedSurface,
    reference: string,
    facts: CallFacts,
  ): Promise<AgentToolResult> {
    const guard = this.browserGuard(caller, surface, call.tool);
    const send = async (request: BrowserPageLifecycleRequest): Promise<BrowserLifecycleOutcome> =>
      await this.ports.browser.lifecycleOnPage(caller.sessionId, surface.id, request, guard);
    switch (call.tool) {
      case 'browser.dialog': {
        const out = await send({
          op: 'dialog',
          action: call.action,
          ...(call.promptText === undefined ? {} : { promptText: call.promptText }),
        });
        if (out.reply.dialogType !== undefined)
          facts.detail = { dialogType: out.reply.dialogType, accepted: call.action === 'accept' };
        const read = await this.scrubbed({ text: out.reply.text, ...dialogOf(out.dialog) });
        return { summary: `On ${reference}: ${read.text ?? ''}.${dialogNote(out.dialog, read.dialog)}` };
      }
      case 'browser.wait_for':
        return await this.waitFor(caller, call, surface, reference, send);
      case 'browser.console': {
        const out = await send({
          op: 'console',
          ...(call.level === undefined ? {} : { level: call.level }),
          ...(call.since === undefined ? {} : { since: call.since }),
          ...(call.limit === undefined ? {} : { limit: call.limit }),
        });
        const read = await this.scrubbed({ text: out.reply.text, ...dialogOf(out.dialog) });
        return {
          summary: `The console of ${reference}.${dialogNote(out.dialog, read.dialog)}`,
          output: clipOutput(read.text ?? ''),
        };
      }
      case 'browser.network': {
        const out = await send({
          op: 'network',
          action: call.action,
          ...(call.id === undefined ? {} : { id: call.id }),
          ...(call.filter === undefined ? {} : { filter: call.filter }),
          ...(call.types === undefined ? {} : { types: call.types }),
        });
        const read = await this.scrubbed({ text: out.reply.text, ...dialogOf(out.dialog) });
        const what = call.action === 'get' ? `Request ${call.id ?? ''} of` : 'The requests of';
        return {
          summary: `${what} ${reference}.${dialogNote(out.dialog, read.dialog)}`,
          output: call.action === 'get' ? clipReading(read.text ?? '') : clipOutput(read.text ?? ''),
        };
      }
      case 'browser.emulate': {
        const { tool: _tool, name: _name, ...emulation } = call;
        const out = await send({ op: 'emulate', emulation: emulation as BrowserEmulation });
        const read = await this.scrubbed({ text: out.reply.text, ...dialogOf(out.dialog) });
        return {
          summary: `${read.text ?? 'Emulation applied'} on ${reference}.${dialogNote(out.dialog, read.dialog)}`,
        };
      }
    }
  }

  /**
   * `browser.wait_for`: ONE SECOND AT A TIME, with the takeover guard between slices, so a wait ends the
   * moment a person takes the page over — the way `terminal.wait` does. A dialog that opens ends it too,
   * since it blocks the page: the result says so.
   */
  private async waitFor(
    caller: AgentToolCaller,
    call: Extract<AgentToolCall, { readonly tool: 'browser.wait_for' }>,
    surface: ResolvedSurface,
    reference: string,
    send: (request: BrowserPageLifecycleRequest) => Promise<BrowserLifecycleOutcome>,
  ): Promise<AgentToolResult> {
    const condition = waitConditionOf(call);
    if (condition.kind === 'time') {
      for (let left = condition.ms; left > 0; left -= BROWSER_WAIT_SLICE_MS) {
        await this.ports.sleep(Math.min(BROWSER_WAIT_SLICE_MS, left));
        if (caller.kind === 'agent') await this.assertFree(caller.sessionId, surface);
      }
      return { summary: `Waited ${String(condition.ms)} ms on ${reference}.`, matched: true };
    }
    const timeoutMs = call.timeoutMs ?? BROWSER_WAIT_DEFAULT_MS;
    const deadline = this.ports.clock.now() + timeoutMs;
    for (let waited = 0; ; ) {
      const slice = Math.max(1, Math.min(BROWSER_WAIT_SLICE_MS, timeoutMs - waited));
      const out = await send({ op: 'wait', condition, timeoutMs: slice });
      waited += slice;
      if (out.reply.matched === true)
        return { summary: `The wait on ${reference} is over: it happened.`, matched: true };
      if (out.dialog !== undefined) {
        const read = await this.scrubbed(dialogOf(out.dialog));
        return {
          summary: `The wait on ${reference} stopped: the page is blocked by a dialog.${dialogNote(out.dialog, read.dialog)}`,
          matched: false,
        };
      }
      if (waited >= timeoutMs || this.ports.clock.now() >= deadline)
        return {
          summary: `Still waiting on ${reference}: the wait timed out after ${String(timeoutMs)} ms.`,
          matched: false,
        };
    }
  }

  private async browse(
    caller: AgentToolCaller,
    call: Extract<AgentToolCall, { readonly tool: PageToolName }>,
    surface: ResolvedSurface,
    reference: string,
    facts: CallFacts,
  ): Promise<AgentToolResult> {
    const answer: BrowserActionResult = await this.ports.browser.actOnPage(
      caller.sessionId,
      surface.id,
      pageActionOf(call),
      this.browserGuard(caller, surface, call.tool),
    );
    const page: {
      readonly url?: string;
      readonly text?: unknown;
      readonly screenshotBase64?: unknown;
      readonly screenshotFormat?: unknown;
    } = 'result' in answer ? answer.result : {};
    const dialog = pendingDialogOf(page);
    const started = 'result' in answer ? (answer.result.downloads ?? []) : [];
    const read = await this.scrubbed({
      ...(page.url === undefined ? {} : { url: page.url }),
      ...(typeof page.text === 'string' ? { text: page.text } : {}),
      ...dialogOf(dialog),
      ...(started.length === 0 ? {} : { names: started.map(notice => notice.name) }),
    });
    const at = read.url === undefined ? '' : ` (now at ${read.url})`;
    const check =
      humanCheckNote(answer, surface.id) + dialogNote(dialog, read.dialog) + downloadsNote(started, read.names);
    const secret = 'result' in answer && answer.result.passwordField === true ? passwordNote(call.tool) : '';
    if (secret !== '') facts.detail = { ...facts.detail, passwordField: true };
    if (read.text !== undefined && call.tool === 'browser.read') {
      const mode = browserReadModeOf(call);
      if (call.find !== undefined && read.text === '')
        return { summary: `Nothing in the snapshot of ${reference} contains that text${at}.${check}`, output: '' };
      const output =
        mode === 'text'
          ? clipOutput(this.masked(caller.sessionId, read.text))
          : clipReading(this.masked(caller.sessionId, read.text));
      const clipped = output.length < read.text.length ? CLIPPED_SNAPSHOT_NOTE : '';
      const refs = mode === 'snapshot' ? REFS_NOTE : '';
      return { summary: `Read ${reference}${at}.${refs}${clipped}${check}`, output };
    }
    if (typeof page.screenshotBase64 === 'string')
      return {
        summary: `A screenshot of ${reference}${at}.${check}`,
        screenshotBase64: page.screenshotBase64,
        ...(page.screenshotFormat === 'jpeg' ? { screenshotFormat: 'jpeg' as const } : {}),
      };
    return { summary: `Done on ${reference}${at}.${secret}${check}` };
  }

  /**
   * The file tools. An upload hands the page files the file service has confined to the session's folder (or
   * the session's own attachments); a download or a PDF is staged by the browser and SAVED by the file service,
   * which alone decides where — under the session's folder, never over an existing file unless asked.
   */
  /**
   * An agent's own script, in an isolated world on its page (owner-gated: checked in {@link call}). What it
   * returned is scrubbed like every page text, and audited by its length only.
   */
  private async script(
    caller: AgentToolCaller,
    call: Extract<AgentToolCall, { readonly tool: 'browser.eval' }>,
    surface: ResolvedSurface,
    reference: string,
    facts: CallFacts,
  ): Promise<AgentToolResult> {
    const target = call.ref !== undefined || call.selector !== undefined ? elementTargetOf(call) : undefined;
    const answer = await this.ports.browser.scriptOnPage(
      caller.sessionId,
      surface.id,
      {
        source: call.function,
        ...(target === undefined ? {} : { target }),
        ...(call.timeoutMs === undefined ? {} : { timeoutMs: call.timeoutMs }),
      },
      this.browserGuard(caller, surface, call.tool),
    );
    facts.detail = { resultLength: answer.text.length };
    const dialog = pendingDialogOf(answer.result);
    const read = await this.scrubbed({ url: answer.result.url, text: answer.text, ...dialogOf(dialog) });
    const output = clipReading(read.text ?? '');
    const clipped = output.length < (read.text ?? '').length ? ' It was clipped to fit: return less.' : '';
    return {
      summary: `Ran your script on ${reference} (now at ${read.url ?? answer.result.url}).${clipped}${humanCheckNote(answer, surface.id)}${dialogNote(dialog, read.dialog)}`,
      output,
    };
  }

  private async files(
    caller: AgentToolCaller,
    call: Extract<AgentToolCall, { readonly tool: 'browser.upload' | 'browser.download' | 'browser.pdf' }>,
    surface: ResolvedSurface,
    reference: string,
    facts: CallFacts,
  ): Promise<AgentToolResult> {
    const { sessionId } = caller;
    const guard = this.browserGuard(caller, surface, call.tool);
    if (call.tool === 'browser.upload') {
      const prepared = await this.ports.files.prepareUpload(sessionId, call.files);
      facts.detail = uploadFacts(prepared.files);
      let answer: Awaited<ReturnType<BrowserSubsystem['filesOnPage']>>;
      try {
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
      } finally {
        await prepared.release();
      }
      const started = answer.result.downloads ?? [];
      const read = await this.scrubbed({
        url: answer.result.url,
        ...(started.length === 0 ? {} : { names: started.map(notice => notice.name) }),
      });
      const how = call.mode === 'drop' ? 'Dropped' : 'Gave';
      return {
        summary: `${how} ${plural(prepared.files.length, 'file')} (${sizeWords(prepared.files.reduce((sum, file) => sum + file.size, 0))}) ${call.mode === 'drop' ? 'onto' : 'to'} ${reference} (now at ${read.url ?? answer.result.url}).${humanCheckNote(answer, surface.id)}${downloadsNote(started, read.names)}`,
      };
    }
    const action: BrowserFileAction =
      call.tool === 'browser.download'
        ? { action: 'download', ...(call.id === undefined ? {} : { downloadId: call.id }) }
        : { action: 'pdf' };
    const answer = await this.ports.browser.filesOnPage(sessionId, surface.id, action, guard);
    if (answer.staged === undefined) throw new AgentToolError('upstream_failed', 'The browser staged no file to save.');
    const read = await this.scrubbed({ names: [answer.staged.name] });
    const name = read.names?.[0] ?? answer.staged.name;
    const saved = await this.ports.files.save(
      sessionId,
      { ...answer.staged, name },
      { saveAs: call.saveAs, overwrite: call.overwrite === true, maxBytes: AGENT_FILE_LIMITS.downloadBytes },
    );
    const extension = extensionOf(saved.name);
    facts.detail = { size: saved.size, ...(extension === undefined ? {} : { extension }) };
    const what = call.tool === 'browser.pdf' ? 'Printed' : 'Saved';
    return {
      summary: `${what} ${reference} as ${saved.saved} (${sizeWords(saved.size)}) in this session's folder.${humanCheckNote(answer, surface.id)}`,
    };
  }

  /** A page's reading with every vault secret masked, under one vault open — or refused, never served raw. */
  private async scrubbed(reading: PageReading): Promise<PageReading> {
    // A reading carries only the parts a page returned, so an empty one has nothing to mask.
    if (Object.keys(reading).length === 0) return reading;
    try {
      return await this.ports.redactor.batch(scrub => ({
        ...(reading.url === undefined ? {} : { url: scrub.text(reading.url) }),
        ...(reading.text === undefined ? {} : { text: scrub.text(reading.text) }),
        ...(reading.dialog === undefined ? {} : { dialog: scrub.text(reading.dialog) }),
        ...(reading.names === undefined ? {} : { names: reading.names.map(name => scrub.text(name)) }),
      }));
    } catch {
      throw new AgentToolError(
        'unavailable',
        'The page was acted on, but this machine could not open its secret store to mask secrets in what the page shows, so that is withheld. Try again shortly.',
      );
    }
  }

  /**
   * The check the browser runs INSIDE the page's own queue, right before an agent's act: a takeover
   * that landed while the act was waiting its turn still refuses it.
   */
  /**
   * What the page's own queue checks immediately before it runs an act: an agent's takeover, and the input bridge's
   * gate (a value pending on the page, a hold on it) for EVERY caller. The check before the queue fails fast; this
   * one is the boundary, because a request can be raised or a value typed while the act waits. It reads the page's
   * document from the browser it runs on, never by queueing behind itself.
   */
  private browserGuard(caller: AgentToolCaller, surface: ResolvedSurface, tool?: string): BrowserActGuard | undefined {
    const gated =
      this.ports.input !== undefined &&
      tool !== undefined &&
      (PAGE_TYPING.has(tool) || PAGE_TEXT.has(tool) || PAGE_PICTURES.has(tool));
    if (caller.kind !== 'agent' && !gated) return undefined;
    return async page => {
      if (caller.kind === 'agent') await this.assertFree(caller.sessionId, surface);
      if (gated) await this.guardPage(caller, tool, surface, async () => await page.document());
    };
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
      clipOutput(await this.readText(caller, surface, reference, WAIT_TAIL_LINES));
    for (;;) {
      await this.ports.sleep(AGENT_TOOL_POLL_MS);
      if (caller.kind === 'agent') await this.assertFree(sessionId, surface);
      this.assertReadable(caller, surface, reference);
      // The predicate sees what the agent may see: a value the daemon just typed is masked BEFORE the match,
      // so neither "matched" nor "not matched" can tell the agent whether a guess is in the hidden text.
      const matched =
        call.text === undefined
          ? await this.ended(sessionId, surface)
          : (await this.readText(caller, surface, reference, WAIT_SEARCH_LINES)).includes(call.text);
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
    const until = this.ports.quarantinedUntil?.(caller.sessionId, [surface.name, surface.id]);
    if (until === undefined) return;
    const when = new Date(until).toISOString();
    throw new AgentToolError(
      'conflict',
      caller.kind === 'agent'
        ? `${reference} is quarantined until ${when}: the owner's secret was just typed there, so you cannot read it for a short while. You can still send keys. Try again after that time, or ask the owner.`
        : `${reference} is quarantined until ${when}: a secret was just typed there. Read it in the terminal viewer with "Show anyway", or end the quarantine there, or try again after that time.`,
    );
  }

  /**
   * The screen text a caller may be given. A read is the one place text leaves the daemon, so the quarantine
   * is checked again after the capture comes back: a secret typed while the capture was in flight must not
   * be published by a read that began before it.
   */
  private async readText(
    caller: AgentToolCaller,
    surface: ResolvedSurface,
    reference: string,
    lines: number,
  ): Promise<string> {
    const text = await this.ports.terminals.text(caller.sessionId, surface.id, lines);
    this.assertReadable(caller, surface, reference);
    return this.masked(caller.sessionId, text);
  }

  /** The terminal a pending request is on: the one it is pending on, among the session's own. */
  private async paneOf(input: AgentInputPort, sessionId: string, id: AgendaId): Promise<ResolvedSurface | undefined> {
    const { terminals } = await this.ports.terminals.list(sessionId);
    for (const terminal of terminals) {
      const names = [terminal.name, terminal.id];
      if (names.some(key => key !== undefined && input.pendingOn(sessionId, { kind: 'terminal', key }) === id))
        return {
          surface: 'terminal',
          id: terminal.id,
          ...(terminal.name === undefined ? {} : { name: terminal.name }),
        };
    }
    return undefined;
  }

  /**
   * What a page may not be asked while the owner's value is on its way into it or has just landed there: an act
   * that types into it while a request is pending on it (the value is the owner's to type), and a read of it
   * during its hold ({@link assertPageReadable}).
   */
  private async guardPage(
    caller: AgentToolCaller,
    tool: string,
    surface: ResolvedSurface,
    document?: () => Promise<string | undefined>,
  ): Promise<void> {
    const input = this.ports.input;
    if (input === undefined) return;
    const reference = surfaceReference('browser', surface.name ?? surface.id);
    if (PAGE_TYPING.has(tool)) {
      const pending = [surface.name, surface.id]
        .filter((key): key is string => key !== undefined)
        .map(key => input.pendingOn(caller.sessionId, { kind: 'browser', key }))
        .find(id => id !== undefined);
      if (pending !== undefined)
        throw new AgentToolError(
          'conflict',
          `an input request is pending on ${reference}; wait for !${pending} (input.wait) and do not type there yourself`,
        );
    }
    await this.assertPageReadable(caller, tool, surface, document);
  }

  /**
   * A page the daemon just typed a secret into is not READ while it is held: masking can only hide a value it
   * recognises, so the page's text, its log and any picture of it wait for the window to end. A picture always
   * waits (no mask can be drawn on pixels). Text may be read again as soon as the page has left the document the
   * value went into, because every read is masked for the redaction window anyway.
   */
  private async assertPageReadable(
    caller: AgentToolCaller,
    tool: string,
    surface: ResolvedSurface,
    document?: () => Promise<string | undefined>,
  ): Promise<void> {
    if (!PAGE_PICTURES.has(tool) && !PAGE_TEXT.has(tool)) return;
    const input = this.ports.input;
    const held = input?.pageHeld?.(caller.sessionId, [surface.name, surface.id]);
    if (input === undefined || held === undefined) return;
    if (PAGE_TEXT.has(tool) && held.documents.length > 0) {
      const now = await (
        document ?? (async () => await input.pageDocument?.(caller.sessionId, surface.name ?? surface.id))
      )();
      if (now !== undefined && !held.documents.includes(now)) return;
    }
    const reference = surfaceReference('browser', surface.name ?? surface.id);
    const when = new Date(held.until).toISOString();
    throw new AgentToolError(
      'conflict',
      caller.kind === 'agent'
        ? `${reference} is quarantined until ${when}: the owner's secret was just typed there, so you cannot read or picture it for a short while. You can still click and navigate; text reads come back once the page has moved on, pictures after that time.`
        : `${reference} is quarantined until ${when}: a secret was just typed there. Look at it in the browser view, or try again after that time.`,
    );
  }

  /**
   * A failed call's error as it may leave the daemon. A read or picture of a page under a hold answers with the hold,
   * success or not: an error can carry the page's words as well as a result can. Every other message passes the
   * same redactor as a read (a page's thrown error can echo a value just typed), and fails CLOSED to a fixed
   * sentence when the redactor cannot run.
   */
  private async heldOrMasked(
    caller: AgentToolCaller,
    tool: string,
    surface: ResolvedSurface | undefined,
    error: unknown,
  ): Promise<unknown> {
    if (surface?.surface === 'browser') {
      try {
        await this.assertPageReadable(caller, tool, surface);
      } catch (held) {
        return held;
      }
    }
    const message = error instanceof Error ? error.message : undefined;
    if (message === undefined || message === '') return error;
    const masked = await this.ports.redactor.batch(scrub => scrub.text(message)).catch(() => undefined);
    if (masked === message) return error;
    const text =
      masked ??
      'The call failed, and Ferretry could not open its secret store to check its message, so it is withheld.';
    return error instanceof AgentToolError ? new AgentToolError(error.code, text) : new Error(text);
  }

  /** Runs `work` as one turn in the session when input requests are wired; just runs it where they are not. */
  private async exclusively<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    return this.ports.input === undefined ? await work() : await this.ports.input.exclusive(sessionId, work);
  }

  /** Screen text with the values the daemon just typed masked; text unchanged where no mask is wired. */
  private masked(sessionId: string, text: string): string {
    return this.ports.scrub === undefined ? text : this.ports.scrub(sessionId, text);
  }

  /** A paste "as the secret NAME": no surface is involved, so there is nothing of the agent's to resolve. */
  private async pasteToStore(
    sessionId: string,
    caller: AgentToolCaller,
    call: Extract<AgentToolCall, { readonly tool: 'secure.paste' }>,
    secret: string,
    name: string,
  ): Promise<AgentToolResult> {
    const view = await this.inputPort(caller).raise(sessionId, {
      target: { kind: 'secret', key: secret },
      prompt: call.prompt,
      sensitivity: 'secret',
      submit: 'agent',
      source: { kind: 'sealed', name },
      ...(call.expiresInSeconds === undefined ? {} : { expiresInSeconds: call.expiresInSeconds }),
    });
    return {
      summary:
        view.state === 'delivered'
          ? `Saved ${copyHandle(name)} as the secret ${secret} under a rule the owner approved in advance (!${view.id}). Use it as \${secret:${secret}}.`
          : `Asked the owner to allow saving ${copyHandle(name)} as the secret ${secret} (!${view.id}). Wait with input.wait.`,
      input: view,
    };
  }

  private copyPort(): AgentCopyPort {
    if (this.ports.copy === undefined)
      throw new AgentToolError('unavailable', 'Secure copy is not available on this daemon.');
    return this.ports.copy;
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

  private async listPages(caller: AgentToolCaller, tabs = false): Promise<AgentToolResult> {
    const status = await this.ports.browser.status(caller.sessionId);
    const surfaces = await Promise.all(
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
    const listing = shown('browser', surfaces);
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
    caller: AgentToolCaller,
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

  /** The surface a name or id addresses, looked up in this session's own listing and nowhere else. */
  private async resolve(sessionId: string, surface: SurfaceKind, key: string): Promise<ResolvedSurface> {
    const candidates: readonly {
      readonly id: string;
      readonly name?: string;
      readonly openedBy?: SurfaceOpener;
      readonly incognito?: true;
      readonly openerId?: string;
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
      ...(found.openerId === undefined ? {} : { openerId: found.openerId }),
    };
  }

  /** Whether an agent may act on this surface now: it is the agent's, and nobody is holding it. */
  private async assertAgentMay(sessionId: string, surface: ResolvedSurface, pages?: PageRows): Promise<void> {
    const mine =
      openedByAgent(surface.openedBy, sessionId) ||
      (await this.ports.control.isHanded(sessionId, surface)) ||
      (await this.popupOfMine(sessionId, surface, pages));
    if (!mine)
      throw new AgentToolError(
        'forbidden',
        `${surfaceReference(surface.surface, surface.name ?? surface.id)} is a person's, not yours: you may use it only if they hand it to you. Ask them, or open your own.`,
      );
    await this.assertFree(sessionId, surface);
  }

  /**
   * Whether a page is a popup of one of the agent's own: its opener chain — the opener records the
   * daemon keeps, never a claim — ends at a page this agent opened or was handed.
   */
  private async popupOfMine(sessionId: string, surface: ResolvedSurface, known?: PageRows): Promise<boolean> {
    if (surface.surface !== 'browser' || surface.openerId === undefined) return false;
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
    facts: CallFacts,
    outcome: AuditOutcome,
  ): Promise<void> {
    const surface = facts.surface;
    const key = surface === undefined ? ('name' in call ? call.name : undefined) : (surface.name ?? surface.id);
    const kind = kindOf(call);
    const detail: AuditDetail = {
      tool: call.tool,
      by: caller.kind,
      ...(key === undefined || kind === undefined ? {} : { surface: surfaceReference(kind, key) }),
      ...callFacts(call),
      ...facts.detail,
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
      return call.url === undefined ? { history: call.history ?? 'reload' } : { host: auditHost(call.url) };
    case 'browser.click':
      return {
        ...targetFacts(call),
        ...(call.button === undefined ? {} : { button: call.button }),
        ...(call.double === true ? { double: true } : {}),
        ...(call.modifiers === undefined ? {} : { modifiers: call.modifiers.length }),
      };
    case 'browser.type':
      return {
        ...targetFacts(call),
        textLength: call.text.length,
        ...(call.submit === true ? { submit: true } : {}),
        ...(call.slowly === true ? { slowly: true } : {}),
      };
    case 'browser.read':
      return {
        mode: browserReadModeOf(call),
        ...targetFacts(call),
        ...(call.find === undefined ? {} : { findLength: call.find.length }),
        ...(call.depth === undefined ? {} : { depth: call.depth }),
      };
    case 'browser.screenshot':
      return {
        ...targetFacts(call),
        ...(call.fullPage === true ? { fullPage: true } : {}),
        ...(call.format === undefined ? {} : { format: call.format }),
      };
    case 'terminal.request_input':
      return { sensitivity: call.sensitivity };
    case 'browser.request_input':
      return { sensitivity: strongestSensitivity(call.fields), fields: call.fields.length };
    case 'input.wait':
      return { timeoutMs: call.timeoutMs ?? AGENT_TOOL_DEFAULT_WAIT_MS };
    case 'secure.copy':
      // The copy's name and where it came from; never a command's arguments, which may hold anything.
      return {
        copy: copyHandle(call.name),
        source: call.source.kind,
        ...(call.source.kind === 'command' ? { args: call.source.argv.length - 1 } : {}),
      };
    case 'secure.discard':
      return { copy: copyHandle(bareCopyName(call.handle)) };
    case 'secure.paste':
      return { copy: copyHandle(bareCopyName(call.handle)) };
    case 'secure.preapprove':
      return { items: call.items.length };
    case 'browser.dialog':
      return {
        action: call.action,
        ...(call.promptText === undefined ? {} : { promptTextLength: call.promptText.length }),
      };
    case 'browser.tabs':
      return { action: call.action };
    case 'browser.wait_for':
      return { waitKind: waitConditionOf(call).kind, timeoutMs: call.timeoutMs ?? BROWSER_WAIT_DEFAULT_MS };
    case 'browser.console':
      return {
        ...(call.level === undefined ? {} : { level: call.level }),
        ...(call.since === undefined ? {} : { since: call.since }),
        ...(call.limit === undefined ? {} : { limit: call.limit }),
      };
    case 'browser.network':
      return {
        action: call.action,
        ...(call.filter === undefined ? {} : { filterLength: call.filter.length }),
        ...(call.types === undefined ? {} : { types: call.types.length }),
      };
    case 'browser.emulate':
      return {
        fields: Object.entries(call)
          .filter(([key, value]) => key !== 'tool' && key !== 'name' && value !== undefined)
          .map(([key]) => key)
          .join(','),
      };
    case 'browser.upload':
      return { ...targetFacts(call), files: call.files.length, mode: call.mode ?? 'input' };
    case 'browser.download':
      return call.id === undefined ? {} : { download: call.id };
    case 'browser.pdf':
      return {};
    case 'browser.eval':
      return {
        functionLength: call.function.length,
        ...targetFacts(call),
        ...(call.timeoutMs === undefined ? {} : { timeoutMs: call.timeoutMs }),
      };
    case 'browser.hover':
      return targetFacts(call);
    case 'browser.drag':
      return {
        from: dragEndFacts(call.fromRef, call.fromSelector, call.fromX),
        to: dragEndFacts(call.toRef, call.toSelector, call.toX),
        ...(call.steps === undefined ? {} : { steps: call.steps }),
      };
    case 'browser.mouse':
      return {
        mouse: call.action,
        ...(call.x === undefined ? {} : { point: true }),
        ...(call.button === undefined ? {} : { button: call.button }),
      };
    case 'browser.press':
      return { keys: call.keys.length, ...targetFacts(call) };
    case 'browser.scroll':
      return {
        scroll:
          call.text !== undefined
            ? 'text'
            : call.pages !== undefined
              ? 'pages'
              : call.deltaX === undefined && call.deltaY === undefined
                ? 'element'
                : 'distance',
        ...targetFacts(call),
        ...(call.text === undefined ? {} : { textLength: call.text.length }),
      };
    case 'browser.select':
      return { ...targetFacts(call), values: call.values.length };
    case 'browser.check':
      return { ...targetFacts(call), checked: call.checked };
    case 'browser.fill_form':
      return {
        fields: call.fields.length,
        textLength: call.fields.reduce((sum, field) => sum + (field.text?.length ?? 0), 0),
      };
    case 'browser.highlight':
      return call.clear === true ? { clear: true } : targetFacts(call);
    default:
      return {};
  }
}

/** What both request tools pass on unchanged: who presses Enter, how long the card lives, whether it pings, what it follows. */
function raiseOptions(
  call: Extract<AgentToolCall, { readonly tool: 'terminal.request_input' | 'browser.request_input' }>,
) {
  return {
    submit: call.submit ?? ('offer-owner' as const),
    ...(call.expiresInSeconds === undefined ? {} : { expiresInSeconds: call.expiresInSeconds }),
    ...(call.blocking === undefined ? {} : { blocking: call.blocking }),
    ...(call.chain === undefined ? {} : { chain: call.chain }),
    ...(call.secretHint === undefined ? {} : { secretHint: call.secretHint }),
  };
}

/** What a capture caught, in one sentence: where from, how long, and whether it was already seen. */
function copiedSummary(copy: CopyMeta): string {
  const from = copy.from.origin ?? copy.from.program ?? copy.from.kind;
  const seen =
    copy.exposure.transcript === 'found'
      ? ' WARNING: this value was already in your transcript before it was sealed, so it is NOT protected; tell the owner it should be rotated.'
      : '';
  return `Sealed ${plural(copy.length, 'character')} from ${from} as ${copy.handle}, until ${copy.expiresAt}. You cannot read it; paste it by handle.${seen}`;
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
      if (view.source === 'sealed')
        return `${card}: the secure copy was pasted${view.submitted === true ? ' and Enter pressed' : ''}. Read the terminal once its quarantine allows.`;
      return `${card}: the owner typed the value${view.submitted === true ? ' and pressed Enter' : ''}. Read the terminal to see what happened.`;
    case 'refused':
      return `${card} was refused${view.reason === undefined ? '' : ` (${view.reason})`}: the value was not typed. Look at the terminal, then raise a new request if it is still needed.`;
    case 'expired':
      return `${card} expired without an answer.`;
    case 'cancelled':
      return `${card} was cancelled${view.reason === undefined ? '' : ` (${view.reason})`}.`;
  }
}

/** The one thing a `browser.wait_for` waits for. The call schema already holds it to exactly one. */
function waitConditionOf(call: Extract<AgentToolCall, { readonly tool: 'browser.wait_for' }>): BrowserWaitCondition {
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

/** One end of a drag, for the audit: a ref, a short selector, or only that it was a point. */
function dragEndFacts(ref: string | undefined, selector: string | undefined, x: number | undefined): string {
  if (ref !== undefined) return ref;
  if (selector !== undefined) return `selector:${auditSelector(selector)}`;
  return x === undefined ? 'unknown' : 'point';
}

/** What an act pointed at, for the audit: a ref, a short selector, or only that it was a point. */
function targetFacts(fields: BrowserTargetFields): AuditDetail {
  if (fields.ref !== undefined) return { ref: fields.ref };
  if (fields.selector !== undefined) return { selector: auditSelector(fields.selector) };
  if (fields.x !== undefined) return { point: true };
  return {};
}

/** The browser's own action for an agent tool's call. */
function pageActionOf(call: Extract<AgentToolCall, { readonly tool: PageToolName }>): BrowserPageAction {
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

/** The most uploaded files an audit record names; it holds twelve facts in all. */
const AUDIT_NAMED_FILES = 4;

/** The audit facts of an upload's files: their total size, and the first few by leaf name and size — never a path or content. */
function uploadFacts(files: readonly { readonly name: string; readonly size: number }[]): AuditDetail {
  const named: AuditDetail = {};
  files.slice(0, AUDIT_NAMED_FILES).forEach((file, index) => {
    named[`file${String(index + 1)}`] = `${file.name.slice(0, AGENT_FILE_LIMITS.nameChars)} (${String(file.size)} B)`;
  });
  return { bytes: files.reduce((sum, file) => sum + file.size, 0), ...named };
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
  if (error instanceof SecureCopyError) return new AgentToolError(error.code, error.message);
  if (error instanceof InputRequestError)
    return new AgentToolError(error.code === 'gone' ? 'not_found' : error.code, error.message);
  if (error instanceof TerminalMountError) return new AgentToolError(error.code, error.message);
  if (error instanceof AgentFileError) return new AgentToolError(error.code, error.message);
  if (error instanceof BrowserTransportError) return fromWorker(error);
  if (!(error instanceof BrowserSessionError)) return undefined;
  if (error.code === 'launch_failed') return new AgentToolError('unavailable', browserUnavailable(error.message));
  if (error.code === 'not_running')
    return new AgentToolError(
      'not_found',
      'The browser is not running in this session. Open a page with browser.open.',
    );
  return new AgentToolError(error.code, error.message);
}

/**
 * The worker's refusal of an act — a ref the page no longer knows, an element that never appeared — in
 * this domain's words. The worker's own sentence is what the agent needs to act on ("read the page
 * again"), so it is kept, without the transport's "browser action failed:" prefix.
 */
function fromWorker(error: BrowserTransportError): AgentToolError {
  const message = error.message.replace(/^browser action failed: /u, '');
  switch (error.code) {
    case 'launch_failed':
      return new AgentToolError('unavailable', browserUnavailable(message));
    case 'not_running':
      return new AgentToolError(
        'not_found',
        'The browser is not running in this session. Open a page with browser.open.',
      );
    case 'profile_busy':
    case 'login_window_open':
      return new AgentToolError('conflict', message);
    default:
      return new AgentToolError(error.code, message);
  }
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

/** "This session holds 2 live copies." */
const liveCopies = (count: number): string =>
  `This session holds ${String(count)} live ${count === 1 ? 'copy' : 'copies'}.`;

/** A copy's name as a call wrote it: `sealed:vercel` and `vercel` are one copy, whether or not the wire parsed it. */
const bareCopyName = (handle: string): string =>
  handle.startsWith(COPY_HANDLE_PREFIX) ? handle.slice(COPY_HANDLE_PREFIX.length) : handle;
