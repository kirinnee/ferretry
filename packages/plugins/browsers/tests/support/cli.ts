import type { PluginClient, TerminalIo } from '@ferretry/kernel/manifest';
import { parseArgs } from './shell-argv.ts';
import { BrowserClient } from '../../cli/lib/client.ts';
import { BrowserDispatcher } from '../../cli/lib/dispatcher.ts';
import { type FirewallFiles, verbTable } from '../../cli/lib/verbs/index.ts';

/** A recorded call of the plugin client: a route (a person's road) or a tool (the ferret's own). */
export type Recorded =
  | {
      readonly via: 'route';
      readonly route: string;
      readonly init: { params?: Record<string, string>; body?: unknown } | undefined;
    }
  | { readonly via: 'tool'; readonly name: string; readonly input: unknown };

export type Answer = unknown | ((call: Recorded) => unknown);

/**
 * A daemon half the verbs talk to: it records every call and answers from `answers` (a value or a function of the
 * call), by route key or tool name. A thrown answer is the daemon's refusal (what `PluginClient.call` rejects with).
 */
export class FakeDaemon {
  readonly calls: Recorded[] = [];
  readonly #answers = new Map<string, Answer>();

  answer(key: string, answer: Answer): this {
    this.#answers.set(key, answer);
    return this;
  }

  #respond(key: string, call: Recorded): unknown {
    this.calls.push(call);
    const answer = this.#answers.get(key);
    if (answer === undefined) throw new Error(`no answer set for ${key}`);
    return typeof answer === 'function' ? (answer as (c: Recorded) => unknown)(call) : answer;
  }

  /** The `PluginClient` surface the browsers verbs use; `withTools: false` is a shell with no tool door. */
  client(withTools = true): PluginClient {
    const call = async (route: string, init?: Extract<Recorded, { via: 'route' }>['init']): Promise<unknown> =>
      this.#respond(route, { via: 'route', route, init });
    const tool = async (name: string, input?: unknown): Promise<unknown> =>
      this.#respond(name, { via: 'tool', name, input });
    return (withTools ? { call, tool } : { call }) as unknown as PluginClient;
  }
}

export interface CliWorld {
  readonly out: string[];
  readonly err: string[];
  readonly files: Map<string, Uint8Array>;
  /** Types a command line: the longest leading words that name a verb, the rest parsed as the shell parses it. */
  run(words: readonly string[]): Promise<number>;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

export interface CliWorldOptions {
  readonly stdin?: string;
  readonly ownFerret?: string;
  readonly withTools?: boolean;
  readonly firewall?: FirewallFiles;
}

const FIREWALL: FirewallFiles = {
  script: '#!/bin/sh\necho script\n',
  unit: '[Unit]\nDescription=apply\n',
  verifyUnit: '[Unit]\nDescription=verify\n',
  timer: '[Timer]\nOnCalendar=hourly\n',
};

/** The browsers verbs wired to a fake daemon and an in-memory terminal, exactly as `cli/index.ts` composes them. */
export function cliWorld(daemon: FakeDaemon, options: CliWorldOptions = {}): CliWorld {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, Uint8Array>();
  const io: TerminalIo = { out: text => void out.push(text), err: text => void err.push(text), isTty: false };
  const table = verbTable(options.firewall ?? FIREWALL);
  const dispatcher = new BrowserDispatcher(table, new BrowserClient(daemon.client(options.withTools ?? true)), io, {
    ownFerret: options.ownFerret,
    readStdin: async () => options.stdin ?? '',
    writeFile: async (path, bytes) => void files.set(path, bytes),
  });
  return {
    out,
    err,
    files,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    async run(words) {
      const leading: string[] = [];
      for (const word of words) {
        if (word.startsWith('-')) break;
        leading.push(word);
      }
      for (let length = leading.length; length > 0; length -= 1) {
        const line = leading.slice(0, length).join(' ');
        if (line in table) return await dispatcher.run(line, parseArgs(words.slice(length)));
      }
      throw new Error(`no verb in: ${words.join(' ')}`);
    },
  };
}

/** A tool's answer the way the kernel hands it back. */
export const toolText = (text: string, data?: Record<string, unknown>, isError?: true) => ({
  text,
  ...(data === undefined ? {} : { data }),
  ...(isError === undefined ? {} : { isError }),
});
