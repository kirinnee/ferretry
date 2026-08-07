/**
 * A W3C WebDriver client, in as little code as the journey needs.
 *
 * WHY NOT SELENIUM OR PLAYWRIGHT. `safaridriver` speaks plain W3C WebDriver JSON
 * over loopback HTTP, so this is `fetch` against `http://127.0.0.1:<port>` and
 * nine endpoints. Selenium happens to be installed on the GitHub macOS image, but
 * adding `selenium-webdriver` would put a new npm dependency into
 * `packages/pwa` for something a hundred lines of `fetch` does — in a repository
 * that already declines to install browsers and drives the system Chrome instead.
 * Playwright is worse than unnecessary here: its WebKit is a patched build of a
 * different revision and its own documentation says it "doesn't work with the
 * branded version of Safari", which is the only browser this file exists to
 * measure.
 *
 * SAFARI HOSTS EXACTLY ONE SESSION AT A TIME, so `close()` is not hygiene — a
 * leaked session blocks the next run of the job, and the next one after that.
 * Every caller therefore runs the journey inside `try`/`finally` and the finally
 * calls `stop()`, which deletes the session and then kills the driver whether or
 * not the delete succeeded.
 *
 * THERE IS NO HEADLESS MODE. `safaridriver`'s man page documents `-p/--port`,
 * `--enable`, `--diagnose`, `--version` and `-h`, and nothing else, so a real
 * window server is a hard requirement rather than a preference. That is the whole
 * reason the job runs on a macOS runner in its autologin GUI session.
 *
 * IT IS ALSO CLASSIC-ONLY. There is no BiDi, no CDP, no request interception and
 * no console log endpoint, which is why the journey's egress evidence is a
 * server-side request ledger and never an intercepted request.
 */

/** Everything the journey asks a driver to do, and nothing more. */
interface WebDriverSession {
  readonly sessionId: string;
  /** The session's negotiated capabilities, recorded verbatim in the artifact. */
  readonly capabilities: Readonly<Record<string, unknown>>;
  navigate(url: string): Promise<void>;
  /** `GET /session/:id/url` — a top-navigation check the page cannot influence. */
  currentUrl(): Promise<string>;
  /** `GET /session/:id/window/handles` — the popup check, likewise. */
  windowHandles(): Promise<readonly string[]>;
  /**
   * Resizes the window so a run is reproducible. This is NOT a mobile
   * measurement and must never be reported as one: `safaridriver` has no device
   * emulation, no touch and no user-agent control, so a narrow Mac window is a
   * narrow Mac window.
   */
  setWindowRect(rect: { readonly width: number; readonly height: number }): Promise<void>;
  execute<T>(script: string, args?: readonly unknown[]): Promise<T>;
  /** The last argument handed to the script is the completion callback. */
  executeAsync<T>(script: string, args?: readonly unknown[]): Promise<T>;
}

export interface WebDriverHandle {
  readonly session: WebDriverSession;
  /** `GET /status`'s own report, plus the driver binary's `--version` line. */
  readonly driverVersion: string;
  /** Whatever the driver process wrote, for the evidence artifact. */
  diagnostics(): string;
  /** Idempotent: deletes the session, then kills the driver. Safe to call twice. */
  stop(): Promise<void>;
}

export interface WebDriverOptions {
  /** `/usr/bin/safaridriver` in CI; overridable so a Mac can point at another build. */
  readonly driverPath: string;
  /** `safari` in CI. Recorded in the artifact so a run can never claim the wrong engine. */
  readonly browserName: string;
  /** Extra `alwaysMatch` entries, e.g. a vendor options object. */
  readonly capabilities?: Readonly<Record<string, unknown>>;
  /** `--diagnose` writes per-session driver logs, the closest thing to a console Safari offers. */
  readonly diagnose: boolean;
  readonly scriptTimeoutMs: number;
}

/** W3C wraps every success and every failure in `value`. */
interface WireResponse {
  readonly value?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * A driver error is a `value` object carrying `error` and `message`. Reporting
 * both is the difference between "the session failed" and Safari telling you
 * that remote automation is disabled.
 */
const wireError = (status: number, body: unknown): Error => {
  if (isRecord(body) && isRecord(body.value) && typeof body.value.error === 'string') {
    const detail = typeof body.value.message === 'string' ? body.value.message : '';
    return new Error(`WebDriver ${status} ${body.value.error}: ${detail}`);
  }
  return new Error(`WebDriver ${status}: ${JSON.stringify(body).slice(0, 400)}`);
};

/**
 * Finds a port nothing is listening on by asking the kernel for one and letting
 * it go again.
 *
 * There is an unavoidable race between the close and the driver's bind, so the
 * caller retries. The alternative — a hard-coded 4444 — collides with anything
 * else on the machine, and on a developer's Mac that is a real event.
 */
const freePort = async (): Promise<number> => {
  const probe = Bun.serve({ fetch: () => new Response('probe'), hostname: '127.0.0.1', port: 0 });
  const { port } = probe;
  await probe.stop(true);
  // A unix-socket server has no TCP port, so the type is optional. Fail loudly
  // rather than coercing: a driver told to listen on `NaN` fails much later and
  // for a reason that reads like Safari refusing the session.
  if (port === undefined) throw new Error('the port-probe server bound no TCP port');
  return port;
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export const startWebDriver = async (options: WebDriverOptions): Promise<WebDriverHandle> => {
  const versionProcess = Bun.spawn([options.driverPath, '--version'], { stderr: 'pipe', stdout: 'pipe' });
  const versionText = (await new Response(versionProcess.stdout).text()).trim();
  await versionProcess.exited;

  const attempts = 3;
  let lastFailure: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const port = await freePort();
    const argv = options.diagnose
      ? [options.driverPath, '-p', String(port), '--diagnose']
      : [options.driverPath, '-p', String(port)];
    const driver = Bun.spawn(argv, { stderr: 'pipe', stdout: 'pipe' });
    const output: string[] = [];
    const drain = async (stream: ReadableStream<Uint8Array> | null): Promise<void> => {
      if (stream === null) return;
      output.push(await new Response(stream).text());
    };
    // Read both pipes to completion in the background: a driver whose stderr fills
    // its pipe buffer stops answering, and killing it later must not block on a
    // reader nobody attached.
    void drain(driver.stdout);
    void drain(driver.stderr);

    const base = `http://127.0.0.1:${port}`;
    const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const response = await fetch(`${base}${path}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { accept: 'application/json', 'content-type': 'application/json;charset=UTF-8' },
        method,
      });
      const parsed: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw wireError(response.status, parsed);
      return (parsed as WireResponse).value as T;
    };

    try {
      // Poll `GET /status` rather than sleeping: the driver's own readiness flag is
      // the only thing that knows when it can accept a session.
      const deadline = Date.now() + 20_000;
      let ready: unknown;
      for (;;) {
        if (Date.now() > deadline) throw new Error(`${options.driverPath} never became ready on ${base}`);
        try {
          ready = await call<unknown>('GET', '/status');
          if (isRecord(ready) && ready.ready === true) break;
        } catch {
          // Not listening yet. Keep polling until the deadline.
        }
        await sleep(150);
      }

      const created = await call<{ sessionId?: unknown; capabilities?: unknown }>('POST', '/session', {
        capabilities: {
          alwaysMatch: {
            browserName: options.browserName,
            timeouts: { implicit: 0, pageLoad: 60_000, script: options.scriptTimeoutMs },
            ...(options.capabilities ?? {}),
          },
        },
      });
      const sessionId = typeof created.sessionId === 'string' ? created.sessionId : null;
      if (sessionId === null) throw new Error('the driver created a session without an id');
      const capabilities = isRecord(created.capabilities) ? created.capabilities : {};

      const session: WebDriverSession = {
        capabilities,
        currentUrl: () => call<string>('GET', `/session/${sessionId}/url`),
        execute: <T>(script: string, args: readonly unknown[] = []) =>
          call<T>('POST', `/session/${sessionId}/execute/sync`, { args, script }),
        executeAsync: <T>(script: string, args: readonly unknown[] = []) =>
          call<T>('POST', `/session/${sessionId}/execute/async`, { args, script }),
        navigate: async (url: string) => {
          await call<null>('POST', `/session/${sessionId}/url`, { url });
        },
        sessionId,
        setWindowRect: async rect => {
          await call<unknown>('POST', `/session/${sessionId}/window/rect`, {
            height: rect.height,
            width: rect.width,
            x: 0,
            y: 0,
          });
        },
        windowHandles: () => call<readonly string[]>('GET', `/session/${sessionId}/window/handles`),
      };

      let stopped = false;
      return {
        diagnostics: () => output.join(''),
        driverVersion: versionText,
        session,
        stop: async () => {
          if (stopped) return;
          stopped = true;
          // The delete is attempted first and its failure is swallowed on purpose:
          // whatever went wrong, the driver process must still die, or the next run
          // of this job cannot create a session at all.
          try {
            await call<unknown>('DELETE', `/session/${sessionId}`);
          } catch {
            output.push('\n[harness] DELETE /session failed; killing the driver anyway\n');
          }
          driver.kill();
          await driver.exited;
        },
      };
    } catch (error) {
      lastFailure = error;
      driver.kill();
      await driver.exited;
      if (attempt === attempts) break;
      await sleep(500);
    }
  }
  throw new Error(
    `could not start a ${options.browserName} WebDriver session after ${attempts} attempts: ${String(lastFailure)}`,
  );
};
