/**
 * The `usage` module's route contract. It contributes no route and no socket (the base `/usage` feed is the
 * kernel's, and the quota and budget numbers reach a screen through the fleet routes), so it has no caller line and
 * no audit rule to answer for. See the README at the top of `../route-contracts.ts`.
 */
export const callers: readonly string[] = [];

export const notAudited: Readonly<Record<string, string>> = {};
