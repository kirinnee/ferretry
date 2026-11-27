import type { Loosens } from '@ferretry/kernel/contract';
import { type BrowserProxySetting, type BrowsersConfig, stealthOn } from './wire.ts';

const PROXY_SENTENCE = (url: string): string => `the agent browser now sends its traffic through the proxy at ${url}`;
/** What a held machine-wide `off` → `on` says; the Browser tab reads it from the kernel's pending list to know the switch is NOT in effect. */
export const STEALTH_LOOSENING =
  'the agent browser now passes bot checks and solves captchas for the owner’s identities';
/** A solver key newly named: the browser may now spend the owner's CapSolver balance (up to the monthly cap) on captchas. */
const CAPTCHA_SENTENCE = 'the agent browser may now spend your CapSolver balance on solving captchas, up to $5 a month';
const IDENTITY_STEALTH_LOOSENING =
  'an identity that opted out of stealth now passes bot checks and solves captchas too';

/**
 * `browsers.yaml` loosens when a proxy is newly set, pointed somewhere else, or given other credentials: today's
 * `browserProxyLoosening` (machine.yaml), word for word. The proxy sees every host the browser visits, and its
 * credential references are sent to whatever address is written, so an agent able to write the file could otherwise aim
 * a stored secret at a server of its choosing. Removing a proxy, or editing only its bypass list or the browser mode,
 * hands an agent nothing it did not have. A first file (no before) that names a proxy is a newly set one.
 *
 * It also loosens when stealth comes ON for anybody: the machine-wide switch going `off` → `on`, or an identity's opt-out
 * being dropped while it is on. Stealth spends money (a solver) and changes what the browser does, so it waits for the
 * owner. `on` → `off`, and a new opt-out, tighten and apply at once.
 */
const proxyMoved = (was: BrowserProxySetting | undefined, proxy: BrowserProxySetting | undefined): boolean =>
  proxy !== undefined &&
  !(was !== undefined && was.url === proxy.url && was.username === proxy.username && was.password === proxy.password);

export const browsersLoosens: Loosens<BrowsersConfig> = (before, after) => {
  const sentences: string[] = [];
  if (proxyMoved(before?.proxy, after.proxy) && after.proxy !== undefined)
    sentences.push(PROXY_SENTENCE(after.proxy.url));
  // An identity's own proxy is the same act for that identity: it sees every host that identity's browser visits.
  for (const [identity, setting] of Object.entries(after.identities ?? {}))
    if (proxyMoved(before?.identities?.[identity]?.proxy, setting.proxy) && setting.proxy !== undefined)
      sentences.push(
        `the ${identity} browser identity now sends its traffic through the proxy at ${setting.proxy.url}`,
      );
  if (after.captcha !== undefined && before?.captcha === undefined) sentences.push(CAPTCHA_SENTENCE);
  const machineNewlyOn = stealthOn(after) && (before === undefined || !stealthOn(before));
  if (machineNewlyOn) sentences.push(STEALTH_LOOSENING);
  else {
    const identities = new Set([...Object.keys(before?.identities ?? {}), ...Object.keys(after.identities ?? {})]);
    // The machine switch was already on: only an identity coming back in (its opt-out dropped) is new, and it is a different thing to wait for.
    if (
      [...identities].some(
        identity => stealthOn(after, identity) && before !== undefined && !stealthOn(before, identity),
      )
    )
      sentences.push(IDENTITY_STEALTH_LOOSENING);
  }
  return sentences;
};
