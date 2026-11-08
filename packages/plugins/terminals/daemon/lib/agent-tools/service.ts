import type { InputRaise, InputRequestId } from '@ferretry/core-vault/contract';
import type { Ack, Content, HoldRefusal, Op, RedactionScope, ResultOf } from '@ferretry/kernel/contract';
import type { Result } from '@ferretry/std';
import {
  AGENT_TOOL_DEFAULT_READ_LINES,
  AGENT_TOOL_DEFAULT_WAIT_MS,
  type SurfaceControlRequest,
  type SurfaceOpener,
  type TerminalKey,
} from '../../../contract/index.ts';
import type { SurfaceController, SurfaceControlView } from '../protocol/surface-control.ts';
import { TerminalMountError, type TerminalSubsystem } from '../runtime/mounts/terminals.ts';
import type { SurfaceControl } from './control.ts';
import { clipOutput, isShellForeground, surfaceReference, terminalInput } from './policy.ts';
import type { AgentToolCaller, AgentToolClock, ResolvedSurface } from './types.ts';

/**
 * THE TERMINAL AGENT TOOLS (today's `AgentToolService`, the `terminal.*` half; the page half is Browsers').
 *
 * ONE PATH FOR EVERY CALLER, AND EVERY CHECK ON IT. An agent and a person reach the same method; what differs is
 * decided from the {@link AgentToolCaller} the kernel derived, never from the call:
 *
 * 1. the terminal is looked up inside the caller's own ferret only — a name from another ferret is simply not there;
 * 2. an agent acts only on a terminal IT opened, or one a person handed to it;
 * 3. an agent is refused a terminal a person has taken over — that one terminal only;
 * 4. EVERY ACT GOES THROUGH THE KERNEL'S ACT RUNNER (§4.7): the Vault's holds are asked inside the terminal's queue
 *    immediately before the act, so a quarantine or a pending input card cannot be skipped; a write answers an Ack;
 * 5. every screen text that leaves is masked inside ONE `Redaction.read`, before it is matched or clipped (I103);
 * 6. one audit record (`agent.tool`, the descriptor's) names the tool and the terminal, never the text.
 */

/** How often a wait looks again. */
const AGENT_TOOL_POLL_MS = 250;
const WAIT_SEARCH_LINES = 500;
const WAIT_TAIL_LINES = 40;
/** The one field a single-value terminal card has (today's `INPUT_SINGLE_FIELD_ID`). */
const INPUT_SINGLE_FIELD_ID = 'value';

class AgentToolError extends Error {
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

/** A call, as each tool's input schema parsed it (`contract/wire.ts`), with its tool named. */
export type TerminalToolCall =
  | { readonly tool: 'terminal.list' }
  | {
      readonly tool: 'terminal.open';
      readonly name: string;
      readonly folder?: string;
      readonly command?: string;
      readonly askOwner?: true | string;
    }
  | { readonly tool: 'terminal.send'; readonly name: string; readonly text?: string; readonly keys?: TerminalKey[] }
  | { readonly tool: 'terminal.read'; readonly name: string; readonly lines?: number }
  | {
      readonly tool: 'terminal.wait';
      readonly name: string;
      readonly text?: string;
      readonly exit?: true;
      readonly timeoutMs?: number;
    }
  | { readonly tool: 'terminal.close'; readonly name: string }
  | { readonly tool: 'terminal.ask_owner'; readonly name: string; readonly message?: string }
  | {
      readonly tool: 'terminal.request_input';
      readonly name: string;
      readonly raise: Omit<InputRaise, 'target'>;
    };

/** One terminal as an agent lists it. */
export interface AgentSurface {
  readonly id: string;
  readonly name?: string;
  readonly title: string;
  readonly available?: true;
}

/** What a tool answers: a sentence, and the masked output or listing it read. */
export interface AgentToolResult {
  readonly summary: string;
  readonly output?: string;
  readonly surfaces?: readonly AgentSurface[];
  readonly matched?: boolean;
  readonly input?: { readonly id: InputRequestId };
}

/** The act runner, bound to one terminal (`kernel.act` with the terminal's id as the target key). */
type TerminalAct = <O extends Op>(
  terminalId: string,
  op: O,
  fn: () => Promise<ResultOf<O>>,
) => Promise<Result<ResultOf<O>, HoldRefusal>>;

export interface TerminalToolPorts {
  readonly terminals: Pick<TerminalSubsystem, 'list' | 'create' | 'write' | 'text' | 'foreground' | 'close'>;
  readonly control: SurfaceControl;
  readonly act: TerminalAct;
  /** One masking read (§7.3). */
  readonly read: <T>(fn: (scope: RedactionScope) => T) => Promise<T>;
  readonly clock: AgentToolClock;
  readonly sleep: (milliseconds: number) => Promise<void>;
  /** Raises an input card through the Vault (I68: the only way a ferret gets a password typed). Not an act. */
  readonly raiseInput?: (ferret: string, raise: InputRaise) => Promise<Result<InputRequestId, string>>;
}

const DONE: Ack = { status: 'done' };

const openedByAgent = (openedBy: SurfaceOpener | undefined, sessionId: string): boolean =>
  openedBy?.by === 'agent' && openedBy.sessionId === sessionId;

const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? '' : 's'}`;

const handedNote = (askOwner: true | string | undefined): string =>
  askOwner === undefined ? '' : ' and asked the owner to take over (wait for them)';

/** The text a reading act returns, masked: what the agent may see (I103). */
function maskedText(scope: RedactionScope, text: string): string {
  return scope.text(text);
}

/**
 * Whether a wait for text is over, decided on the MASKED screen (I103): a value the daemon just typed is masked BEFORE
 * the match, so neither "matched" nor "not matched" can tell the agent whether a guess is in the hidden text.
 */
function waitMatches(scope: RedactionScope, screen: string, needle: string): boolean {
  return scope.text(screen).includes(needle);
}

export class TerminalToolService {
  constructor(private readonly ports: TerminalToolPorts) {}

  async call(caller: AgentToolCaller, call: TerminalToolCall): Promise<AgentToolResult> {
    try {
      return await this.dispatch(caller, call);
    } catch (error) {
      throw translate(error) ?? error;
    }
  }

  /** Every live driving marker, standing takeover and hand-over of terminals in one ferret. */
  async controlView(sessionId: string): Promise<SurfaceControlView> {
    return await this.alive(sessionId, await this.ports.control.view(sessionId, 'terminal'));
  }

  /** A person takes a terminal over from the agent, hands it back, or hands it to the agent. */
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

  private async dispatch(caller: AgentToolCaller, call: TerminalToolCall): Promise<AgentToolResult> {
    const { sessionId } = caller;
    if (call.tool === 'terminal.list') return await this.listTerminals(caller);
    if (call.tool === 'terminal.open') {
      const opened = await this.ports.terminals.create(
        sessionId,
        { name: call.name, ...(call.folder === undefined ? {} : { folder: call.folder }) },
        caller.kind === 'agent' ? { by: 'agent', sessionId } : caller.openedBy,
      );
      const surface: ResolvedSurface = { surface: 'terminal', id: opened.id, name: call.name };
      if (call.command !== undefined) {
        const command = call.command;
        await this.acted(
          await this.ports.act(opened.id, 'keys', async () => {
            await this.ports.terminals.write(sessionId, opened.id, terminalInput(command, ['enter']));
            return DONE;
          }),
          surface,
          caller,
        );
      }
      await this.drove(caller, surface);
      await this.announce(caller, surface, call.askOwner);
      return {
        summary: `Opened ${surfaceReference('terminal', call.name)}${call.command === undefined ? '' : ' and started the command'}${handedNote(call.askOwner)}.`,
      };
    }
    const surface = await this.resolve(sessionId, call.name);
    if (caller.kind === 'agent') await this.assertAgentMay(sessionId, surface);
    const reference = surfaceReference('terminal', surface.name ?? surface.id);
    switch (call.tool) {
      case 'terminal.send': {
        const { text, keys } = call;
        await this.acted(
          await this.ports.act(surface.id, 'keys', async () => {
            await this.ports.terminals.write(sessionId, surface.id, terminalInput(text, keys));
            return DONE;
          }),
          surface,
          caller,
        );
        await this.drove(caller, surface);
        const parts = [
          ...(text === undefined ? [] : [plural(text.length, 'character')]),
          ...(keys === undefined ? [] : [plural(keys.length, 'key')]),
        ];
        return { summary: `Sent ${parts.join(' and ')} to ${reference}.` };
      }
      case 'terminal.read': {
        const lines = call.lines ?? AGENT_TOOL_DEFAULT_READ_LINES;
        const output = clipOutput(await this.readText(caller, surface, 'read', lines));
        return { summary: `The last ${plural(lines, 'line')} of ${reference}.`, output };
      }
      case 'terminal.wait':
        return await this.untilMatched(caller, call, surface, reference);
      case 'terminal.request_input': {
        if (caller.kind !== 'agent')
          throw new AgentToolError(
            'bad_request',
            'Only an agent asks its owner for a value; you already have the terminal.',
          );
        if (this.ports.raiseInput === undefined)
          throw new AgentToolError('unavailable', 'Input requests are not available on this machine.');
        const raised = await this.ports.raiseInput(sessionId, {
          ...call.raise,
          target: { kind: 'terminal', key: surface.name ?? surface.id },
        } as InputRaise);
        if (!raised.ok) throw new AgentToolError('conflict', raised.error);
        return {
          summary: `Asked the owner for the value (!${raised.value}) for ${reference}. Wait with input.wait; do not type there yourself.`,
          input: { id: raised.value },
        };
      }
      case 'terminal.ask_owner':
        if (caller.kind !== 'agent')
          throw new AgentToolError('bad_request', 'Only an agent hands a surface to its owner; you already have it.');
        await this.announce(caller, surface, call.message ?? true, true);
        return {
          summary: `Asked the owner to take over ${reference}${call.message === undefined ? '' : ' and told them what to do'}. Wait for them: read the surface to see when they are done.`,
        };
      case 'terminal.close':
        await this.acted(
          await this.ports.act(surface.id, 'close', async () => {
            await this.ports.terminals.close(sessionId, surface.id);
            return DONE;
          }),
          surface,
          caller,
        );
        this.ports.control.forget(sessionId, surface);
        return { summary: `Closed ${reference}.` };
    }
  }

  /**
   * Waits, inside one bounded request, for text to appear or for the running command to end.
   *
   * THE FIRST LOOK IS ONE POLL INTERVAL LATER, not immediately: a wait for `exit` sent straight after a command would
   * otherwise look before the shell has even started it. An agent's wait also stops the moment a person takes the
   * terminal over. Each look is an act (`wait`): a hold that began since the last look refuses it.
   */
  private async untilMatched(
    caller: AgentToolCaller,
    call: Extract<TerminalToolCall, { readonly tool: 'terminal.wait' }>,
    surface: ResolvedSurface,
    reference: string,
  ): Promise<AgentToolResult> {
    const { sessionId } = caller;
    const deadline = this.ports.clock.now() + (call.timeoutMs ?? AGENT_TOOL_DEFAULT_WAIT_MS);
    const tail = async (): Promise<string> => clipOutput(await this.readText(caller, surface, 'wait', WAIT_TAIL_LINES));
    for (;;) {
      await this.ports.sleep(AGENT_TOOL_POLL_MS);
      if (caller.kind === 'agent') await this.assertFree(sessionId, surface);
      const needle = call.text;
      const matched: boolean | 'closed' =
        needle === undefined
          ? await this.ended(caller, surface)
          : this.matched(
              await this.ports.act(surface.id, 'wait', async () => {
                const screen = await this.ports.terminals.text(sessionId, surface.id, WAIT_SEARCH_LINES);
                return await this.ports.read(scope => ({
                  kind: 'content' as const,
                  data: { matched: waitMatches(scope, screen, needle) },
                }));
              }),
              surface,
              caller,
            );
      if (matched === 'closed') return { summary: `${reference} closed while waiting.`, matched: true };
      if (matched) {
        const what = call.text === undefined ? 'The command ended' : 'The text appeared';
        return { summary: `${what} in ${reference}.`, matched: true, output: await tail() };
      }
      if (this.ports.clock.now() >= deadline)
        return { summary: `Still waiting on ${reference}: the wait timed out.`, matched: false, output: await tail() };
    }
  }

  private matched(answer: Result<Content, HoldRefusal>, surface: ResolvedSurface, caller: AgentToolCaller): boolean {
    const content = this.acted(answer, surface, caller);
    return (content.data as { readonly matched?: unknown } | undefined)?.matched === true;
  }

  /** The screen text a caller may be given: read inside the act, masked inside one redaction read. */
  private async readText(
    caller: AgentToolCaller,
    surface: ResolvedSurface,
    op: 'read' | 'wait',
    lines: number,
  ): Promise<string> {
    const answer = await this.ports.act(surface.id, op, async () => {
      const text = await this.ports.terminals.text(caller.sessionId, surface.id, lines);
      return await this.ports.read(scope => ({ kind: 'content' as const, text: maskedText(scope, text) }));
    });
    return this.acted(answer, surface, caller).text ?? '';
  }

  /** The act's answer, or the hold that refused it in this domain's words (I72). */
  private acted<T>(answer: Result<T, HoldRefusal>, surface: ResolvedSurface, caller: AgentToolCaller): T {
    if (answer.ok) return answer.value;
    const reference = surfaceReference('terminal', surface.name ?? surface.id);
    switch (answer.error.refused) {
      case 'quarantined':
      case 'held':
        throw new AgentToolError(
          'conflict',
          caller.kind === 'agent'
            ? `${reference} is quarantined: the owner's secret was just typed there, so you cannot read it for a short while. You can still send keys. Try again shortly, or ask the owner.`
            : `${reference} is quarantined: a secret was just typed there. End the quarantine from its input card, or try again shortly.`,
        );
      case 'input_pending':
        throw new AgentToolError(
          'conflict',
          `an input request is pending on ${reference}; wait for it (input.wait) and do not type there yourself`,
        );
      case 'target_gone':
        throw new AgentToolError('not_found', `There is no ${reference} in this session any more.`);
      default:
        throw new AgentToolError('unavailable', `${reference} cannot be acted on right now (${answer.error.refused}).`);
    }
  }

  /** Whether the shell is back in the foreground — or the terminal itself is gone. */
  private async ended(caller: AgentToolCaller, surface: ResolvedSurface): Promise<boolean | 'closed'> {
    try {
      // The foreground program's name is pane-derived, so it is read as an act too.
      const answer = await this.ports.act(surface.id, 'wait', async () => {
        const foreground = await this.ports.terminals.foreground(caller.sessionId, surface.id);
        return { kind: 'content' as const, data: { matched: isShellForeground(foreground) } };
      });
      return this.matched(answer, surface, caller);
    } catch (error) {
      if (error instanceof TerminalMountError && error.code === 'not_found') return 'closed';
      throw error;
    }
  }

  private async listTerminals(caller: AgentToolCaller): Promise<AgentToolResult> {
    const listing = await this.ports.terminals.list(caller.sessionId);
    const rows = await Promise.all(
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
    const surfaces = rows.filter((row): row is AgentSurface => row !== undefined);
    if (surfaces.length === 0) return { summary: 'No terminals are open for you in this session.', surfaces };
    const names = surfaces.map(entry => surfaceReference('terminal', entry.name ?? entry.id)).join(', ');
    return { summary: `${plural(surfaces.length, 'terminal')}: ${names}.`, surfaces };
  }

  private async listed(
    caller: AgentToolCaller,
    row: ResolvedSurface & { readonly title: string },
  ): Promise<AgentSurface | undefined> {
    const base: AgentSurface = { id: row.id, ...(row.name === undefined ? {} : { name: row.name }), title: row.title };
    if (caller.kind !== 'agent') return base;
    const available = await this.assertAgentMay(caller.sessionId, row).then(
      () => true,
      () => false,
    );
    return available ? { ...base, available } : undefined;
  }

  private async resolve(sessionId: string, key: string): Promise<ResolvedSurface> {
    const { terminals } = await this.ports.terminals.list(sessionId);
    const found = terminals.find(candidate => candidate.name === key || candidate.id === key);
    if (found === undefined)
      throw new AgentToolError(
        'not_found',
        `There is no ${surfaceReference('terminal', key)} in this session. List them with terminal.list, or open one with terminal.open.`,
      );
    return {
      surface: 'terminal',
      id: found.id,
      ...(found.name === undefined ? {} : { name: found.name }),
      ...(found.openedBy === undefined ? {} : { openedBy: found.openedBy }),
    };
  }

  /** Whether an agent may act on this terminal now: it is the agent's, and nobody is holding it. */
  private async assertAgentMay(sessionId: string, surface: ResolvedSurface): Promise<void> {
    const mine = openedByAgent(surface.openedBy, sessionId) || (await this.ports.control.isHanded(sessionId, surface));
    if (!mine)
      throw new AgentToolError(
        'forbidden',
        `${surfaceReference('terminal', surface.name ?? surface.id)} is a person's, not yours: you may use it only if they hand it to you. Ask them, or open your own.`,
      );
    await this.assertFree(sessionId, surface);
  }

  /** Whether a person holds THIS terminal. Holding one terminal holds nothing else. */
  private async assertFree(sessionId: string, surface: ResolvedSurface): Promise<void> {
    const takeover = await this.ports.control.takeoverOf(sessionId, surface);
    if (takeover === undefined) return;
    throw new AgentToolError(
      'taken_over',
      `A person has taken over ${surfaceReference('terminal', surface.name ?? surface.id)}; wait or ask them.`,
    );
  }

  private async drove(caller: AgentToolCaller, surface: ResolvedSurface): Promise<void> {
    if (caller.kind !== 'agent') return;
    // The marker is a courtesy to the person watching; a store that cannot take it must not fail an act that
    // already happened.
    await this.ports.control
      .drove(caller.sessionId, surface, caller.name === undefined ? {} : { name: caller.name })
      .catch(() => undefined);
  }

  /**
   * Tells the owner's workspace about a terminal the AGENT opened (a tab appears) and, when it asked for them, hands
   * it over ("your turn here"). An explicit ask's failure is the agent's to hear about.
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

  /** What is still alive: a close is not kept, so a gone terminal must not keep a tab or an ask. */
  private async alive(sessionId: string, view: SurfaceControlView): Promise<SurfaceControlView> {
    if (view.opened.length === 0 && view.asked.length === 0) return view;
    const live = new Set((await this.ports.terminals.list(sessionId)).terminals.map(row => row.id));
    return {
      ...view,
      opened: view.opened.filter(entry => live.has(entry.id)),
      asked: view.asked.filter(entry => live.has(entry.id)),
    };
  }
}

/** The terminals' own refusals, in this domain's words — or nothing, for a genuine defect. */
function translate(error: unknown): AgentToolError | undefined {
  if (error instanceof AgentToolError) return error;
  if (error instanceof TerminalMountError) return new AgentToolError(error.code, error.message);
  return undefined;
}

export { INPUT_SINGLE_FIELD_ID };
