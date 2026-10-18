/**
 * Signing the HOST'S OWN Claude Code login in from a browser, the way Linux keeps it — with a real
 * child, a real file store and a real timer.
 *
 * On Linux Claude Code keeps its login in `<config dir>/.credentials.json` (no keychain), and a host
 * login has no config directory of its own, so the file is `$HOME/.claude/.credentials.json`. The
 * "harness" is `scripts/test/fake-claude-tui.sh`, which prints what claude-code 2.1.281 prints on Linux
 * for `auth login --claudeai` and writes a fake login where the real one would. HOME is a temporary
 * directory: no real harness home is read or written, and nothing reaches a network.
 *
 * What only real processes prove is the property the PWA's polling rests on: a start ANSWERS at once,
 * whatever the child is doing, so a browser never holds one request open across a sign-in.
 */
import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AccountModel } from '@ferretry/fleet';
import { PlatformFleetCredentialStore, StoredCredentialClassifier } from '@ferretry/fleet/adapters';
import type { HarnessLoginFlow } from '@ferretry/protocol';
import should from 'should';
import { harnessLoginTimer, spawnHarnessLoginChild } from '../../../src/adapters/fleet-login/login-child.ts';
import type { CallerGovernance } from '../../../src/lib/api/capability.ts';
import { FleetCredentialCatalog } from '../../../src/lib/fleet/credentials-service.ts';
import { HarnessLoginService } from '../../../src/lib/fleet-login/service.ts';

const FAKE_CLAUDE = resolve(import.meta.dir, '../../../../../scripts/test/fake-claude-tui.sh');

const temporaryDirectories: string[] = [];
const services: HarnessLoginService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.shutdown()));
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

/** A paired phone the boundary let through. */
const PHONE: CallerGovernance = { governed: true, decide: () => ({ allowed: true, refusal: 'granted' }) };

const HOST_LOGIN = 'claude-you';

/** The account model, reduced to the one table a sign-in reads: one host Claude login. */
const MODEL = { version: 2, credentials: { [HOST_LOGIN]: { harness: 'claude', store: 'host' } }, runtimes: {} };

interface Machine {
  readonly service: HarnessLoginService;
  readonly home: string;
}

/** A Linux machine whose `claude` is `binary`, with HOME and the fleet under one temporary root. */
async function linuxMachine(binary: string = FAKE_CLAUDE): Promise<Machine> {
  const root = await mkdtemp(join(tmpdir(), 'fy-claude-linux-'));
  temporaryDirectories.push(root);
  const home = join(root, 'home');
  const store = new PlatformFleetCredentialStore({
    platform: 'linux',
    command: { run: async () => ({ code: 1, stdout: '' }) },
    now: () => Date.now(),
    keychainAccount: 'nobody',
    defaultClaudeHome: join(home, '.claude'),
  });
  const classifier = new StoredCredentialClassifier({ credentials: store, now: () => Date.now() });
  const catalog = new FleetCredentialCatalog({
    document: async () => MODEL as unknown as AccountModel,
    paths: { fleetRoot: join(root, 'fy', 'fleet'), userHome: home },
    classify: async resolution => await classifier.classify(resolution),
    ensureDirectory: async () => undefined,
  });
  const service = new HarnessLoginService({
    clock: { now: () => Date.now() },
    mintId: () => crypto.randomUUID().replaceAll('-', ''),
    spawn: spawnHarnessLoginChild,
    deliverCallback: async () => 'delivered',
    // What a systemd user service hands the daemon: a PATH and a HOME, and no terminal.
    environment: { PATH: '/usr/bin:/bin', HOME: home },
    timer: harnessLoginTimer,
    clientName: 'fy',
    credentialTargets: { target: async id => catalog.signInTarget(await catalog.entry(id)) },
    locate: () => binary,
    portHolders: { ownUid: 0, holders: async () => [], stop: async () => false },
  });
  services.push(service);
  return { service, home };
}

/** Poll as the browser does, until the flow leaves `from` or the deadline passes. */
async function pollPast(service: HarnessLoginService, flowId: string, from: string): Promise<HarnessLoginFlow> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const flow = await service.status(flowId);
    if (flow.state !== from || Date.now() > deadline) return flow;
    await Bun.sleep(25);
  }
}

describe('signing the host Claude Code login in on Linux', () => {
  it('should hand the link out, take the code back, and leave a login in the host file', async () => {
    // Arrange
    const { service, home } = await linuxMachine();

    // Act
    const started = await service.start({ credentialId: HOST_LOGIN }, PHONE);
    const linked = await pollPast(service, started.flowId, 'starting');
    const submitted = await service.submit(started.flowId, { code: 'fake-code#fake-state' });
    const finished = await pollPast(service, started.flowId, 'awaiting-code');

    // Assert
    should(started).have.property('state', 'starting');
    should(linked).have.property('state', 'awaiting-code');
    should(linked).have.property('verificationUrl').startWith('https://claude.com/cai/oauth/authorize?');
    should(submitted).have.property('outcome', 'accepted');
    should(finished).have.property('state', 'complete');
    const written = JSON.parse(await readFile(join(home, '.claude', '.credentials.json'), 'utf8'));
    should(written).have.property('claudeAiOauth');
  });

  it('should keep waiting, link still on screen, after a code Claude refuses', async () => {
    // Arrange
    const { service } = await linuxMachine();
    const started = await service.start({ credentialId: HOST_LOGIN }, PHONE);
    await pollPast(service, started.flowId, 'starting');

    // Act — a code with no `#state`, which the real CLI refuses and keeps prompting after.
    await service.submit(started.flowId, { code: 'half-a-code' });
    const deadline = Date.now() + 10_000;
    let flow = await service.status(started.flowId);
    while (!('lastCode' in flow) && Date.now() < deadline) {
      await Bun.sleep(25);
      flow = await service.status(started.flowId);
    }

    // Assert
    should(flow).have.property('state', 'awaiting-code');
    should(flow).have.property('lastCode', 'rejected');
  });

  it('should answer a start at once even when the harness never prints, and end it on cancel', async () => {
    // Arrange — a `claude` that waits on something a browser cannot give it, printing nothing.
    const root = await mkdtemp(join(tmpdir(), 'fy-claude-silent-'));
    temporaryDirectories.push(root);
    const silent = join(root, 'claude');
    await writeFile(silent, '#!/bin/sh\nexec sleep 30\n', 'utf8');
    await chmod(silent, 0o700);
    const { service } = await linuxMachine(silent);

    // Act
    const before = performance.now();
    const started = await service.start({ credentialId: HOST_LOGIN }, PHONE);
    const answeredIn = performance.now() - before;
    await Bun.sleep(300);
    const waiting = await service.status(started.flowId);
    const cancelled = await service.cancel(started.flowId);

    // Assert
    should(answeredIn).be.below(1_000);
    should(waiting).have.property('state', 'starting');
    should(cancelled).have.property('state', 'failed');
  });

  it('should say why when the harness exits without offering a link', async () => {
    // Arrange — the real CLI's own failure path: a message on stderr and exit 1.
    const root = await mkdtemp(join(tmpdir(), 'fy-claude-failed-'));
    temporaryDirectories.push(root);
    const failing = join(root, 'claude');
    await writeFile(failing, '#!/bin/sh\necho "Login failed: offline" >&2\nexit 1\n', 'utf8');
    await chmod(failing, 0o700);
    const { service } = await linuxMachine(failing);

    // Act
    const started = await service.start({ credentialId: HOST_LOGIN }, PHONE);
    const ended = await pollPast(service, started.flowId, 'starting');

    // Assert
    should(ended).have.property('state', 'failed');
    should(ended)
      .have.property('reason')
      .match(/did not offer a sign-in/u);
    should(ended)
      .have.property('remedy')
      .match(/fy credential signin claude-you/u);
  });
});
