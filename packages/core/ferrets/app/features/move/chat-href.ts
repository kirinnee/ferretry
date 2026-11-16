/**
 * GAP(app): `screenHref` (the shell's address of a screen) is not exported by `@ferretry/app` yet. Until it lands, the
 * ferret's chat address is built from the route table's documented shape: a per-daemon screen lives at
 * `/d/<daemon>/<path>`, and Conversation's chat is `ferrets/:ferret/chat`. Replace this file with `screenHref`.
 */
export const chatHref = (daemon: string, ferret: string): string =>
  `/d/${encodeURIComponent(daemon)}/ferrets/${encodeURIComponent(ferret)}/chat`;
