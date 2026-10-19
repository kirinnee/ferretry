import { readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'bun:test';
import should from 'should';
import { withE2eEnvironment } from './fixture';
import {
  launchReleaseBrowser,
  type ReleaseBrowser,
  type ReleasePage,
  release,
  screenshotMatrix,
  startReleaseOrigin,
  throwawayKey,
  viteBuild,
  waitInPage,
} from './support/pwa-release';
import { harnessTeardown } from './support/relay-harness';
import { retryOnLostBrowser } from './support/product-harness';

/**
 * Signed PWA releases (#462), verified by the service worker in a real Chrome.
 *
 * The real build, the real release step and the real CI signer produce every release; only the
 * TRUST ROOT is a throwaway key made for this run (see `support/pwa-release.ts`). One origin serves
 * the releases one after another, because what the worker remembers — the release it installed, the
 * sequence it will not go below — is per origin.
 *
 * THE PAGE IS NOT ON A LOOPBACK NAME. The worker deliberately relaxes on `localhost` and `127.x`
 * (docs/pwa-release-signing.md): an unsigned build there is "unverified" and nothing is refused,
 * which is right for a developer and would make every refusal below vacuous. So Chrome maps a
 * `.test` name to 127.0.0.1 and treats it as a secure context — no DNS, nothing off the machine.
 */

const HOST = 'fy-e2e-release.test';
/** Screenshots land under `$FY_E2E_SHOTS_ROOT/signed-pwa` (default: the system temp directory). */
const SHOTS = join(process.env.FY_E2E_SHOTS_ROOT ?? join(tmpdir(), 'fy-e2e-shots'), 'signed-pwa');
/** Never a real service: the bundle's relay discovery is pointed at a closed loopback port. */
const DEAD_DIRECTORY = 'http://127.0.0.1:9';
const NOTICE = '[data-release-notice]';
const TAMPER_MARKER = '__fyE2eTampered';
/** A second, different build: the same source with a different (equally dead) directory origin compiled in. */
const OTHER_DEAD_DIRECTORY = 'http://127.0.0.1:1';

/** The words the banner uses for each refusal (`RELEASE_REFUSAL_WORDS`), checked as the user reads them. */
const WORDS = {
  unsigned: 'it was not signed',
  older: 'it is not newer than the version you have',
  tampered: 'one of its files was not the file that was signed',
} as const;

/** Asks the controlling worker to check now, and returns what it decided. */
async function checkNow(page: ReleasePage): Promise<{ status: string; refusal?: string; hadRelease?: boolean } | null> {
  return await page.evaluate(`(async () => {
    const registration = await navigator.serviceWorker.ready;
    const channel = new MessageChannel();
    return await new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), 20000);
      channel.port1.onmessage = event => { clearTimeout(timer); resolve(event.data.outcome ?? null); };
      registration.active.postMessage({ type: 'fy-release-check' }, [channel.port2]);
    });
  })()`);
}

/** The release caches the worker holds, named `fy-release-<commit>-<sequence>`. */
async function releaseCaches(page: ReleasePage): Promise<readonly string[]> {
  return (await page.evaluate<string[]>('caches.keys()')).filter(name => name.startsWith('fy-release-')).toSorted();
}

/** Loads the app and waits until the release worker controls it. */
async function openControlled(page: ReleasePage, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  await waitInPage(page, 'navigator.serviceWorker.controller !== null').catch(async () => {
    // The first visit installs; a reload is what puts the page under the worker it installed.
    await page.reload({ waitUntil: 'load', timeout: 60_000 });
    await waitInPage(page, 'navigator.serviceWorker.controller !== null');
  });
}

/** What the banner says, once it has appeared. */
async function noticeText(page: ReleasePage): Promise<string> {
  await page.waitForSelector(NOTICE, { timeout: 30_000 });
  return (await page.textContent(NOTICE)) ?? '';
}

/**
 * Changes, AFTER signing, a script this release changed relative to `installed`.
 *
 * It has to be a CHANGED file. The worker reuses its cached copy of every file whose signed hash is
 * the same as the installed release's and never fetches it, so altering an unchanged file on the
 * server is invisible to it — which is correct, and is why a tampered update needs a second build.
 */
async function tamperChangedScript(directory: string, installed: string): Promise<string> {
  const files = async (release: string): Promise<Record<string, string>> =>
    (JSON.parse(await readFile(join(release, 'release-manifest.json'), 'utf8')) as { files: Record<string, string> })
      .files;
  const [next, previous] = await Promise.all([files(directory), files(installed)]);
  const changed = Object.keys(next).find(
    path => path.startsWith('assets/') && path.endsWith('.js') && next[path] !== previous[path],
  );
  if (changed === undefined) throw new Error('the second build changed no script, so there is nothing to tamper with');
  const path = join(directory, changed);
  await writeFile(path, `globalThis.${TAMPER_MARKER}=true;\n${await readFile(path, 'utf8')}`, 'utf8');
  return changed;
}

async function tamperVisible(page: ReleasePage): Promise<boolean> {
  return await page.evaluate<boolean>(`globalThis.${TAMPER_MARKER} === true`);
}

describe('signed PWA releases in a real browser', () => {
  it('should load a signed release, refuse tampered, unsigned and older ones, and keep serving offline', () =>
    retryOnLostBrowser('signed-pwa', async () => {
      const teardown = harnessTeardown();
      try {
        await withE2eEnvironment(async environment => {
          // Arrange — one build, released five ways under one throwaway trust root.
          const root = environment.paths.root;
          const key = await throwawayKey(join(root, 'keys'), 'release');
          const build = await viteBuild(join(root, 'vite'), DEAD_DIRECTORY);
          const good = await release({
            build,
            into: join(root, 'good'),
            key,
            sequence: 2,
            commit: 'bbbbbbb',
            sign: true,
          });
          const nextBuild = await viteBuild(join(root, 'vite-next'), OTHER_DEAD_DIRECTORY);
          const tampered = await release({
            build: nextBuild,
            into: join(root, 'tampered'),
            key,
            sequence: 3,
            commit: 'ccccccc',
            sign: true,
          });
          const tamperedFile = await tamperChangedScript(tampered, good);
          const unsigned = await release({
            build,
            into: join(root, 'unsigned'),
            key,
            sequence: 4,
            commit: 'ddddddd',
            sign: false,
          });
          const older = await release({
            build,
            into: join(root, 'older'),
            key,
            sequence: 1,
            commit: 'aaaaaaa',
            sign: true,
          });
          should((await readFile(join(unsigned, 'release-manifest.sig'), 'utf8')).trim()).equal('unsigned');

          const origin = await startReleaseOrigin(teardown);
          const browser: ReleaseBrowser = await launchReleaseBrowser(teardown, {
            host: { name: HOST, port: origin.port },
          });
          const { page } = browser;
          const app = `http://${HOST}:${String(origin.port)}/app`;

          // Act 1 — a signed release, first visit.
          origin.serve(good);
          await openControlled(page, app);
          const installed = await checkNow(page);
          await page.reload({ waitUntil: 'load' });
          await Bun.sleep(1_000);

          // Assert 1 — verified, cached under its own commit and sequence, and nothing to warn about.
          should(installed?.status).be.oneOf('current', 'updated');
          should(await releaseCaches(page)).eql(['fy-release-bbbbbbb-2']);
          should(await page.evaluate<number>(`document.querySelectorAll('${NOTICE}').length`)).equal(0);
          await screenshotMatrix(page, SHOTS, '1-signed-release-loaded');

          // Act 2 — the next release has a file changed after it was signed.
          origin.serve(tampered);
          const tamperedOutcome = await checkNow(page);
          await page.reload({ waitUntil: 'load' });
          const tamperedNotice = await noticeText(page);

          // Assert 2 — refused by name, the old release still served, the changed file never shown.
          should(tamperedFile).startWith('assets/');
          should(tamperedOutcome).containEql({ status: 'refused', refusal: 'hash-mismatch', hadRelease: true });
          should(tamperedNotice).containEql('An update failed verification');
          should(tamperedNotice).containEql(WORDS.tampered);
          should(tamperedNotice).containEql('You are still using the version you had');
          should(await tamperVisible(page)).be.false();
          should(await releaseCaches(page)).eql(['fy-release-bbbbbbb-2']);
          await screenshotMatrix(page, SHOTS, '2-tampered-refused', NOTICE);

          // Act 3 — the next release is not signed at all.
          origin.serve(unsigned);
          const unsignedOutcome = await checkNow(page);
          await page.reload({ waitUntil: 'load' });
          const unsignedNotice = await noticeText(page);

          // Assert 3
          should(unsignedOutcome).containEql({ status: 'refused', refusal: 'unsigned', hadRelease: true });
          should(unsignedNotice).containEql(WORDS.unsigned);
          should(unsignedNotice).containEql('You are still using the version you had');
          should(await releaseCaches(page)).eql(['fy-release-bbbbbbb-2']);
          await screenshotMatrix(page, SHOTS, '3-unsigned-refused', NOTICE);

          // Act 4 — a validly signed but OLDER release: the rollback a compromised host would serve.
          origin.serve(older);
          const olderOutcome = await checkNow(page);
          await page.reload({ waitUntil: 'load' });
          const olderNotice = await noticeText(page);

          // Assert 4
          should(olderOutcome).containEql({ status: 'refused', refusal: 'older', hadRelease: true });
          should(olderNotice).containEql(WORDS.older);
          should(await releaseCaches(page)).eql(['fy-release-bbbbbbb-2']);
          await screenshotMatrix(page, SHOTS, '4-rollback-refused', NOTICE);

          // Act 5 — the network is gone: the browser is offline AND the origin answers nothing.
          origin.serve(undefined);
          await browser.setOffline(true);
          await page.reload({ waitUntil: 'load', timeout: 30_000 });
          await Bun.sleep(1_000);

          // Assert 5 — the verified release still renders the app.
          const offlineBody = await page.evaluate<string>('document.body.innerText');
          should(offlineBody.trim().length).be.above(0);
          should(offlineBody).not.containEql('could not be checked against its signed release');
          should(await page.evaluate<number>("document.querySelectorAll('#root *').length")).be.above(10);
          await screenshotMatrix(page, SHOTS, '5-offline-after-first-load');
          await browser.setOffline(false);
        });
      } finally {
        await teardown.closeAll();
      }
    }));

  it('should tell a first visitor that an unsigned copy could not be checked', () =>
    retryOnLostBrowser('signed-pwa', async () => {
      const teardown = harnessTeardown();
      try {
        await withE2eEnvironment(async environment => {
          // Arrange — a browser that has never seen this site meets an unsigned build.
          const root = environment.paths.root;
          const key = await throwawayKey(join(root, 'keys'), 'release');
          const build = await viteBuild(join(root, 'vite'), DEAD_DIRECTORY);
          const unsigned = await release({
            build,
            into: join(root, 'unsigned'),
            key,
            sequence: 1,
            commit: 'eeeeeee',
            sign: false,
          });
          const origin = await startReleaseOrigin(teardown);
          const { page } = await launchReleaseBrowser(teardown, { host: { name: HOST, port: origin.port } });
          origin.serve(unsigned);

          // Act
          await openControlled(page, `http://${HOST}:${String(origin.port)}/app`);
          const outcome = await checkNow(page);
          await page.reload({ waitUntil: 'load' });
          const notice = await noticeText(page);

          // Assert — nothing installed, so nothing cached, and the visitor is told plainly.
          should(outcome).containEql({ status: 'refused', refusal: 'unsigned', hadRelease: false });
          should(notice).containEql('This copy of the app could not be checked because it was not signed');
          should(await releaseCaches(page)).eql([]);
          await screenshotMatrix(page, SHOTS, '0-first-visit-unsigned', NOTICE);
          should((await readdir(SHOTS)).length).be.above(3);
        });
      } finally {
        await teardown.closeAll();
      }
    }));
});
