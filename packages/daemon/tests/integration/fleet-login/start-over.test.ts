/**
 * Picking a sign-in up, starting it over and letting it lapse — with real children, real ports and a
 * real timer.
 *
 * The unit tier proves the decisions against fakes. What only real processes can prove is the reason
 * the feature exists: a sign-in left behind holds this machine's callback port, so the next one cannot
 * listen. Here the "harness" is a stand-in `codex` that binds the port it is given and prints Codex's
 * link line only once it has; if the port is still taken it exits without one, and the flow fails.
 */
import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessLoginFlow } from '@ferretry/protocol';
import should from 'should';
import { harnessLoginTimer, spawnHarnessLoginChild } from '../../../src/adapters/fleet-login/login-child.ts';
import { systemPortHolders } from '../../../src/adapters/fleet-login/port-holders.ts';
import type { CallerGovernance } from '../../../src/lib/api/capability.ts';
import { HarnessLoginService } from '../../../src/lib/fleet-login/service.ts';

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

/** A loopback port that was free a moment ago. */
async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = Number(probe.port);
  await probe.stop(true);
  return port;
}

/**
 * A stand-in `codex`: binds `FAKE_CALLBACK_PORT`, prints Codex's link line, and waits. Run as
 * `codex … login`, which is also exactly what a leftover Codex sign-in looks like.
 */
async function fakeCodex(): Promise<{ readonly binary: string; readonly program: string }> {
  const root = await mkdtemp(join(tmpdir(), 'fy-start-over-'));
  temporaryDirectories.push(root);
  const program = join(root, 'codex');
  await writeFile(
    program,
    [
      'try {',
      "  Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.FAKE_CALLBACK_PORT), fetch: () => new Response('') });",
      '} catch {',
      '  process.exit(3);',
      '}',
      `console.log(${JSON.stringify(`Starting local login server. If your browser did not open, navigate to this URL to authenticate: ${LINK_URL}`)});`,
      'setInterval(() => undefined, 1000);',
    ].join('\n'),
    'utf8',
  );
  const binary = join(root, 'codex-launcher');
  await writeFile(binary, `#!/bin/sh\nexec "${process.execPath}" "${program}" "$@"\n`, 'utf8');
  await chmod(binary, 0o700);
  return { binary, program };
}

function service(binary: string, port: number, windowMinutes?: number): HarnessLoginService {
  const created = new HarnessLoginService({
    clock: { now: () => Date.now() },
    mintId: () => crypto.randomUUID().replaceAll('-', ''),
    spawn: spawnHarnessLoginChild,
    deliverCallback: async () => 'delivered',
    environment: { PATH: '/usr/bin:/bin' },
    timer: harnessLoginTimer,
    clientName: 'fy',
    credentialTargets: {
      target: async credentialId => ({
        kind: 'store',
        credentialId,
        harness: 'codex',
        environment: { FAKE_CALLBACK_PORT: String(port) },
        arguments: [],
        prepare: async () => undefined,
        check: async () => ({ signedIn: false as const, finding: 'Checked nothing.' }),
      }),
    },
    locate: () => binary,
    portHolders: systemPortHolders(),
    callbackPorts: [port],
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
  });
  services.push(created);
  return created;
}

/** Read a flow until it stops starting. */
async function settledOnto(subject: HarnessLoginService, flowId: string): Promise<HarnessLoginFlow> {
  for (let tries = 0; tries < 200; tries += 1) {
    const flow = await subject.status(flowId);
    if (flow.state !== 'starting') return flow;
    await Bun.sleep(25);
  }
  throw new Error('the sign-in never got past starting');
}

/** Whether this port can be listened on again, allowing the killed child a moment to go. */
async function bindable(port: number): Promise<boolean> {
  for (let tries = 0; tries < 100; tries += 1) {
    try {
      await Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('') }).stop(true);
      return true;
    } catch {
      await Bun.sleep(20);
    }
  }
  return false;
}

describe('starting a Codex sign-in over, for real', () => {
  it('should pick the running sign-in up, then start over onto a port the old one freed', async () => {
    // Arrange
    const port = await freePort();
    const { binary } = await fakeCodex();
    const subject = service(binary, port);
    const first = await subject.start({ credentialId: 'team', method: 'link' }, BROWSER);
    should(await settledOnto(subject, first.flowId)).have.property('state', 'awaiting-callback');

    // Act
    const picked = await subject.start({ credentialId: 'team' }, BROWSER);
    const fresh = await subject.start({ credentialId: 'team', method: 'link', restart: true }, BROWSER);

    // Assert — the fresh child could bind the port, so the old one had let it go.
    should(picked).match({ flowId: first.flowId, resumed: true, state: 'awaiting-callback' });
    should(await settledOnto(subject, fresh.flowId)).have.property('state', 'awaiting-callback');
    should(await subject.status(first.flowId)).have.property('reason', 'this sign-in was replaced by a new one');
  });

  it('should stop a leftover Codex sign-in a previous daemon left on the port', async () => {
    // Arrange — the leftover runs as `codex login` and holds the port; no flow here knows about it.
    const port = await freePort();
    const { binary, program } = await fakeCodex();
    const leftover = Bun.spawn([process.execPath, program, 'login'], {
      env: { FAKE_CALLBACK_PORT: String(port) },
      stdout: 'pipe',
    });
    leftovers.push(leftover);
    await leftover.stdout.getReader().read();
    const subject = service(binary, port);

    // Act
    const fresh = await subject.start({ credentialId: 'team', method: 'link', restart: true }, BROWSER);

    // Assert
    should(await settledOnto(subject, fresh.flowId)).have.property('state', 'awaiting-callback');
    should(await leftover.exited).not.equal(0);
  });

  it('should name and leave alone a program that is not a Codex sign-in', async () => {
    // Arrange — somebody's own server on the port, bound by the OS so no number is ever guessed.
    const { binary } = await fakeCodex();
    const theirs = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('theirs') });
    const port = Number(theirs.port);
    try {
      const subject = service(binary, port);

      // Act
      const fresh = await subject.start({ credentialId: 'team', method: 'link', restart: true }, BROWSER);
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
    // Arrange — a window of a fraction of a second, on the real timer.
    const port = await freePort();
    const { binary } = await fakeCodex();
    const subject = service(binary, port, 0.01);
    const started = await subject.start({ credentialId: 'team', method: 'link' }, BROWSER);
    await settledOnto(subject, started.flowId);

    // Act
    await Bun.sleep(900);
    const ended = await subject.status(started.flowId);

    // Assert
    should(ended).match({ state: 'failed', lastCode: 'expired' });
    should(await bindable(port)).be.true();
  });
});
