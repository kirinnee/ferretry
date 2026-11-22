/**
 * A W3C WebDriver client for `safaridriver`, in as little code as one page needs (the 4.x Safari journey's client, cut to the
 * calls this page makes). `safaridriver` speaks plain W3C WebDriver JSON over loopback HTTP, so this is `fetch` and five
 * endpoints: no new dependency, and not Playwright's WebKit, which is not Safari.
 *
 * SAFARI HOSTS ONE SESSION AT A TIME, so `stop()` is not hygiene: a leaked session blocks the next run of the job. It deletes
 * the session and then kills the driver whether or not the delete worked. THERE IS NO HEADLESS MODE and no console endpoint:
 * the page reports its own errors (`collect.js`), and the driver is only asked to navigate and to read a value.
 */

export interface WebDriver {
  /** The driver binary's own `--version` line, for the report. */
  readonly version: string;
  navigate(url: string): Promise<void>;
  execute<T>(script: string, args?: readonly unknown[]): Promise<T>;
  /** Idempotent: deletes the session, then kills the driver. */
  stop(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A port in the ephemeral range for `safaridriver -p`, which takes a number and offers no way to read back one it chose. It is
 * not probed (a probe-then-close helper races the bind): if something else holds it, the driver does not answer `/status` as a
 * driver, the attempt fails at its readiness deadline, and the next attempt draws another.
 */
const driverPort = (): number => 49_152 + Math.floor(Math.random() * 16_000);

const wireError = (status: number, body: unknown): Error => {
  const value = (body as { value?: { error?: unknown; message?: unknown } } | null)?.value;
  return typeof value?.error === 'string'
    ? new Error(`WebDriver ${status} ${value.error}: ${String(value.message ?? '')}`)
    : new Error(`WebDriver ${status}: ${JSON.stringify(body).slice(0, 400)}`);
};

export const startSafariDriver = async (driverPath = '/usr/bin/safaridriver'): Promise<WebDriver> => {
  const versionProcess = Bun.spawn([driverPath, '--version'], { stderr: 'pipe', stdout: 'pipe' });
  const version = (await new Response(versionProcess.stdout).text()).trim();
  await versionProcess.exited;
  let failure: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const port = driverPort();
    const driver = Bun.spawn([driverPath, '-p', String(port)], { stderr: 'pipe', stdout: 'pipe' });
    // A driver whose pipes fill stops answering: read both to the end in the background.
    void new Response(driver.stdout).text();
    void new Response(driver.stderr).text();
    const base = `http://127.0.0.1:${port}`;
    const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const response = await fetch(`${base}${path}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { accept: 'application/json', 'content-type': 'application/json;charset=UTF-8' },
        method,
      });
      const parsed: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw wireError(response.status, parsed);
      return (parsed as { value?: unknown }).value as T;
    };
    try {
      const deadline = Date.now() + 20_000;
      for (;;) {
        if (Date.now() > deadline) throw new Error(`${driverPath} never became ready on ${base}`);
        try {
          if (((await call<{ ready?: boolean }>('GET', '/status')) ?? {}).ready === true) break;
        } catch {
          // not listening yet
        }
        await sleep(150);
      }
      const created = await call<{ sessionId?: unknown }>('POST', '/session', {
        capabilities: {
          alwaysMatch: { browserName: 'safari', timeouts: { implicit: 0, pageLoad: 60_000, script: 30_000 } },
        },
      });
      if (typeof created.sessionId !== 'string') throw new Error('the driver created a session without an id');
      const id = created.sessionId;
      let stopped = false;
      return {
        version,
        navigate: async url => {
          await call<null>('POST', `/session/${id}/url`, { url });
        },
        execute: <T>(script: string, args: readonly unknown[] = []) =>
          call<T>('POST', `/session/${id}/execute/sync`, { args, script }),
        stop: async () => {
          if (stopped) return;
          stopped = true;
          // The delete may fail; the driver must die anyway, or the next run cannot create a session at all.
          await call<unknown>('DELETE', `/session/${id}`).catch(() => undefined);
          driver.kill();
          await driver.exited;
        },
      };
    } catch (error) {
      failure = error;
      driver.kill();
      await driver.exited;
      await sleep(500);
    }
  }
  throw new Error(`could not start a Safari WebDriver session after 3 attempts: ${String(failure)}`);
};
