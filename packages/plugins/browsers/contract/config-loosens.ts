import type { Loosens } from '@ferretry/kernel/contract';
import { type BrowsersConfig, stealthOn } from './wire.ts';

const PROXY_SENTENCE = (url: string): string => `the agent browser now sends its traffic through the proxy at ${url}`;
const STEALTH_LOOSENING = 'the agent browser now passes bot checks and solves captchas for the owner’s identities';

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
export const browsersLoosens: Loosens<BrowsersConfig> = (before, after) => {
  const sentences: string[] = [];
  const proxy = after.proxy;
  const was = before?.proxy;
  const same =
    proxy === undefined ||
    (was !== undefined && was.url === proxy.url && was.username === proxy.username && was.password === proxy.password);
  if (proxy !== undefined && !same) sentences.push(PROXY_SENTENCE(proxy.url));
  const identities = new Set([...Object.keys(before?.identities ?? {}), ...Object.keys(after.identities ?? {})]);
  const newlyOn = [undefined, ...identities].some(
    identity => stealthOn(after, identity) && (before === undefined || !stealthOn(before, identity)),
  );
  if (newlyOn) sentences.push(STEALTH_LOOSENING);
  return sentences;
};
