/**
 * Picking a sign-in up, starting it over and letting it lapse — with real children, real ports and a
 * real timer.
 *
 * The unit tier proves the decisions against fakes. What only real processes can prove is the reason
 * the feature exists: a sign-in left behind holds this machine's callback port, so the next one cannot
 * listen. Here the "harness" is a stand-in `codex` that binds the port it is given and prints Codex's
 * link line only once it has; if the port is still taken it exits without one, and the flow fails.
 *
 * No test here guesses a port. The first child binds port 0, so the OS picks, and records the port it
 * got; the service is then pointed at THAT port, which a child holds the whole time.
 */
import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessLoginFlow } from '../../../contract/index.ts';
import should from 'should';
import type { LoginId } from '../../../contract/index.ts';
import { spawnChild, timer } from '../../support/real-ports.ts';
import { realPortHolders } from '../../support/real-ports.ts';
import type { CallerGovernance } from '@ferretry/core-gate/contract';
import type { HarnessLoginTimer } from '../../../daemon/lib/harness-login/ports.ts';
import { HarnessLoginService } from '../../../daemon/lib/harness-login/service.ts';
import { waitFor, waitForValue } from '../../support/real-ports.ts';

const temporaryDirectories: string[] = [];
const leftovers: Bun.Subprocess[] = [];
const services: HarnessLoginService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.shutdown()));
  for (const child of leftovers.splice(0)) child.kill('SIGKILL');
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const LINK_URL =
  'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_TESTONLY&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&code_challenge=challenge&code_challenge_method=S256&state=STATE_TESTONLY&originator=codex_cli_rs';

/** A paired browser the boundary let through. */
const BROWSER: CallerGovernance = { governed: true, decide: () => ({ allowed: true, refusal: 'granted' }) };

/**
 * The callback port a test's children share. It starts unknown (`ports` empty, so a child is told port 0 and the
 * OS picks); once a child has recorded the port it bound, `learn` adds it, and every later child and the service's
 * `callbackPorts` use that one.
 */
interface CallbackPort {
  readonly ports: number[];
  readonly file: string;
}

/** The port the next child is told to bind: the learned one, else 0 (the OS picks). */
function toBind(callback: CallbackPort): string {
  return String(callback.ports[0] ?? 0);
}

/** Read the port a child recorded once it bound, and remember it. The child writes it before it prints its link line. */
async function learn(callback: CallbackPort): Promise<number> {
  const port = Number((await Bun.file(callback.file).text()).trim());
  if (!Number.isInteger(port) || port <= 0) throw new Error('the stand-in codex recorded no port');
  callback.ports.splice(0, callback.ports.length, port);
  return port;
}

/**
 * A stand-in `codex`: binds `FAKE_CALLBACK_PORT` (0 lets the OS pick), writes the port it got to
 * `FAKE_PORT_FILE`, prints Codex's link line, and waits. Run as `codex … login`, which is also exactly what a
 * leftover Codex sign-in looks like.
 */
async function fakeCodex(): Promise<{
  readonly binary: string;
  readonly program: string;
  readonly callback: CallbackPort;
}> {
  const root = await mkdtemp(join(tmpdir(), 'fy-start-over-'));
  temporaryDirectories.push(root);
  const program = join(root, 'codex');
  await writeFile(
    program,
    [
      'let server;',
      'try {',
      "  server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.FAKE_CALLBACK_PORT), fetch: () => new Response('') });",
      '} catch {',
      '  process.exit(3);',
      '}',
      "require('node:fs').writeFileSync(process.env.FAKE_PORT_FILE, String(server.port));",
      `console.log(${JSON.stringify(`Starting local login server. If your browser did not open, navigate to this URL to authenticate: ${LINK_URL}`)});`,
      'setInterval(() => undefined, 1000);',
    ].join('\n'),
    'utf8',
  );
  const binary = join(root, 'codex-launcher');
  await writeFile(binary, `#!/bin/sh\nexec "${process.execPath}" "${program}" "$@"\n`, 'utf8');
  await chmod(binary, 0o700);
  return { binary, program, callback: { ports: [], file: join(root, 'callback-port') } };
}

/** The real timer, except that a test can fire a timer by its delay instead of waiting that long. */
function drivenTimer() {
  const armed: Array<{ readonly milliseconds: number; readonly run: () => void }> = [];
  return {
    timer: {
      after: (milliseconds: number, run: () => void) => {
        armed.push({ milliseconds, run });
        return timer.after(milliseconds, run);
      },
    },
    fire: (milliseconds: number): void => {
      const due = armed.find(entry => entry.milliseconds === milliseconds);
      if (due === undefined) throw new Error(`no timer was armed for ${milliseconds} ms`);
      due.run();
    },
  };
}

function service(
  binary: string,
  callback: CallbackPort,
  windowMinutes?: number,
  loginTimer: HarnessLoginTimer = timer,
): HarnessLoginService {
  const created = new HarnessLoginService({
    clock: { now: () => Date.now() },
    mintId: () => crypto.randomUUID().replaceAll('-', ''),
    spawn: spawnChild,
    deliverCallback: async () => 'delivered',
    environment: { PATH: '/usr/bin:/bin' },
    timer: loginTimer,
    clientName: 'fy',
    credentialTargets: {
      target: async loginId => ({
        kind: 'store' as const,
        loginId: loginId as LoginId,
        harness: 'codex',
        environment: { FAKE_CALLBACK_PORT: toBind(callback), FAKE_PORT_FILE: callback.file },
        arguments: [],
        prepare: async () => undefined,
        check: async () => ({ signedIn: false as const, finding: 'Checked nothing.' }),
      }),
    },
    locate: () => binary,
    portHolders: realPortHolders(),
    callbackPorts: callback.ports,
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
  });
  services.push(created);
  return created;
}

/** Read a flow until it stops starting. */
async function settledOnto(subject: HarnessLoginService, flowId: string): Promise<HarnessLoginFlow> {
  return await waitForValue(async () => {
    const flow = await subject.status(flowId);
    return flow.state !== 'starting' ? flow : undefined;
  }, 'the sign-in to get past starting');
}

/** Whether this port can be listened on again, once the killed child has gone. */
async function bindable(port: number): Promise<boolean> {
  await waitFor(async () => {
    try {
      await Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('') }).stop(true);
      return true;
    } catch {
      return false;
    }
  }, `port ${port} to be bindable again`);
  return true;
}

describe('starting a Codex sign-in over, for real', () => {
  it('should pick the running sign-in up, then start over onto a port the old one freed', async () => {
    // Arrange
    const { binary, callback } = await fakeCodex();
    const subject = service(binary, callback);
    const first = await subject.start({ loginId: 'team' as LoginId, method: 'link' }, BROWSER);
    should(await settledOnto(subject, first.flowId)).have.property('state', 'awaiting-callback');
    // The first child bound port 0 and holds what it got; from here the service and the fresh child use that port.
    const port = await learn(callback);

    // Act
    const picked = await subject.start({ loginId: 'team' as LoginId }, BROWSER);
    const fresh = await subject.start({ loginId: 'team' as LoginId, method: 'link', restart: true }, BROWSER);

    // Assert — the fresh child could bind the port, so the old one had let it go.
    should(picked).match({ flowId: first.flowId, resumed: true, state: 'awaiting-callback' });
    should(await settledOnto(subject, fresh.flowId)).have.property('state', 'awaiting-callback');
    should(await subject.status(first.flowId)).have.property('reason', 'this sign-in was replaced by a new one');
    should(await learn(callback)).equal(port);
  });

  it('should stop a leftover Codex sign-in a previous daemon left on the port', async () => {
    // Arrange — the leftover runs as `codex login` and holds the port; no flow here knows about it.
    const { binary, program, callback } = await fakeCodex();
    const leftover = Bun.spawn([process.execPath, program, 'login'], {
      env: { FAKE_CALLBACK_PORT: toBind(callback), FAKE_PORT_FILE: callback.file },
      stdout: 'pipe',
    });
    leftovers.push(leftover);
    await leftover.stdout.getReader().read();
    await learn(callback);
    const subject = service(binary, callback);

    // Act
    const fresh = await subject.start({ loginId: 'team' as LoginId, method: 'link', restart: true }, BROWSER);

    // Assert
    should(await settledOnto(subject, fresh.flowId)).have.property('state', 'awaiting-callback');
    should(await leftover.exited).not.equal(0);
  });

  it('should name and leave alone a program that is not a Codex sign-in', async () => {
    // Arrange — somebody's own server on the port, bound by the OS so no number is ever guessed.
    const { binary, callback } = await fakeCodex();
    const theirs = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('theirs') });
    const port = Number(theirs.port);
    callback.ports.push(port);
    try {
      const subject = service(binary, callback);

      // Act
      const fresh = await subject.start({ loginId: 'team' as LoginId, method: 'link', restart: true }, BROWSER);
      const flow = await settledOnto(subject, fresh.flowId);

      // Assert — this test's own runner is the holder, and it is still serving.
      should(flow).match({
        state: 'failed',
        reason: new RegExp(
          `port ${String(port)} is in use by ".+" \\(pid ${String(process.pid)}\\), which is not a Codex sign-in`,
          'u',
        ),
      });
      should(await (await fetch(`http://127.0.0.1:${String(port)}/`)).text()).equal('theirs');
    } finally {
      await theirs.stop(true);
    }
  });

  it('should end a sign-in whose window closed, and free the port its child held', async () => {
    // Arrange — a window of a fraction of a second, fired by the test rather than waited out.
    const { binary, callback } = await fakeCodex();
    const driven = drivenTimer();
    const subject = service(binary, callback, 0.01, driven.timer);
    const started = await subject.start({ loginId: 'team' as LoginId, method: 'link' }, BROWSER);
    await settledOnto(subject, started.flowId);
    const port = await learn(callback);

    // Act
    driven.fire(0.01 * 60_000);
    const ended = await subject.status(started.flowId);

    // Assert
    should(ended).match({ state: 'failed', lastCode: 'expired' });
    should(await bindable(port)).be.true();
  });
});
