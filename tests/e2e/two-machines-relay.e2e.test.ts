/**
 * TWO MACHINES THAT ANNOUNCE ONE ADDRESS, paired from one browser over a real relay.
 *
 * The owner's blocker: "when I add 2 daemons (of two different machines), it will show both machine as
 * the later added one". Every daemon a phone pairs with over the hosted relay announces its own loopback,
 * so two machines share one origin — and the browser routed each request by origin, to whichever pairing
 * was listed first. This journey is that setup with every part real: two compiled daemons with two
 * identities, both advertising the SAME unreachable direct address, one rendezvous, the real built PWA in
 * a real Chrome, and two pairings made the way an owner makes them.
 *
 * The proof is each machine's own data on screen: one seeded session per machine, under that machine's
 * heading and nowhere else, and each machine's session page reaching its own daemon. Screenshots of the
 * all-machines list are written at desktop and phone width in both colour schemes.
 *
 * The two daemons run on one host, so both report this host's name. The owner's machines have names of
 * their own; here each pairing is given an owner label through the real Settings control, so the
 * headings can be told apart by a person reading the screenshots.
 */

import { describe, it } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import should from 'should';
import { type E2eEnvironment, withE2eEnvironment } from './fixture.ts';
import { seedRunningSession } from './support/seeded-session.ts';
import {
  type BrowserSession,
  buildPwaBundle,
  clickFirstPresent,
  describeControls,
  evidenceScreenshot,
  harnessTeardown,
  launchChrome,
  type RendezvousProcess,
  renderedDataAttributes,
  startDirectSinkhole,
  startPwaOrigin,
  startRelayDirectory,
  startRendezvous,
  waitForDaemonFingerprint,
} from './support/relay-harness.ts';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../..');
const SHOTS_DIR = process.env.FY_E2E_TWO_MACHINES_SHOTS ?? join(tmpdir(), 'fy-e2e-two-machines');
const PAIRING_LINK = /https?:\/\/\S*#v\d;\S+/u;

/** The compiled daemon, named the way `scripts/release/compile.sh` names it. */
function compiledDaemon(): string {
  const explicit = process.env.FYD_BIN;
  if (explicit !== undefined && explicit !== '') return resolve(REPOSITORY_ROOT, explicit);
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64-baseline';
  return join(REPOSITORY_ROOT, 'dist', 'bin', `fyd-${platform}-${architecture}`);
}

/** A default install's document, advertising `publicUrl` — the address BOTH machines announce. */
function daemonDocument(bindPort: number, publicUrl: string, appOrigin: string): string {
  return `${JSON.stringify(
    { publicUrl, corsOrigins: [appOrigin], carriers: [{ kind: 'bind', host: '127.0.0.1', port: bindPort }] },
    null,
    2,
  )}\n`;
}

/** The pairing fragment, re-hosted on the origin this run actually serves. */
function rehost(link: string, appOrigin: string): string {
  const hash = link.indexOf('#');
  if (hash === -1) throw new Error(`the minted pairing link carries no fragment: ${link}`);
  return `${appOrigin}/pair#${link.slice(hash + 1)}`;
}

interface Machine {
  readonly label: string;
  readonly session: string;
  readonly sessionName: string;
  readonly environment: E2eEnvironment;
  fingerprint: string;
  pairUrl: string;
}

/** Two boots, as a self-hosted relay's allowlist costs: one to mint the identity, one that gets in. */
async function bootMachine(
  machine: Machine,
  configPath: string,
  rendezvous: RendezvousProcess,
  directoryOrigin: string,
  appOrigin: string,
): Promise<void> {
  const { environment } = machine;
  const boot = async (): Promise<void> =>
    await environment.startDaemon({
      command: [compiledDaemon(), '--config', configPath],
      readyUrl: environment.httpUrl('/v1/health'),
      timeoutMs: 30_000,
      env: { FY_RELAY_DIRECTORY_ORIGIN: directoryOrigin },
    });
  const before = await rendezvous.dialled();
  await boot();
  machine.fingerprint = await waitForDaemonFingerprint(rendezvous, before);
  await environment.stopDaemon();
  await rendezvous.allow(machine.fingerprint);
  await boot();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const rows = await rendezvous.sockets().catch(() => []);
    if (rows.some(row => row.rendezvous.includes(machine.fingerprint) && row.roles.includes('daemon'))) break;
    await Bun.sleep(100);
  }
  const minted = await environment.runFy(['pair', '--no-wait'], { FY_URL: environment.httpUrl() });
  const link = PAIRING_LINK.exec(`${minted.out}\n${minted.err}`)?.[0];
  if (link === undefined) throw new Error(`\`fy pair --no-wait\` printed no link for ${machine.label}: ${minted.err}`);
  machine.pairUrl = rehost(link, appOrigin);
}

/** Pair this browser with one machine, through the confirm screen an owner presses. */
async function pair(browser: BrowserSession, machine: Machine): Promise<void> {
  // A scanned QR is a fresh page load; a second link differing only in its fragment would not reload.
  await browser.page.goto('about:blank');
  await browser.page.goto(machine.pairUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  await browser.page.waitForSelector('[data-pairing-stage="confirm"]', { timeout: 20_000 }).catch(async () => {
    await mkdir(SHOTS_DIR, { recursive: true });
    await evidenceScreenshot(browser.page, join(SHOTS_DIR, `no-confirm-${machine.label}.png`));
    throw new Error(
      `the pairing link for ${machine.label} never reached its confirm screen at ` +
        `${await browser.page.evaluate<string>('location.href')}: ${await renderedDataAttributes(browser.page)}`,
    );
  });
  const pressed = await clickFirstPresent(browser.page, ['[data-pair-confirm]']);
  if (pressed === null)
    throw new Error(`no confirm control for ${machine.label}: ${await describeControls(browser.page, 'body')}`);
  const settled = await Promise.race([
    browser.page.waitForSelector('[data-pairing-stage="paired"]', { timeout: 45_000 }).then(() => 'paired'),
    browser.page.waitForSelector('[data-pairing-stage]', { state: 'detached', timeout: 45_000 }).then(() => 'left'),
  ]).catch(() => 'stuck');
  if (settled === 'stuck')
    throw new Error(
      `pairing ${machine.label} never settled: ${await renderedDataAttributes(browser.page)}; ` +
        `errors: ${browser.pageErrors.join(' | ') || 'none'}`,
    );
}

/** Give a pairing an owner label through Settings' own Display name control. */
async function label(browser: BrowserSession, appOrigin: string, machine: Machine): Promise<void> {
  await browser.page.goto(`${appOrigin}/d/${machine.fingerprint}/settings#host-checks`, {
    waitUntil: 'networkidle',
    timeout: 30_000,
  });
  await browser.page.click('summary[aria-label^="Manage "]', { timeout: 30_000 });
  await browser.page.focus('details[open] input', { timeout: 10_000 });
  await browser.page.evaluate(
    `(() => { const input = document.querySelector('details[open] input'); input.select(); })()`,
  );
  await browser.page.keyboard.type(machine.label);
  await browser.page.click('details[open] button[type="submit"]', { timeout: 10_000 });
  await browser.page.waitForSelector(`text=${machine.label}`, { timeout: 10_000 });
}

/** Everything one machine's section of the all-machines list says, as text. */
async function machineSection(browser: BrowserSession, machine: Machine): Promise<string> {
  const selector = `[data-sbar-machine-group="${machine.fingerprint}"]`;
  await browser.page.waitForSelector(`${selector} >> text=${machine.sessionName}`, { timeout: 30_000 });
  return (await browser.page.textContent(selector)) ?? '';
}

describe('two machines paired over one relay at the same advertised address', () => {
  it('should show each machine its own name and its own sessions, not the later-paired one twice', async () => {
    const teardown = harnessTeardown();
    try {
      await withE2eEnvironment(async studioEnvironment => {
        await withE2eEnvironment(async laptopEnvironment => {
          // Arrange — one rendezvous, one directory, ONE unreachable address both machines advertise.
          const rendezvous = await startRendezvous(studioEnvironment.paths.root, teardown);
          const directory = await startRelayDirectory();
          directory.publish(rendezvous.relayUrl);
          const sinkhole = await startDirectSinkhole(teardown);
          const served = await startPwaOrigin(await buildPwaBundle(directory.origin), teardown);
          const appOrigin = served.origin.replace('//127.0.0.1:', '//localhost:');

          const machines: Machine[] = [
            {
              label: 'studio',
              session: 'fy_s_e2estudio000000000001',
              sessionName: 'Studio agent',
              environment: studioEnvironment,
              fingerprint: '',
              pairUrl: '',
            },
            {
              label: 'laptop',
              session: 'fy_s_e2elaptop000000000001',
              sessionName: 'Laptop agent',
              environment: laptopEnvironment,
              fingerprint: '',
              pairUrl: '',
            },
          ];
          for (const machine of machines) {
            const configPath = join(machine.environment.paths.root, 'daemon.json');
            await writeFile(
              configPath,
              daemonDocument(machine.environment.ports.api, sinkhole.origin, appOrigin),
              'utf8',
            );
            await seedRunningSession(machine.environment.paths.fyHome, undefined, {
              sessionId: machine.session,
              name: machine.sessionName,
            });
            await bootMachine(machine, configPath, rendezvous, directory.origin, appOrigin);
          }
          const [studio, laptop] = machines as [Machine, Machine];
          should(studio.fingerprint).not.equal(laptop.fingerprint);
          // Both links advertise the one address, which is the owner's setup exactly.
          should(studio.pairUrl).containEql(encodeURIComponent(sinkhole.origin).slice(0, 10));

          // Act — pair the studio, then the laptop, from one browser.
          const browser = await launchChrome(teardown);
          await pair(browser, studio);
          await pair(browser, laptop);
          await label(browser, appOrigin, studio);
          await label(browser, appOrigin, laptop);

          // Assert — each machine's session page reaches ITS daemon.
          for (const machine of machines) {
            await browser.page.goto(`${appOrigin}/d/${machine.fingerprint}/session/${machine.session}`, {
              waitUntil: 'networkidle',
              timeout: 30_000,
            });
            await browser.page.waitForSelector(`text=${machine.sessionName}`, { timeout: 30_000 });
          }

          // And the all-machines list puts each session under its own machine, and only there.
          await browser.page.setViewportSize({ width: 1_440, height: 900 });
          await browser.page.goto(`${appOrigin}/d/${studio.fingerprint}/session/${studio.session}`, {
            waitUntil: 'networkidle',
            timeout: 30_000,
          });
          const studioSection = await machineSection(browser, studio);
          const laptopSection = await machineSection(browser, laptop);
          should(studioSection).containEql('studio');
          should(studioSection).containEql(studio.sessionName);
          should(studioSection).not.containEql(laptop.sessionName);
          should(laptopSection).containEql('laptop');
          should(laptopSection).containEql(laptop.sessionName);
          should(laptopSection).not.containEql(studio.sessionName);
          should(browser.pageErrors).eql([]);

          // Evidence — desktop and phone, light and dark.
          await mkdir(SHOTS_DIR, { recursive: true });
          const failures: string[] = [];
          for (const scheme of ['light', 'dark'] as const) {
            await browser.page.emulateMedia({ colorScheme: scheme });
            for (const viewport of [
              {
                name: 'desktop',
                width: 1_440,
                height: 900,
                path: `/d/${studio.fingerprint}/session/${studio.session}`,
              },
              { name: 'phone', width: 390, height: 844, path: `/d/${studio.fingerprint}` },
            ]) {
              await browser.page.setViewportSize({ width: viewport.width, height: viewport.height });
              await browser.page.goto(`${appOrigin}${viewport.path}`, { waitUntil: 'networkidle', timeout: 30_000 });
              for (const machine of machines)
                await browser.page.waitForSelector(`text=${machine.sessionName}`, { timeout: 30_000 });
              await Bun.sleep(500);
              // The session page asks for a passkey this journey has no authenticator for; the capture is of
              // the list behind it, so the prompt is dismissed the way a person would.
              await browser.page.evaluate(
                `[...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')]
                  .find(button => button.textContent?.trim() === 'Cancel')?.click()`,
              );
              await Bun.sleep(300);
              const failed = await evidenceScreenshot(
                browser.page,
                join(SHOTS_DIR, `two-machines-${viewport.name}-${scheme}.png`),
              );
              if (failed !== null) failures.push(`${viewport.name}/${scheme}: ${failed}`);
            }
          }
          should(failures).eql([]);
        });
      });
    } finally {
      await teardown.closeAll();
    }
  });
});
