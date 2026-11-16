import type { FerretSummary } from '@ferretry/core-ferrets/contract';
import {
  ApiError,
  type ApiResponse,
  type CallContext,
  type FerretId,
  headersFrom,
  queryFrom,
} from '@ferretry/kernel/contract';
import type { FerretDirectory } from '../../../../../daemon/lib/runtime/mounts/ferret-path.ts';
import {
  type ObservedTerminalPane,
  type RegisteredTerminalPane,
  SessionAttachService,
} from '../../../../../daemon/lib/session/attach/index.ts';
import { SessionConsoleService } from '../../../../../daemon/lib/session/console/index.ts';

/**
 * Calling the Processes, Console, attach and limits handlers directly, the way the kernel calls them once Gate has
 * admitted the call: who may call is the manifest descriptor's (and the kernel's) question, not these handlers'.
 */

export const ATTACH_SOCKET_PATH = '/run/user/1000/ferretry/tmux/default';

/** The pane the tmux runner recorded for `s1`. */
export const ATTACH_PANE: RegisteredTerminalPane = {
  tmuxSession: 'fy-s1',
  paneId: '%7',
  pid: 4_242,
  processStartTicks: 918_273,
};

/** A ferret directory that holds exactly these ferrets. */
export function ferretDirectory(held: readonly string[] = ['s1']): FerretDirectory & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    get: async (id: FerretId) => {
      asked.push(id);
      return held.includes(id) ? ({ id } as unknown as FerretSummary) : undefined;
    },
  };
}

export interface CallInit {
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: readonly (readonly [string, string])[];
  readonly body?: string;
}

/** One admitted call: the raw path params, the query and the body text. */
export function call(init: CallInit = {}): CallContext {
  const body = init.body ?? '';
  return {
    request: {
      method: 'GET',
      path: '/',
      query: queryFrom(init.query ?? []),
      headers: headersFrom({}),
      arrival: { kind: 'local', privileged: true },
      text: async () => body,
    },
    params: new Map(Object.entries(init.params ?? { ferretId: 's1' })),
  } as unknown as CallContext;
}

/** What the handler answered, or the refusal the kernel would turn its `ApiError` into. */
export interface Answer {
  readonly status: number;
  readonly code?: string;
  readonly error?: string;
  readonly body?: unknown;
}

export async function answer(
  handler: (call: CallContext) => Promise<ApiResponse>,
  init: CallInit = {},
): Promise<Answer> {
  try {
    const response = await handler(call(init));
    return { status: response.status, body: JSON.parse(String(response.body)) };
  } catch (error) {
    if (error instanceof ApiError)
      return { status: error.status, ...(error.code === undefined ? {} : { code: error.code }), error: error.message };
    throw error;
  }
}

/** How an attach fixture may be pointed at a missing, damaged or vanished pane. */
export interface AttachWorld {
  readonly socketPath?: string;
  /** What the runner recorded; explicitly `undefined` for a ferret it holds no pane for. */
  readonly registration?: RegisteredTerminalPane | undefined;
  /** What a fresh observation reports; explicitly `undefined` for a pane that is gone. */
  readonly observation?: ObservedTerminalPane | undefined;
}

export function attachSubsystem(world: AttachWorld = {}): SessionAttachService {
  const registration = Object.hasOwn(world, 'registration') ? world.registration : ATTACH_PANE;
  const observation = Object.hasOwn(world, 'observation') ? world.observation : ATTACH_PANE;
  return new SessionAttachService(
    world.socketPath ?? ATTACH_SOCKET_PATH,
    { paneOf: async id => (id === 's1' ? registration : undefined) },
    { observe: async () => observation },
  );
}

/** Every tmux command a Console fixture ran, and the exit status each one is answered with. */
export interface ConsoleTmux {
  readonly commands: (readonly string[])[];
  code: number;
  stderr: string;
}

export const consoleTmux = (): ConsoleTmux => ({ commands: [], code: 0, stderr: '' });

/** The REAL Console over the REAL attach proof: only tmux is replaced. */
export function consoleSubsystem(world: AttachWorld = {}, tmux: ConsoleTmux = consoleTmux()): SessionConsoleService {
  return new SessionConsoleService(attachSubsystem(world), {
    execute: async command => {
      tmux.commands.push(command);
      return { code: tmux.code, stdout: '', stderr: tmux.stderr };
    },
  });
}
