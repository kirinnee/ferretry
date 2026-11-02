import {
  type AccountId,
  type AccountList,
  AGENT_TOOL_DEFAULT_READ_LINES,
  AGENT_TOOL_DEFAULT_WAIT_MS,
  type AgendaId,
  type AgentSurface,
  type AgentToolCall,
  type AgentToolResult,
  type AuditDetail,
  type AuditOutcome,
  accountHintSummary,
  accountHintsFor,
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
  copyPlanOf,
  durationWords,
  INPUT_QUARANTINE_SECONDS,
  INPUT_SINGLE_FIELD_ID,
  type InputAgentView,
  type LoginRecipeProposed,
  loginHintSite,
  type PhoneApprovalAgentView,
  PhoneApprovalRaiseSchema,
  type SignInChoiceContext,
  type SignInId,
  type SurfaceController,
  type SurfaceControlRequest,
  type SurfaceControlView,
  type SurfaceKind,
  type SurfaceOpener,
  strongestSensitivity,
  taskPlanAgentView,
  taskPlanCallOf,
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
  NON_TYPING_KEYS,
  pendingDialogOf,
} from '../browser/runtime/index.ts';
import { BrowserTransportError } from '../browser/transport/worker-protocol.ts';
import type { AgentControlPolicy } from '../fleet/agent-control.ts';
import { InputRequestError } from '../input-requests/errors.ts';
import { TerminalMountError, type TerminalSubsystem } from '../runtime/mounts/terminals.ts';
import { LoginEntryError } from '../secrets/accounts.ts';
import { type RecipeProposalTarget, RecipeValueError } from '../secrets/login-recipes.ts';
import type { TextRedactor } from '../secrets/redaction.ts';
import { SecureCopyError } from '../secure-copy/errors.ts';
import { SignInRuleSuggestionError } from '../sign-in-rules/suggestions.ts';
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
  AgentCopyPagesPort,
  AgentCopyPort,
  AgentInputPort,
  AgentPhoneApprovalPort,
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
  /** Phone approvals (`push: true` on a request tool); absent where none are wired, which refuses `push`. */
  readonly phoneApprovals?: AgentPhoneApprovalPort;
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
  /** What secure copy knows about pages: not pictured while showing a copied document, and what the agent read. */
  readonly copyPages?: AgentCopyPagesPort;
  /**
   * The accounts' and sign-ins' listing, for `account.hint` (which serves only their NON-SECRET projection: labels,
   * places, methods, usernames, recipes, facts). The directory a route holds, never the vault: nothing here can open a
   * value. Absent: the tool says none are kept.
   */
  readonly accounts?: { list(): Promise<Pick<AccountList, 'accounts' | 'signIns'>> };
  /** The calling session's project, folder and the owner's defaults, which order `account.hint`'s "default". */
  readonly signInChoice?: { of(sessionId: string): Promise<Omit<SignInChoiceContext, 'hint'>> };
  /**
   * A ferret's recipe proposals (`account.propose`): filed on the login, checked for values, shown to the owner.
   * Absent: the tool says recipes are not kept here.
   */
  /**
   * Told each time the agent drives a terminal or a page, before the act: what the daemon sees after a saved login's
   * submit (the page moving on, the screen not echoing) is only kept as a fact when the ferret did nothing meanwhile.
   */
  readonly loginActs?: { acted(sessionId: string, kind: SurfaceKind, script: boolean): void };
  /**
   * Told what an agent's `browser.type` put into an identifier field (an email or username box), and the host each
   * act left a page on: who a page is signing in, for the owner's card (input-requests/typed-identities.ts). Plain
   * text the agent typed itself; it only ever removes a one-tap or pre-fills a username. Absent: nothing is kept.
   */
  readonly typedIdentities?: {
    typed(sessionId: string, pageId: string, host: string, text: string): void;
    seen(sessionId: string, pageId: string, host: string | undefined): void;
    cleared(sessionId: string, pageId: string): void;
    forget(sessionId: string): void;
  };
  /**
   * Told the host of every page a script runs on, from ANY caller, right before it runs (read inside the page's queue)
   * and again where it ended: a standing rule fills for every ferret in one shared browser profile, so a script on its
   * login domain suspends it (docs/input-requests.md, "Standing rule fills"). `undefined`: the host couldn't be read, so
   * it may have been any.
   */
  readonly scriptedOrigins?: {
    scriptedOn(host: string | undefined): void;
    /** A script is about to run: no standing rule fills anywhere until the returned function says it ended. */
    running?(): () => void;
  };
  /**
   * A ferret's SUGGESTION of a standing rule (`account.propose` with `preapprove`): one card on the owner's agenda and
   * nothing else. Absent: the tool says suggestions are not kept here.
   */
  readonly ruleSuggestions?: {
    suggest(
      sessionId: string,
      ask: { readonly signIn?: SignInId | undefined; readonly login?: AccountId | undefined; readonly why: string },
    ): Promise<{ readonly signIn: string; readonly host: string; readonly agenda: string }>;
  };
  readonly recipes?: {
    /** Files a proposal on ONE sign-in: `{ login }` is resolved to the account's only sign-in first. */
    propose(
      sessionId: string,
      target: RecipeProposalTarget,
      recipe: string,
      why: string,
    ): Promise<LoginRecipeProposed & { readonly signIn: string }>;
    /** The listing with every recipe and proposal masked now, or their texts dropped where nothing can mask them. */
    scrubbedAccounts(
      listing: Pick<AccountList, 'accounts' | 'signIns'>,
    ): Promise<Pick<AccountList, 'accounts' | 'signIns'>>;
  };
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

/**
 * The kind of surface a call is about; `input.wait` is about a request, `secure.*` about a copy and `account.hint`
 * about the saved logins, not a surface.
 */
const kindOf = (call: AgentToolCall): SurfaceKind | undefined =>
  call.tool === 'input.wait' ||
  call.tool === 'account.hint' ||
  call.tool === 'account.propose' ||
  call.tool === 'task.plan' ||
  call.tool.startsWith('secure.')
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
      ? call.to.kind === 'browser'
        ? 'browser'
        : 'terminal'
      : call.tool === 'account.hint'
        ? call.name === undefined
          ? undefined
          : 'browser'
        : kindOf(call);

/**
 * The tools that change nothing a sign-in's facts are read from: they list, read, wait, look, raise a card for the
 * owner, or hand a surface over. Every other tool may change a terminal or a page, and {@link actsOn} says which.
 */
const LEAVES_SURFACES: ReadonlySet<string> = new Set<AgentToolCall['tool']>([
  'terminal.list',
  'terminal.read',
  'terminal.wait',
  'terminal.ask_owner',
  'terminal.request_input',
  'input.wait',
  'account.hint',
  'account.propose',
  'browser.list',
  'browser.read',
  'browser.screenshot',
  'browser.wait_for',
  'browser.console',
  'browser.network',
  'browser.pdf',
  'browser.ask_owner',
  'browser.request_input',
  'secure.list',
  'secure.discard',
  'secure.copy',
  'secure.preapprove',
  'task.plan',
]);

/** The kind of surface a call may change, or nothing for a call that changes none. */
export function actsOn(call: AgentToolCall): SurfaceKind | undefined {
  if (LEAVES_SURFACES.has(call.tool)) return undefined;
  if (call.tool === 'secure.paste') return call.to.kind === 'secret' ? undefined : call.to.kind;
  if (call.tool === 'browser.tabs' && call.action === 'list') return undefined;
  return call.tool.startsWith('terminal.') ? 'terminal' : 'browser';
}

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
      // Told BEFORE anything runs, for every call that may change a terminal or a page: a sign-in's after-submit facts
      // the ferret could have steered are not kept (docs/input-requests.md, "Login recipes").
      const acting = caller.kind === 'agent' ? actsOn(call) : undefined;
      if (acting !== undefined) this.ports.loginActs?.acted(caller.sessionId, acting, call.tool === 'browser.eval');
      // The surface is known only once the call has run: dispatch resolves it.
      const dispatched = await this.dispatch(caller, call, facts);
      result = this.remasked(caller, facts.surface, dispatched);
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

  /**
   * Records a session credential refused for naming another session in `x-ferretry-session-id`.
   *
   * The SAME event the authorization boundary writes for it on every other route
   * (`session.credential-refused`), naming the session the credential named and never the credential —
   * and a different event from `agent.tool`, so it is never folded away under an ordinary refusal.
   */
  async refusedSessionClaim(sessionId: string, route: string): Promise<void> {
    await this.ports.audit.record({
      event: 'session.credential-refused',
      actor: { kind: 'host' },
      subject: sessionId,
      outcome: 'refused',
      detail: { by: 'agent', reason: 'session_mismatch', route },
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
        const captured = await this.capture(caller, sessionId, call, facts);
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
        if (call.to.kind === 'browser') return await this.pasteToPage(sessionId, caller, call, call.to, name, facts);
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
              ? `Pasted ${copyHandle(name)} into ${reference} under a rule the owner approved in advance (!${view.id}). The terminal is unreadable for ${view.lockSeconds === undefined ? `about ${durationWords(INPUT_QUARANTINE_SECONDS)}` : `${String(view.lockSeconds)} seconds`}.`
              : `Asked the owner to allow pasting ${copyHandle(name)} into ${reference} (!${view.id}). Wait with input.wait; do not type there yourself.`,
          input: view,
        };
      }
      case 'secure.preapprove': {
        const plans = this.planPort(caller);
        const planned = copyPlanOf(await plans.propose(sessionId, taskPlanCallOf(call)));
        if (planned === undefined) throw new AgentToolError('bad_request', 'A plan lists 1 to 10 pastes.');
        return {
          summary: `Asked the owner to approve ${plural(planned.items.length, 'paste')} in advance (!${planned.agendaItemId}). Until they answer, each paste asks them.`,
          plan: planned,
        };
      }
      case 'task.plan': {
        const plan = await this.planPort(caller).propose(sessionId, call);
        return {
          summary: `Asked the owner to approve ${plural(plan.lines.length, 'line')} in advance (!${plan.agendaItemId}). Keep raising browser_request_input / terminal_request_input as usual: covered sign-ins and pastes are filled for you once the owner approves; anything else still asks.`,
          taskPlan: taskPlanAgentView(plan),
        };
      }
      case 'account.hint':
        return await this.loginHint(caller, call, facts);
      case 'account.propose':
        return await this.loginPropose(caller, call, facts);
      case 'input.wait': {
        if (call.id.startsWith('pa_')) {
          const view = await this.approvalPort(caller).agentView(
            sessionId,
            call.id,
            call.timeoutMs ?? AGENT_TOOL_DEFAULT_WAIT_MS,
          );
          return { summary: approvalSummary(view), phoneApproval: view };
        }
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
        // A hold that began while the page was being read wins: what the read saw may hold the value. A copy's hold
        // cannot begin mid-act (a copy seals inside the page's queue), so it is checked before the act, not here.
        if (surface.surface === 'browser') await this.assertPageReadable(caller, call.tool, surface, undefined, false);
        await this.drove(caller, call, surface);
        return result;
      }
    }
  }

  /**
   * An agent is about to read, picture or evaluate a page: recorded INSIDE the page's queue, before the act, with
   * the document it will see, so a copy queued behind it (asked afterwards) knows the agent may hold the value.
   * Recorded whether the act then succeeds or not: an error can carry the page's words too.
   */
  private async sawPage(
    caller: AgentToolCaller,
    tool: string,
    surface: ResolvedSurface,
    page: { document(): Promise<string | undefined> },
  ): Promise<void> {
    const pages = this.ports.copyPages;
    if (caller.kind !== 'agent' || pages === undefined || (!PAGE_TEXT.has(tool) && !PAGE_PICTURES.has(tool))) return;
    const document = await page.document().catch(() => undefined);
    if (document !== undefined) pages.saw(caller.sessionId, [surface.name, surface.id], document);
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
          | 'account.hint'
          | 'account.propose'
          | 'secure.copy'
          | 'secure.list'
          | 'secure.discard'
          | 'secure.paste'
          | 'secure.preapprove'
          | 'task.plan';
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
          // A card of one-time codes does not keep the ferret off the pane: it may type a code it read itself.
          const pending = this.ports.input?.pendingOn(
            sessionId,
            { kind: 'terminal', key: surface.name ?? surface.id },
            { typing: true },
          );
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
        if (call.push === true) return await this.approval(caller, call, surface, reference);
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
        if (call.push === true) return await this.approval(caller, call, surface, reference);
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
    let answer: BrowserActionResult;
    try {
      answer = await this.ports.browser.actOnPage(
        caller.sessionId,
        surface.id,
        pageActionOf(call),
        this.browserGuard(caller, surface, call.tool),
      );
    } catch (error) {
      // An act that failed partway may still have moved the page or typed into it (the browser runtime clears too).
      this.ports.typedIdentities?.cleared(caller.sessionId, surface.id);
      throw error;
    }
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
    if ('result' in answer)
      this.noteIdentity(caller.sessionId, surface.id, call, answer.result, caller.kind === 'agent');
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
   * WHO THE PAGE IS SIGNING IN (input-requests/typed-identities.ts), from what the daemon saw this act do. Kept: the
   * agent's type or fill into ONE identifier box (never beside a password field), or its click on an element that showed
   * one email. Kept as it was: an act that cannot change who signs in (a read, a hover, Enter or Tab), unless the page is
   * now on another host. CLEARED: everything else that could — a navigation, typing anything else, a key that types, raw
   * mouse moves, a click at a bare point — and any act by a person. A missing record is the safe state.
   */
  private noteIdentity(
    sessionId: string,
    /**
     * The DAEMON's id of the page acted on (the runtime's, as `browser.status` lists it), never the worker's word: the same
     * id the input target checks a card's facts against (`PageInputTarget`), so the two sides cannot drift apart.
     */
    pageId: string,
    call: Extract<AgentToolCall, { readonly tool: PageToolName }>,
    result: {
      readonly url?: string | undefined;
      readonly identifierHost?: string | undefined;
      readonly identifierFields?: readonly { readonly index: number; readonly host: string }[] | undefined;
      readonly clickedIdentity?: { readonly host: string; readonly username: string } | undefined;
      readonly passwordField?: true | undefined;
    },
    byAgent: boolean,
  ): void {
    const identities = this.ports.typedIdentities;
    if (identities === undefined) return;
    const next = identityAfter(call, result, byAgent);
    if (next === 'keep') identities.seen(sessionId, pageId, pageHostOf(result.url));
    else if (next === 'clear') identities.cleared(sessionId, pageId);
    else identities.typed(sessionId, pageId, next.host, next.username);
  }

  /**
   * The file tools. An upload hands the page the file service's own copies of files it confined to the session's folder (or
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
    const guard = this.browserGuard(caller, surface, call.tool);
    const scripts = this.ports.scriptedOrigins;
    let ran = false;
    let finished: (() => void) | undefined;
    let answer: Awaited<ReturnType<AgentToolPorts['browser']['scriptOnPage']>>;
    try {
      answer = await this.ports.browser.scriptOnPage(
        caller.sessionId,
        surface.id,
        {
          source: call.function,
          ...(target === undefined ? {} : { target }),
          ...(call.timeoutMs === undefined ? {} : { timeoutMs: call.timeoutMs }),
        },
        async page => {
          await guard?.(page);
          // The LAST thing before the script runs, inside the page's queue. While it runs, no standing rule fills
          // anywhere (the page may still move before its world is made, so the origin it really runs in is known only
          // after: secrev-1282a M2), and the host it is about to run on is tainted for the rules at once.
          finished = scripts?.running?.();
          scripts?.scriptedOn(await page.host?.().catch(() => undefined));
          // A script can type or choose an account on any page of the session: who they sign in is no longer known.
          this.ports.typedIdentities?.forget(caller.sessionId);
          ran = true;
        },
      );
      // The origin of the world the script ACTUALLY ran in, read before its code ran (unknown: it may have been any
      // host), and where it left the page: each is tainted too, before the rules may fill again.
      scripts?.scriptedOn(hostOf(answer.scriptOrigin));
      scripts?.scriptedOn(hostOf(answer.result.url));
    } catch (error) {
      // The script may have run and moved the page, and where it ran or ended can't be read: it may have been any host.
      if (ran) scripts?.scriptedOn(undefined);
      throw error;
    } finally {
      finished?.();
    }
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
      const prepared = await this.ports.files.prepareUpload(sessionId, call.files).catch((error: unknown) => {
        // Which guard of the daemon's own files refused it, so the audit says why without the path.
        if (error instanceof AgentFileError && error.rule !== undefined) facts.detail = { rule: error.rule };
        throw error;
      });
      facts.detail = uploadFacts(prepared.files);
      let answer: Awaited<ReturnType<BrowserSubsystem['filesOnPage']>>;
      // The page was handed the daemon's own copies, which it may read later (when its form is sent): they are
      // kept for the staging time and removed by a later upload, unless this act failed.
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
      } catch (error) {
        await prepared.release();
        throw error;
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
  private browserGuard(
    caller: AgentToolCaller,
    surface: ResolvedSurface,
    tool?: string,
    /** Whether the act reads the page for the AGENT (a copy's own read does not: the agent never sees it). */
    reads = true,
  ): BrowserActGuard | undefined {
    const gated =
      (this.ports.input !== undefined || this.ports.copyPages !== undefined) &&
      tool !== undefined &&
      (PAGE_TYPING.has(tool) || PAGE_TEXT.has(tool) || PAGE_PICTURES.has(tool));
    if (caller.kind !== 'agent' && !gated) return undefined;
    return async page => {
      if (caller.kind === 'agent') await this.assertFree(caller.sessionId, surface);
      if (gated) await this.guardPage(caller, tool, surface, async () => await page.document());
      if (reads && tool !== undefined) await this.sawPage(caller, tool, surface, page);
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
    const reference = surfaceReference('browser', surface.name ?? surface.id);
    if (input !== undefined && PAGE_TYPING.has(tool)) {
      const pending = [surface.name, surface.id]
        .filter((key): key is string => key !== undefined)
        // Only typing itself (browser.type) goes past a card of one-time codes: a script, a key press or a form fill
        // still waits, so nothing can watch or re-target the field the owner was asked about.
        .map(key => input.pendingOn(caller.sessionId, { kind: 'browser', key }, { typing: tool === 'browser.type' }))
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
    /** Whether a copy's hold is checked too: before an act and inside its queue, not after it. */
    copies = true,
  ): Promise<void> {
    if (!PAGE_PICTURES.has(tool) && !PAGE_TEXT.has(tool)) return;
    if (copies && PAGE_PICTURES.has(tool)) await this.assertNotCopiedFrom(caller, surface, document);
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
   * A page a secure copy was read FROM is not pictured while it still shows that document: no mask can be drawn on
   * pixels. Its text stays readable, masked, so the agent can still find "Done" by its ref. A page whose document
   * cannot be told is treated as still showing it.
   */
  private async assertNotCopiedFrom(
    caller: AgentToolCaller,
    surface: ResolvedSurface,
    document?: () => Promise<string | undefined>,
  ): Promise<void> {
    const copied = this.ports.copyPages?.documents(caller.sessionId, [surface.name, surface.id]) ?? [];
    if (copied.length === 0) return;
    const now = await (
      document ?? (async () => await this.ports.input?.pageDocument?.(caller.sessionId, surface.name ?? surface.id))
    )();
    if (now !== undefined && !copied.includes(now)) return;
    const reference = surfaceReference('browser', surface.name ?? surface.id);
    throw new AgentToolError(
      'conflict',
      caller.kind === 'agent'
        ? `${reference} still shows the page a secure copy was read from, so it is not pictured. Read it as text (the value is masked), or navigate away first.`
        : `${reference} still shows the page a secure copy was read from, so it is not pictured. Look at it in the browser view.`,
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

  /**
   * A page's result passes the held-value mask once more on its way out: a value sealed by a copy while this read
   * waited for, or ran in, the page's queue is masked in it too. A picture's bytes carry no text and are left alone.
   */
  private remasked(
    caller: AgentToolCaller,
    surface: ResolvedSurface | undefined,
    result: AgentToolResult,
  ): AgentToolResult {
    const scrub = this.ports.scrub;
    if (caller.kind !== 'agent' || surface?.surface !== 'browser' || scrub === undefined) return result;
    return masked(result, text => scrub(caller.sessionId, text)) as AgentToolResult;
  }

  /**
   * A copy's capture. A page or its clipboard must be one of the agent's own pages (opened or handed, not taken
   * over), named by the key it is known by, and the copy is told which of the page's documents the agent has
   * already read: masking cannot take that back, so the copy says so.
   */
  private async capture(
    caller: AgentToolCaller,
    sessionId: string,
    call: Extract<AgentToolCall, { readonly tool: 'secure.copy' }>,
    facts: CallFacts,
  ): Promise<Awaited<ReturnType<AgentCopyPort['capture']>>> {
    const copy = this.copyPort();
    const options = call.expiresInSeconds === undefined ? {} : { expiresInSeconds: call.expiresInSeconds };
    if (call.source.kind === 'command')
      return await copy.capture(sessionId, { name: call.name, source: call.source, ...options });
    const surface = await this.resolve(sessionId, 'browser', call.source.key);
    facts.surface = surface;
    await this.assertAgentMay(sessionId, surface);
    const key = surface.name ?? surface.id;
    // Read as the page READ it is: inside the queue, a takeover, a pending value or the owner's hold refuses it.
    const guard = this.browserGuard(caller, surface, 'browser.read', false);
    return await copy.capture(
      sessionId,
      { name: call.name, source: { ...call.source, key }, ...options },
      {
        seen: () => this.ports.copyPages?.seen(caller.sessionId, [surface.name, surface.id]) ?? [],
        ...(guard === undefined ? {} : { guard }),
      },
    );
  }

  /**
   * A paste into one field of a page the agent opened: the same input request a `browser.request_input` field
   * raises, with the copy as its value, so the page's observed facts, digest, guarded write and hold all apply.
   */
  private async pasteToPage(
    sessionId: string,
    caller: AgentToolCaller,
    call: Extract<AgentToolCall, { readonly tool: 'secure.paste' }>,
    to: Extract<Extract<AgentToolCall, { readonly tool: 'secure.paste' }>['to'], { readonly kind: 'browser' }>,
    name: string,
    facts: CallFacts,
  ): Promise<AgentToolResult> {
    const surface = await this.resolve(sessionId, 'browser', to.name);
    facts.surface = surface;
    await this.assertAgentMay(sessionId, surface);
    const reference = surfaceReference('browser', surface.name ?? surface.id);
    const view = await this.inputPort(caller).raise(sessionId, {
      target: { kind: 'browser', key: surface.name ?? surface.id },
      prompt: call.prompt,
      fields: [
        {
          id: 'value',
          sensitivity: 'secret',
          element:
            to.ref === undefined
              ? { kind: 'selector' as const, selector: to.selector ?? '' }
              : { kind: 'ref' as const, ref: to.ref },
        },
      ],
      submit: call.submit ?? 'offer-owner',
      source: { kind: 'sealed', name },
      ...(call.expiresInSeconds === undefined ? {} : { expiresInSeconds: call.expiresInSeconds }),
    });
    return {
      summary:
        view.state === 'delivered'
          ? `Pasted ${copyHandle(name)} into a field on ${reference} under a rule the owner approved in advance (!${view.id}). Screenshots of the page are withheld for a while.`
          : `Asked the owner to allow pasting ${copyHandle(name)} into a field on ${reference} (!${view.id}). Wait with input.wait; do not type there yourself.`,
      input: view,
    };
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

  private approvalPort(caller: AgentToolCaller): AgentPhoneApprovalPort {
    if (caller.kind !== 'agent')
      throw new AgentToolError('bad_request', 'Only an agent raises or waits on a phone approval.');
    if (this.ports.phoneApprovals === undefined)
      throw new AgentToolError('unavailable', 'Approving a sign-in on the phone is not available on this machine.');
    return this.ports.phoneApprovals;
  }

  /**
   * A push approval (`push: true` on a request tool): the owner approves on their phone and nothing is typed. The
   * call's hints are handed on as the raise schema takes them; the card is the daemon's own.
   */
  private async approval(
    caller: AgentToolCaller,
    call: Extract<AgentToolCall, { readonly push: true }>,
    surface: ResolvedSurface,
    reference: string,
  ): Promise<AgentToolResult> {
    const port = this.approvalPort(caller);
    const raise = PhoneApprovalRaiseSchema.parse({
      target: { kind: call.tool === 'browser.request_input' ? 'browser' : 'terminal', key: surface.name ?? surface.id },
      ...(call.secretHint === undefined ? {} : { secretHint: call.secretHint }),
      ...(call.factor === undefined ? {} : { factor: call.factor }),
      ...(call.waitSeconds === undefined ? {} : { waitSeconds: call.waitSeconds }),
    });
    const view = await port.raise(caller.sessionId, caller.kind === 'agent' ? caller.name : undefined, raise);
    return {
      summary: `Asked the owner to approve the sign-in on their phone (${view.id}) for ${reference}. Wait with input.wait on ${view.id}; never tell the owner a number.`,
      phoneApproval: view,
    };
  }

  private planPort(caller: AgentToolCaller): AgentPlanPort {
    if (caller.kind !== 'agent')
      throw new AgentToolError('bad_request', 'Only an agent asks for sign-ins and pastes to be approved in advance.');
    if (this.ports.plans === undefined)
      throw new AgentToolError('unavailable', 'Task plans are not available on this daemon.');
    return this.ports.plans;
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

  /**
   * The sign-ins for a site, one line each, by non-secret metadata only (`AccountHintSchema`): who, which sign-in (its
   * `si_…`, what `account_propose` names), how, where, why it is first and what was seen. For a page, the site is
   * where the page IS as the browser reports it, not what the agent says; the page must be one the agent may use.
   * The answer is the summary only: the structured hint is `GET /v1/accounts/hint`'s, and an `fy` from before
   * sign-ins reads a result strictly, so it is given no field it does not know.
   */
  private async loginHint(
    caller: AgentToolCaller,
    call: Extract<AgentToolCall, { readonly tool: 'account.hint' }>,
    facts: CallFacts,
  ): Promise<AgentToolResult> {
    const accounts = this.ports.accounts;
    if (accounts === undefined) throw new AgentToolError('unavailable', 'This daemon keeps no accounts.');
    let where = call.site;
    if (call.name !== undefined) {
      const pages = (await this.ports.browser.status(caller.sessionId)).pages;
      const surface = await this.resolve(caller.sessionId, 'browser', call.name);
      facts.surface = surface;
      if (caller.kind === 'agent') await this.assertAgentMay(caller.sessionId, surface, pages);
      where = pages.find(page => page.id === surface.id)?.url;
    }
    const site = where === undefined ? undefined : loginHintSite(where);
    if (site === undefined)
      throw new AgentToolError(
        'bad_request',
        call.name === undefined
          ? 'Name a site as a host like github.com, or a URL.'
          : 'That page is not on a site yet; navigate it first, or name the site.',
      );
    const listing = await accounts.list().catch(() => {
      throw new AgentToolError(
        'unavailable',
        'The accounts cannot be read right now; ask the owner to check Settings.',
      );
    });
    // A recipe is masked at READ time too: a value kept after it was written must reach the ferret as a mask. Where
    // nothing can mask it, the ferret gets no recipe at all.
    const recipes = this.ports.recipes;
    const masked =
      recipes === undefined
        ? {
            accounts: listing.accounts,
            signIns: listing.signIns.map(
              ({ recipe: _recipe, recipeBy: _by, recipeVersion: _version, proposals: _proposals, ...signIn }) => signIn,
            ),
          }
        : await recipes.scrubbedAccounts(listing);
    // Asked with no ferret hint: a hint's "default" is only ever the daemon's own choice among the matched sign-ins,
    // ordered by the CALLING session's project and folder (never one the ferret names) and the owner's defaults.
    const order = await this.ports.signInChoice?.of(caller.sessionId).catch(() => undefined);
    return { summary: accountHintSummary(site, accountHintsFor(site, masked, order)) };
  }

  /**
   * A ferret's suggested recipe for one SIGN-IN (`account.propose`). The older `{ login }` is resolved to that
   * account's only sign-in first, so every check runs on the canonical sign-in, and the audit record names it. It changes
   * nothing the owner has not allowed: it waits on a card, unless the owner turned auto-apply on for that sign-in.
   */
  private async loginPropose(
    caller: AgentToolCaller,
    call: Extract<AgentToolCall, { readonly tool: 'account.propose' }>,
    facts: CallFacts,
  ): Promise<AgentToolResult> {
    const recipes = this.ports.recipes;
    if (call.recipe !== undefined && recipes === undefined)
      throw new AgentToolError('unavailable', 'This daemon keeps no recipes.');
    if (call.preapprove === true && this.ports.ruleSuggestions === undefined)
      throw new AgentToolError('unavailable', 'This daemon keeps no standing-rule suggestions.');
    const target: RecipeProposalTarget =
      call.signIn === undefined ? { login: call.login as string } : { signIn: call.signIn };
    let filed: string | undefined;
    let recipeSignIn: string | undefined;
    let recipeResult: Pick<AgentToolResult, 'recipe'> = {};
    if (call.recipe !== undefined && recipes !== undefined) {
      let proposed: LoginRecipeProposed & { readonly signIn: string };
      try {
        proposed = await recipes.propose(caller.sessionId, target, call.recipe, call.why);
      } catch (error) {
        if (error instanceof LoginEntryError || error instanceof RecipeValueError)
          throw new AgentToolError(
            error instanceof LoginEntryError &&
              (error.refusal === 'unknown_login' || error.refusal === 'unknown_sign_in')
              ? 'not_found'
              : 'bad_request',
            error.message,
          );
        throw new AgentToolError('unavailable', 'The recipe could not be filed right now; try again later.');
      }
      const { signIn, ...recipe } = proposed;
      recipeSignIn = signIn;
      facts.detail = { ...facts.detail, signIn };
      const where = `${proposed.login} [${signIn}]`;
      filed =
        proposed.state === 'applied'
          ? `The recipe of ${where} was updated (the owner allows that for this sign-in).`
          : `Proposed a recipe for ${where}${proposed.agendaItemId === undefined ? '' : ` (!${proposed.agendaItemId})`}; the owner approves or declines it. You do not need to wait.`;
      recipeResult = { recipe };
    }
    if (call.preapprove !== true) return { summary: filed ?? '', ...recipeResult };
    const suggested = await this.suggestRule(caller.sessionId, call, recipeSignIn === undefined);
    if (suggested.signIn !== undefined) facts.detail = { ...facts.detail, signIn: suggested.signIn };
    return { summary: [filed, suggested.words].filter(word => word !== undefined).join(' '), ...recipeResult };
  }

  /**
   * The owner is asked to consider a standing rule: a card, nothing more. The words say only what the ferret did, never
   * whether a rule exists or why one could not be made. When a recipe was filed in the same call, a refusal here is said
   * in the summary rather than thrown, so the filed recipe is not reported as failed.
   */
  private async suggestRule(
    sessionId: string,
    call: Extract<AgentToolCall, { readonly tool: 'account.propose' }>,
    only: boolean,
  ): Promise<{ readonly words: string; readonly signIn?: string }> {
    const port = this.ports.ruleSuggestions;
    if (port === undefined) return { words: '' };
    try {
      const made = await port.suggest(sessionId, { signIn: call.signIn, login: call.login, why: call.why });
      return {
        signIn: made.signIn,
        words: `Suggested a standing rule for ${made.host} (!${made.agenda}); the owner decides, and you will not hear back. Do not ask again.`,
      };
    } catch (error) {
      if (!(error instanceof SignInRuleSuggestionError)) {
        if (only)
          throw new AgentToolError('unavailable', 'The suggestion could not be raised right now; try again later.');
        return { words: 'The suggestion could not be raised right now.' };
      }
      if (only) throw new AgentToolError(error.code, error.message);
      return { words: `No rule was suggested: ${error.message}` };
    }
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
    const kind = surface?.surface ?? kindOf(call);
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
      return call.push === true ? { push: true } : { sensitivity: call.sensitivity };
    case 'browser.request_input':
      return call.push === true
        ? { push: true }
        : { sensitivity: strongestSensitivity(call.fields), fields: call.fields.length };
    case 'input.wait':
      return { timeoutMs: call.timeoutMs ?? AGENT_TOOL_DEFAULT_WAIT_MS };
    case 'account.hint':
      return { from: call.name === undefined ? 'site' : 'page' };
    case 'account.propose':
      // The sign-in (or the older account handle) only; the recipe is the ferret's text and stays out of the record.
      // A resolved handle's sign-in is added once it is known (loginPropose).
      return call.signIn === undefined ? { login: call.login ?? '' } : { signIn: call.signIn };
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
    case 'task.plan':
      // The count only: a site, a sign-in or a reason is the plan's own record, not the tool audit's.
      return { lines: call.lines.length };
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
  call: Exclude<
    Extract<AgentToolCall, { readonly tool: 'terminal.request_input' | 'browser.request_input' }>,
    { readonly push: true }
  >,
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
      : copy.exposure.pageReadBeforeCapture === true
        ? ' WARNING: you read this page before sealing it, so the value may already be in your context; tell the owner it may need rotating.'
        : '';
  const page =
    copy.from.kind === 'browser'
      ? ' The page is not pictured until it shows another document; its text reads come back masked.'
      : '';
  return `Sealed ${plural(copy.length, 'character')} from ${from} as ${copy.handle}, until ${copy.expiresAt}. You cannot read it; paste it by handle.${page}${seen}`;
}

/** Where a phone approval stands, in one sentence an agent can act on: never its number. */
function approvalSummary(view: PhoneApprovalAgentView): string {
  switch (view.state) {
    case 'waiting':
      return `${view.id} is still waiting for the owner to approve on their phone. Wait again with input.wait; do not act on that page or terminal meanwhile.`;
    case 'moved-on':
      return view.secondFactor === 'push'
        ? `${view.id}: the sign-in went through after a push. Read the page or terminal and carry on.`
        : `${view.id}: the sign-in moved on. Read the page or terminal to see where it is.`;
    case 'timed-out':
      return `${view.id} ran out of time without the sign-in moving on. Ask again only if the site sent a new push.`;
    case 'refused':
      return `${view.id}: the owner did not expect this sign-in and said "Not me". Stop signing in there and do not ask again.`;
    case 'gone':
      return `${view.id} ended: the page or terminal closed.`;
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

/** What a page act did to who the page signs in: named someone, changed nothing, or may have changed it unseen. */
type IdentityAfter = 'keep' | 'clear' | { readonly host: string; readonly username: string };

/** The rules {@link AgentToolService.noteIdentity} applies, decided from the call and what the browser saw it do. */
function identityAfter(
  call: Extract<AgentToolCall, { readonly tool: PageToolName }>,
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

/** The page acts that cannot change who a page signs in: it is kept through them (typed-identities.ts). */
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

/** Every string in a result, masked; a picture's base64 bytes are not text and pass as they are. */
function masked(value: unknown, scrub: (text: string) => string): unknown {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map(item => masked(item, scrub));
  // Only plain objects are walked: anything else (bytes, a class) is passed as it is.
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, key === 'screenshotBase64' ? item : masked(item, scrub)]),
  );
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
