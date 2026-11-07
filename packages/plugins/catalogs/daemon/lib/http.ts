import type { ApiRoute as KernelRoute } from '@ferretry/kernel/contract';
export type { CallContext as RouteContext } from '@ferretry/kernel/contract';
export type ApiRoute = Omit<KernelRoute, 'audit' | 'guard'>;
export { isFerretCall as isAgentCaller } from '@ferretry/core-gate/contract';
export { ApiError, jsonResponse, decodeParameter, queryValue } from '@ferretry/kernel/contract';
