import type { ApiRequest } from '@ferretry/kernel/contract';

/** What the kernel stamps on a request that reaches the connector's own listener (never `local`, never privileged). */
export const OWN_DOOR = Object.freeze({
  kind: 'door',
  door: 'own',
  plugin: 'connector',
}) as unknown as ApiRequest['arrival'];
/** The same for the built-in tunnel's listener. */
export const TUNNEL_DOOR = Object.freeze({ kind: 'door', door: 'tunnel' }) as unknown as ApiRequest['arrival'];
