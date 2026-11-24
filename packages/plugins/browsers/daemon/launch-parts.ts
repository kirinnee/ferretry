import type { LaunchPartSource } from '@ferretry/core-ferrets/contract';
import { type BrowsersConfig, stealthOn } from '../contract/index.ts';

/** The pane's browser variable (read by `instructions` and the browser prompt section): `1` stealth is on, `0` it is not. */
export const BROWSER_STEALTH_ENV = 'FY_BROWSER_STEALTH';

/**
 * `launch.parts`: what a launch says about the browser. `FY_BROWSER_STEALTH` is `1` only when the ONE stealth switch is
 * on in EFFECT (a held `on`, still waiting for the owner, reads as off), so the words a pane is given and what the
 * browser does come from the same fact. A file that cannot be read, or reads as nothing, fails closed to `0`.
 */
export const browserLaunchPart = (config: () => BrowsersConfig | undefined): LaunchPartSource => ({
  parts: async () => [{ kind: 'env', env: { [BROWSER_STEALTH_ENV]: stealthEnabled(config) ? '1' : '0' } }],
});

function stealthEnabled(config: () => BrowsersConfig | undefined): boolean {
  try {
    const current = config();
    return current !== undefined && stealthOn(current);
  } catch {
    return false;
  }
}
