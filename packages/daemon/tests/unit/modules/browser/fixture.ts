import { type BrowserNeeds, browserModule, type BrowserProvides } from '../../../../bin/modules/browser.ts';
import type { BuiltModule, ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';
import { FakeBrowserLogin } from '../../runtime/mounts/support.ts';

/**
 * THE `browser` MODULE'S TEST CONSTRUCTION — a per-module fixture fragment (see `../learning/fixture.ts`).
 *
 * The REAL `browserModule.build(needs, seams, lifecycle)` over test inputs, so the route snapshot and the contract
 * checks consume what production builds. Only the INPUTS are doubles: a session directory that holds no session, a
 * launcher that is never asked to start anything, the in-memory sign-in window the surface tests already use, and
 * proxy ports that read nothing. NO CHROME AND NO BROWSER WORKER EVER RUN HERE: the launcher double throws if asked.
 *
 * Building starts nothing — the session service holds no timer until a page opens (the idle stop is armed by the first
 * act) and the proxy probe dials only when a test is requested — so there is no timer or async work to leave behind
 * in the shared unit process (CI runs every non-PWA unit test in ONE process, and a leftover timer breaks
 * `unit-determinism.test.ts`).
 */

const NOT_EXERCISED = (what: string) => () => {
  throw new Error(`${what} is not exercised by the mounted-surface fixture`);
};

/** The inputs `fyd.ts` hands the module, over doubles. */
function browserNeedsForTest(): BrowserNeeds {
  return {
    sessions: { get: async () => undefined },
    launcher: { launch: async () => NOT_EXERCISED('a browser launch')() },
    login: new FakeBrowserLogin(),
    signIns: { cleared: () => undefined, forget: () => undefined },
    pairing: { live: { look: () => ({ live: false, minted: 0 }) }, appOrigins: () => [] },
    proxy: { saved: async () => undefined, secrets: async () => new Map() },
    firewall: async () => undefined,
  };
}

const LIFECYCLE: ModuleLifecycle = { onRelease: () => undefined, releasing: () => false };

/** The module as production builds it, over the fixture's inputs. */
export function builtBrowser(): BuiltModule<BrowserProvides> {
  return browserModule.build(browserNeedsForTest(), undefined, LIFECYCLE);
}
