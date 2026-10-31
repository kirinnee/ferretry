import {
  AGENT_LESSONS_PATH,
  AGENT_TOOL_MAX_TOTAL_WAIT_MS,
  AGENT_TOOL_MAX_WAIT_MS,
  type AgentConfigToolCall,
  type AgentConfigToolResult,
  AgentConfigToolResultSchema,
  type AgentLessonToolCall,
  type AgentLessonToolResult,
  AgentLessonToolResultSchema,
  type AgentToolCall,
  type AgentToolResult,
  AgentToolResultSchema,
  type IFyApiClient,
  type SurfaceControlView,
  SurfaceControlViewSchema,
  type SurfaceKind,
} from '@ferretry/protocol';
import { FY_CLIENT_HEADER, FY_CLIENT_NAME, FY_SESSION_ID_HEADER } from '../session/connection.ts';

/**
 * Where the agent presents its session credential. Duplicated from the daemon's mount on purpose: the
 * CLI may import `@ferretry/protocol` and nothing else from the monorepo, and the protocol package is
 * what a browser bundle is built from — no browser ever sends this.
 */
const AGENT_SESSION_CAPABILITY_HEADER = 'x-fy-session-capability';

/** The one daemon call these tools make. `IFyApiClient` satisfies it structurally. */
export type IAgentToolsGateway = Pick<IFyApiClient, 'request'>;

/**
 * Two ways to the daemon, because an agent and a person are two different authorities: the agent's
 * carries only its session credential (no host token), the person's is the ordinary CLI client.
 */
export interface AgentToolsGateways {
  readonly agent: IAgentToolsGateway;
  readonly person: IAgentToolsGateway;
}

/** What the environment tells the tools about who is calling. Read by the composition root. */
export interface AgentToolsEnvironment {
  /** `FY_SESSION_BOARD_CAPABILITY`: the calling agent session's own credential, when there is one. */
  readonly capability?: string;
  /** `FY_SESSION_ID`: the session this CLI runs inside, sent as an attribution so a person's route can
   *  refuse an agent that names a session. */
  readonly ownSessionId?: string;
}

/** Raised when a command cannot be sent at all as asked. Its message is what the caller is shown. */
export class AgentToolsCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentToolsCommandError';
  }
}

/** A `terminal.wait` as a caller asks for it: one condition and a total budget. */
export interface TerminalWait {
  readonly name: string;
  readonly text?: string;
  readonly exit?: true;
  /** Up to {@link AGENT_TOOL_MAX_TOTAL_WAIT_MS}; the daemon is asked in slices it can hold open. */
  readonly totalMs: number;
}

/** The `browser.wait_for` call a wait is made of; its `timeoutMs` is set per slice. */
type BrowserWaitCall = Extract<AgentToolCall, { readonly tool: 'browser.wait_for' }>;

/** A `browser.wait_for` as a caller asks for it: the one thing to wait for and a total budget. */
export interface BrowserWait {
  readonly call: BrowserWaitCall;
  /** Up to {@link AGENT_TOOL_MAX_TOTAL_WAIT_MS}; ignored for a `time` wait, which is one request. */
  readonly totalMs: number;
}

/**
 * How long one tool request may take. It must outlast the longest thing the daemon does inside one:
 * a page load (the worker gives a navigation 45 s) and a held-open wait ({@link AGENT_TOOL_MAX_WAIT_MS}).
 */
const TOOL_REQUEST_TIMEOUT_MS = 60_000;

const kindOf = (call: AgentToolCall): SurfaceKind => (call.tool.startsWith('terminal.') ? 'terminal' : 'browser');

/**
 * Terminals and browser pages, driven by name — the one client `fy terminal`, `fy browser page` and
 * `fy mcp serve` share.
 *
 * WHO IT ACTS AS. With no session named, it acts as the agent session it runs inside, presenting that
 * session's own credential on the agent route — the daemon derives the session from the credential and
 * from nothing else. With a session named, it acts as a person on that session's route, which the
 * daemon refuses to an agent that identifies itself; this CLI identifies itself whenever it runs inside
 * a session.
 */
export class AgentToolsClient {
  constructor(
    private readonly gateways: AgentToolsGateways,
    private readonly environment: AgentToolsEnvironment,
  ) {}

  /** One tool call. `session` names the session a person acts on; absent, the caller is the agent. */
  async call(call: AgentToolCall, session?: string): Promise<AgentToolResult> {
    const body = JSON.stringify(call);
    // Each dial writes its verb out in full, so the route-agreement gate can prove it.
    if (session === undefined)
      return await this.gateways.agent.request(
        '/v1/agent/tools',
        AgentToolResultSchema,
        { method: 'POST', body, headers: this.agentHeaders() },
        TOOL_REQUEST_TIMEOUT_MS,
      );
    const id = encodeURIComponent(session);
    return kindOf(call) === 'browser'
      ? await this.gateways.person.request(
          `/v1/sessions/${id}/surfaces/browser/tools`,
          AgentToolResultSchema,
          { method: 'POST', body, headers: this.personHeaders() },
          TOOL_REQUEST_TIMEOUT_MS,
        )
      : await this.gateways.person.request(
          `/v1/sessions/${id}/surfaces/terminals/tools`,
          AgentToolResultSchema,
          { method: 'POST', body, headers: this.personHeaders() },
          TOOL_REQUEST_TIMEOUT_MS,
        );
  }

  /**
   * One `config.*` call (docs/config-files.md), always as the agent: there is no person's route for
   * these, because a person edits the files directly or through the app.
   */
  async config(call: AgentConfigToolCall): Promise<AgentConfigToolResult> {
    return await this.gateways.agent.request(
      '/v1/agent/config',
      AgentConfigToolResultSchema,
      { method: 'POST', body: JSON.stringify(call), headers: this.agentHeaders() },
      TOOL_REQUEST_TIMEOUT_MS,
    );
  }

  /**
   * One `lessons.suggest` call (docs/learning.md), always as the agent: the daemon derives the
   * session from the credential alone and attaches the evidence itself, so nothing here can name a
   * session or carry a quote.
   */
  async lessons(call: AgentLessonToolCall): Promise<AgentLessonToolResult> {
    return await this.gateways.agent.request(
      AGENT_LESSONS_PATH,
      AgentLessonToolResultSchema,
      { method: 'POST', body: JSON.stringify(call), headers: this.agentHeaders() },
      TOOL_REQUEST_TIMEOUT_MS,
    );
  }

  /**
   * Waits up to `totalMs` for text or for the running command to end, asking the daemon in slices of
   * at most {@link AGENT_TOOL_MAX_WAIT_MS} so no single request outlives the daemon's idle timeout.
   */
  async wait(wait: TerminalWait, session?: string): Promise<AgentToolResult> {
    let remaining = Math.min(Math.max(wait.totalMs, 100), AGENT_TOOL_MAX_TOTAL_WAIT_MS);
    for (;;) {
      const slice = Math.min(remaining, AGENT_TOOL_MAX_WAIT_MS);
      remaining -= slice;
      const result = await this.call(
        {
          tool: 'terminal.wait',
          name: wait.name,
          ...(wait.text === undefined ? { exit: true } : { text: wait.text }),
          timeoutMs: Math.max(slice, 100),
        },
        session,
      );
      if (result.matched === true || remaining <= 0) return result;
    }
  }

  /**
   * Waits up to `totalMs` for a page condition, in slices of at most {@link AGENT_TOOL_MAX_WAIT_MS}
   * like {@link wait}. A `time` wait is a plain sleep and is asked once.
   */
  async browserWait(wait: BrowserWait, session?: string): Promise<AgentToolResult> {
    if (wait.call.time !== undefined) return await this.call({ ...wait.call }, session);
    let remaining = Math.min(Math.max(wait.totalMs, 100), AGENT_TOOL_MAX_TOTAL_WAIT_MS);
    for (;;) {
      const slice = Math.min(remaining, AGENT_TOOL_MAX_WAIT_MS);
      remaining -= slice;
      const result = await this.call({ ...wait.call, timeoutMs: Math.max(slice, 100) }, session);
      if (result.matched !== false || remaining <= 0) return result;
    }
  }

  /** A person takes a surface over from the agent, or hands it back. */
  async control(
    surface: SurfaceKind,
    action: 'takeover' | 'handback' | 'handover',
    key: string,
    session: string,
  ): Promise<SurfaceControlView> {
    const id = encodeURIComponent(session);
    const body = JSON.stringify({ action, key });
    return surface === 'terminal'
      ? await this.gateways.person.request(`/v1/sessions/${id}/surfaces/terminals/control`, SurfaceControlViewSchema, {
          method: 'POST',
          body,
          headers: this.personHeaders(),
        })
      : await this.gateways.person.request(`/v1/sessions/${id}/surfaces/browser/control`, SurfaceControlViewSchema, {
          method: 'POST',
          body,
          headers: this.personHeaders(),
        });
  }

  /** Who is driving which surfaces of one kind in a session, what is taken over, and what was handed on. */
  async view(surface: SurfaceKind, session: string): Promise<SurfaceControlView> {
    const id = encodeURIComponent(session);
    return surface === 'terminal'
      ? await this.gateways.person.request(`/v1/sessions/${id}/surfaces/terminals/control`, SurfaceControlViewSchema, {
          method: 'GET',
          headers: this.personHeaders(),
        })
      : await this.gateways.person.request(`/v1/sessions/${id}/surfaces/browser/control`, SurfaceControlViewSchema, {
          method: 'GET',
          headers: this.personHeaders(),
        });
  }

  private agentHeaders(): Record<string, string> {
    const capability = this.environment.capability?.trim() ?? '';
    if (capability === '')
      throw new AgentToolsCommandError(
        'no agent session credential here (FY_SESSION_BOARD_CAPABILITY is unset): run this inside an agent session, or pass --session <id> to act on a session yourself',
      );
    return { 'content-type': 'application/json', [AGENT_SESSION_CAPABILITY_HEADER]: capability };
  }

  private personHeaders(): Record<string, string> {
    const own = this.environment.ownSessionId?.trim() ?? '';
    return {
      'content-type': 'application/json',
      [FY_CLIENT_HEADER]: FY_CLIENT_NAME,
      ...(own === '' ? {} : { [FY_SESSION_ID_HEADER]: own }),
    };
  }
}
