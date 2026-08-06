import { isAbsolute } from 'node:path';
import type { RuntimeModelChoice } from '@ferretry/protocol';
import { CodexModelCatalogError, CodexModelListExchange } from '../../../lib/index.ts';

/**
 * Reading one Codex account's advertised model catalog from that account's own app-server.
 *
 * The IO half of `lib/session/harness/codex-app-server.ts`: it spawns the child, splits its output
 * into lines, enforces a deadline and drains its error stream. Every judgement about what a reply
 * MEANS belongs to the exchange, which is why this file contains no knowledge of Codex's protocol
 * beyond the argv that starts it.
 *
 * THE ACCOUNT'S OWN EXECUTABLE, IN THE SESSION'S OWN DIRECTORY. The wrapper carries the harness home,
 * the provider configuration and the credentials, and the working directory carries the project
 * configuration — all four decide which models Codex will offer. A probe run anywhere else answers a
 * question nobody asked, and would name rows the session's picker does not render.
 *
 * BOTH PATHS MUST BE ABSOLUTE, refused rather than resolved. A relative executable is looked up on
 * `PATH`, which for a daemon started by a service manager is whatever that manager happened to
 * export — so a bare name can land on a different Codex than the one the session is running.
 */

/** Only what a harness needs to be itself; nothing else about this host reaches the child. */
const INHERITED: readonly string[] = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR'];

export interface CodexAppServerOptions {
  /** How long the whole exchange gets before the child is killed. */
  readonly timeoutMs?: number;
  /** How this daemon introduces itself in the handshake. */
  readonly clientName: string;
  readonly clientVersion: string;
  /** The environment to draw the inherited names from. Injected so a test never reads the real one. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** The allowlisted names, as the child will see them. */
function childEnvironment(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

export class CodexAppServerCatalog {
  constructor(private readonly options: CodexAppServerOptions) {}

  /** The models this account advertises right now, in the order its picker will render them. */
  async models(binary: string, cwd: string): Promise<readonly RuntimeModelChoice[]> {
    if (!isAbsolute(binary))
      throw new CodexModelCatalogError('the Codex model catalog probe needs an absolute wrapper path');
    if (!isAbsolute(cwd))
      throw new CodexModelCatalogError('the Codex model catalog probe needs an absolute session directory');

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = Bun.spawn([binary, 'app-server', '--stdio'], {
      cwd,
      env: childEnvironment(this.options.environment ?? Bun.env),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = new Response(child.stderr).text();
    const exchange = new CodexModelListExchange();
    const write = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    let choices: readonly RuntimeModelChoice[] | undefined;
    try {
      write(exchange.start(this.options.clientName, this.options.clientVersion));
      choices = await this.#converse(child.stdout, exchange, write);
    } finally {
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      await child.exited.catch(() => undefined);
    }

    if (timedOut)
      throw new CodexModelCatalogError(
        `the Codex model catalog probe timed out after ${Math.round(timeoutMs / 1000)}s`,
      );
    if (choices === undefined) {
      // The last line of the child's own diagnostics is the most useful thing available: the daemon
      // knows only that the stream ended, and Codex usually says why on the way out.
      const detail = (await stderr)
        .trim()
        .split('\n')
        .filter(line => line.trim() !== '')
        .at(-1);
      throw new CodexModelCatalogError(
        `the Codex model catalog probe ended before the catalog was complete${detail === undefined ? '' : `: ${detail}`}`,
      );
    }
    return choices;
  }

  /** Feed whole lines to the exchange until it answers, or until the stream ends. */
  async #converse(
    stdout: ReadableStream<Uint8Array>,
    exchange: CodexModelListExchange,
    write: (message: unknown) => void,
  ): Promise<readonly RuntimeModelChoice[] | undefined> {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line === '') continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          throw new CodexModelCatalogError('the Codex app-server wrote a non-JSON model catalog response');
        }
        const step = exchange.receive(message);
        for (const outgoing of step.send) write(outgoing);
        if (step.choices !== undefined) return step.choices;
      }
    }
    return undefined;
  }
}
