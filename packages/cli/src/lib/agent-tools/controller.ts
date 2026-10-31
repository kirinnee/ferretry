import {
  AGENT_TOOL_MAX_TOTAL_WAIT_MS,
  type AgentToolResult,
  AgentToolCallSchema,
  type SurfaceControlView,
  type SurfaceKind,
} from '@ferretry/protocol';
import type { IBrowserIo, IScreenshotWriter } from '../browser/types.ts';
import { type AgentToolsClient, AgentToolsCommandError, type TerminalWait } from './client.ts';

/** One `fy terminal …` / `fy browser page …` invocation, as the command surface hands it over. */
export type AgentToolsCommand =
  | {
      readonly kind: 'call';
      /** The tool call as typed — validated here against the wire's own schema before anything is sent. */
      readonly call: Readonly<Record<string, unknown>>;
      readonly session?: string;
      /** `browser page screenshot`: where to write the PNG. */
      readonly screenshotTo?: string;
    }
  | { readonly kind: 'wait'; readonly wait: TerminalWait; readonly session?: string }
  | {
      readonly kind: 'browser-wait';
      /** The `browser.wait_for` fields as typed, without `tool` or `timeoutMs`. */
      readonly call: Readonly<Record<string, unknown>>;
      readonly totalMs: number;
      readonly session?: string;
    }
  | {
      readonly kind: 'control';
      readonly surface: SurfaceKind;
      readonly action: 'takeover' | 'handback' | 'handover';
      readonly key: string;
      readonly session?: string;
    }
  | { readonly kind: 'view'; readonly surface: SurfaceKind; readonly session?: string };

export interface IAgentToolsRunner {
  run(command: AgentToolsCommand): Promise<number>;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A surface as a reader writes it. */
const reference = (surface: SurfaceKind, id: string, name: string | undefined): string => `%${surface}:${name ?? id}`;

/** A tool's answer as lines: what happened, what is open, then whatever it read. */
export function renderToolResult(result: AgentToolResult): string {
  const lines = [result.summary];
  for (const surface of result.surfaces ?? [])
    lines.push(
      `  ${surface.name ?? surface.id}  ${surface.title}${surface.url === undefined ? '' : `  ${surface.url}`}${surface.openerId === undefined ? '' : `  (popup of ${surface.openerId})`}${surface.available === false ? '  [not yours]' : ''}`,
    );
  if (result.output !== undefined && result.output !== '') lines.push(result.output);
  return lines.join('\n');
}

/** Who is driving what, and what a person holds. */
export function renderControlView(view: SurfaceControlView): string {
  const lines: string[] = [];
  for (const driving of view.driving)
    lines.push(
      `${reference(driving.surface, driving.id, driving.name)}  driven by ${driving.agentName ?? driving.agentSessionId} until ${driving.until}`,
    );
  for (const takeover of view.takeovers)
    lines.push(
      `${reference(takeover.surface, takeover.id, takeover.name)}  taken over by ${takeover.by.by === 'human' ? `device ${takeover.by.deviceId}` : 'this computer'} since ${takeover.since}`,
    );
  for (const handed of view.handed)
    lines.push(
      `${reference(handed.surface, handed.id, handed.name)}  handed to the agent by ${handed.by.by === 'human' ? `device ${handed.by.deviceId}` : 'this computer'}`,
    );
  return lines.length === 0
    ? `no agent is driving anything in ${view.sessionId}, and nothing is taken over`
    : lines.join('\n');
}

/**
 * Runs the name-addressed terminal and browser verbs. Every call is checked against the wire schema
 * first, so a mistyped name or an out-of-bounds value is refused here in the schema's own words
 * rather than as a daemon 400.
 */
export class AgentToolsController implements IAgentToolsRunner {
  constructor(
    private readonly client: AgentToolsClient,
    private readonly io: IBrowserIo,
    private readonly screenshots: IScreenshotWriter,
  ) {}

  async run(command: AgentToolsCommand): Promise<number> {
    try {
      const { text, matched } = await this.execute(command);
      this.io.success(text);
      if (matched) return 0;
      this.io.setExitCode(1);
      return 1;
    } catch (error) {
      this.io.error(errorText(error));
      this.io.setExitCode(1);
      return 1;
    }
  }

  private async execute(command: AgentToolsCommand): Promise<{ readonly text: string; readonly matched: boolean }> {
    switch (command.kind) {
      case 'call': {
        const parsed = AgentToolCallSchema.safeParse(command.call);
        if (!parsed.success) throw new AgentToolsCommandError(parsed.error.issues[0]?.message ?? 'not a valid call');
        const result = await this.client.call(parsed.data, command.session);
        if (command.screenshotTo === undefined || result.screenshotBase64 === undefined)
          return { text: renderToolResult(result), matched: true };
        await this.screenshots.write(command.screenshotTo, result.screenshotBase64);
        return { text: `${result.summary}\nscreenshot written to ${command.screenshotTo}`, matched: true };
      }
      case 'wait': {
        if (!(command.wait.totalMs >= 100 && command.wait.totalMs <= AGENT_TOOL_MAX_TOTAL_WAIT_MS))
          throw new AgentToolsCommandError(
            `--timeout must be between 100 and ${String(AGENT_TOOL_MAX_TOTAL_WAIT_MS)} milliseconds`,
          );
        const result = await this.client.wait(command.wait, command.session);
        return { text: renderToolResult(result), matched: result.matched === true };
      }
      case 'browser-wait': {
        if (!(command.totalMs >= 100 && command.totalMs <= AGENT_TOOL_MAX_TOTAL_WAIT_MS))
          throw new AgentToolsCommandError(
            `--timeout must be between 100 and ${String(AGENT_TOOL_MAX_TOTAL_WAIT_MS)} milliseconds`,
          );
        const parsed = AgentToolCallSchema.safeParse({ ...command.call, tool: 'browser.wait_for' });
        if (!parsed.success) throw new AgentToolsCommandError(parsed.error.issues[0]?.message ?? 'not a valid call');
        if (parsed.data.tool !== 'browser.wait_for') throw new AgentToolsCommandError('not a browser wait');
        const result = await this.client.browserWait({ call: parsed.data, totalMs: command.totalMs }, command.session);
        return { text: renderToolResult(result), matched: result.matched !== false };
      }
      case 'control': {
        const view = await this.client.control(command.surface, command.action, command.key, personal(command.session));
        return { text: renderControlView(view), matched: true };
      }
      case 'view':
        return {
          text: renderControlView(await this.client.view(command.surface, personal(command.session))),
          matched: true,
        };
    }
  }
}

/** Taking over and handing back are a person's acts on a session they name. */
function personal(session: string | undefined): string {
  if (session === undefined)
    throw new AgentToolsCommandError(
      'this is a person’s action on a session: pass --session <id> (an agent cannot take a surface over from itself)',
    );
  return session;
}
