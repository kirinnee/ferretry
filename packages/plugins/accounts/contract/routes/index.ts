/**
 * Accounts' own wire, shared by its daemon, app and CLI halves (today's `packages/protocol/src/lib/{account-ids,
 * accounts,login-entries,login-recipes,two-factor}.ts`, copied). Package-internal: another plugin reads Accounts only
 * through `@ferretry/plugin-accounts/contract`, whose index does not re-export this folder. Nothing here has a field
 * for a saved value.
 */
export * from './account-ids.ts';
export * from './accounts.ts';
export * from './common.ts';
export * from './login-entries.ts';
export * from './login-recipes.ts';
export * from './two-factor.ts';
