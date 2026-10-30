// Realworld: asserts wall-clock speed; the outcome depends on the machine, not the code.
import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountModel } from '@ferretry/fleet';
import { PlatformFleetCredentialStore } from '@ferretry/fleet/adapters';
import should from 'should';
import { harnessLoginTimer, spawnHarnessLoginChild } from '../../../src/adapters/fleet-login/login-child.ts';
import type { CallerGovernance } from '../../../src/lib/api/capability.ts';
import { FleetCredentialCatalog } from '../../../src/lib/fleet/credentials-service.ts';
import { HarnessLoginService } from '../../../src/lib/fleet-login/service.ts';

const temporaryDirectories: string[] = [];
const services: HarnessLoginService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.shutdown()));
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const PHONE: CallerGovernance = { governed: true, decide: () => ({ allowed: true, refusal: 'granted' }) };
const HOST_LOGIN = 'claude-you';
const MODEL = { version: 2, credentials: { [HOST_LOGIN]: { harness: 'claude', store: 'host' } }, runtimes: {} };

/** A Linux machine whose `claude` is `binary`, with HOME and the fleet under one temporary root. */
async function linuxMachine(binary: string): Promise<HarnessLoginService> {
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
  const catalog = new FleetCredentialCatalog({
    document: async () => MODEL as unknown as AccountModel,
    paths: { fleetRoot: join(root, 'fy', 'fleet'), userHome: home },
    inspect: async resolution => await store.inspectStored(resolution),
    ensureDirectory: async () => undefined,
  });
  const service = new HarnessLoginService({
    clock: { now: () => Date.now() },
    mintId: () => crypto.randomUUID().replaceAll('-', ''),
    spawn: spawnHarnessLoginChild,
    deliverCallback: async () => 'delivered',
    environment: { PATH: '/usr/bin:/bin', HOME: home },
    timer: harnessLoginTimer,
    clientName: 'fy',
    credentialTargets: { target: async id => catalog.signInTarget(await catalog.entry(id)) },
    locate: () => binary,
    portHolders: { ownUid: 0, holders: async () => [], stop: async () => false },
  });
  services.push(service);
  return service;
}

describe('signing the host Claude Code login in on Linux', () => {
  it('should answer a start at once even when the harness never prints, and end it on cancel', async () => {
    // Arrange — a `claude` that waits on something a browser cannot give it, printing nothing.
    const root = await mkdtemp(join(tmpdir(), 'fy-claude-silent-'));
    temporaryDirectories.push(root);
    const silent = join(root, 'claude');
    await writeFile(silent, '#!/bin/sh\nexec sleep 30\n', 'utf8');
    await chmod(silent, 0o700);
    const service = await linuxMachine(silent);

    // Act
    const before = performance.now();
    const started = await service.start({ credentialId: HOST_LOGIN }, PHONE);
    const answeredIn = performance.now() - before;
    await service.cancel(started.flowId);

    // Assert
    should(answeredIn).be.below(1_000);
  });
});
