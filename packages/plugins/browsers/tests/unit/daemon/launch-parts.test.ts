import { describe, expect, test } from 'bun:test';
import type { LaunchSpec } from '@ferretry/core-ferrets/contract';
import type { BrowsersConfig } from '../../../contract/index.ts';
import { BROWSER_STEALTH_ENV, browserLaunchPart } from '../../../daemon/launch-parts.ts';

const spec = {} as unknown as Omit<LaunchSpec, 'parts'>;
const config = (stealth: 'on' | 'off'): BrowsersConfig => ({ mode: 'headless', stealth });
const part = (value: '0' | '1') => [{ kind: 'env' as const, env: { FY_BROWSER_STEALTH: value } }];
const launched = async (read: () => BrowsersConfig | undefined) => await browserLaunchPart(read).parts(spec);

describe('browsers launch.parts: FY_BROWSER_STEALTH', () => {
  test('the variable is the one the prompt reads', () => {
    expect(BROWSER_STEALTH_ENV).toBe('FY_BROWSER_STEALTH');
  });

  test('stealth on in effect is launched with FY_BROWSER_STEALTH=1', async () => {
    expect(await launched(() => config('on'))).toEqual(part('1'));
  });

  test('stealth off is launched with FY_BROWSER_STEALTH=0', async () => {
    expect(await launched(() => config('off'))).toEqual(part('0'));
  });

  test('a held on is not in effect: the version in effect still says off, so the launch says 0', async () => {
    // The kernel keeps the tighter version in effect while an `on` waits for the owner; `config()` reads that version.
    let inEffect = config('off');
    expect(await launched(() => inEffect)).toEqual(part('0'));
    inEffect = config('on'); // the owner confirmed
    expect(await launched(() => inEffect)).toEqual(part('1'));
  });

  test('a file that is missing or unreadable fails closed to 0', async () => {
    expect(await launched(() => undefined)).toEqual(part('0'));
    expect(
      await launched(() => {
        throw new Error('unreadable');
      }),
    ).toEqual(part('0'));
  });
});
