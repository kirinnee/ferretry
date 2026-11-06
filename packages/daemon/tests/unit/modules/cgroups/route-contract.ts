/**
 * The `cgroups` module's route contract: who may call each of its routes, and which of its mutating routes the
 * security log deliberately does not record. See the README at the top of `../route-contracts.ts`.
 *
 * Its one route only reads (`limits.yaml` is the configuration files' writer's), so it has no audit rule and no
 * line in `notAudited`.
 */
export const callers: readonly string[] = ['GET /v1/cgroups/config operator any'];

export const notAudited: Readonly<Record<string, string>> = {};
