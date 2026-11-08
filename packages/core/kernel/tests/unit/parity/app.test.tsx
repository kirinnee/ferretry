/**
 * Parity rows S-* that the kernel owns (docs/design/rebuild-parity.tsv): the configuration-files screen, the machine
 * health and secrets panels, and the shell's per-daemon routes. The kernel has no app half (`packages/core/kernel`
 * ships a contract, a host and a manifest SDK, no `app/`), and its package does not depend on `@ferretry/app`, so no
 * screen can be mounted from here without faking one. What the kernel does serve is the data those screens read
 * (`GET /v1/config/status`, `GET` and `PUT /v1/config/file`, `GET /v1/doctor`); a route is not a screen, so these rows
 * stay open until the screens exist. Each skip names every row id of its screen and who really owns it.
 */
import { describe, test } from 'bun:test';

describe('the app surfaces the kernel owns', () => {
  test.skip('S-0067 S-0068 S-0302 S-0417 S-0478 S-0479 the configuration files screen (panel, surface, Files tab, Configuration files link) — pending port: kernel app half', () => {});
  test.skip('S-0416 S-0419 S-0488 the Health group of the machine settings (doctor and host-checks panels, Host checks tab) — pending port: kernel app half', () => {});
  test.skip('S-0214 S-0265 the Secrets panel and the machine settings Surface that hosts the panels — pending port: kernel app half', () => {});
  test.skip('S-0223 the Secure copy panel — not the kernel’s: accounts declares the secure-copy settings tab', () => {});
  test.skip('S-0107 the Grants panel — not the kernel’s: access holds grants-settings, not yet reached by a settings tab', () => {});
  test.skip('S-0370 S-0381 the daemon home and daemon settings routes — not the kernel’s: the app shell routes (daemonHomeHref, daemonSettingsHref) own them', () => {});
  test.skip('S-0382 the daemon sharing route with its tab — not the kernel’s: catalogs declares sharing/:tab?', () => {});
  test.skip('S-0371 the imported history route — not the kernel’s: conversation links replaced it', () => {});
  test.skip('S-0373 the machine setup route — pending port: no plugin declares a setup screen', () => {});
});
