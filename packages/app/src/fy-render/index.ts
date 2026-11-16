/**
 * `@ferretry/app` — the numbers, palette and HTML kit the fy-render sandbox shells and Conversation's block
 * renderer agree on. They live in the app package because the sandbox shells are built here (`scripts/fy-render-shell`)
 * and a package reaches another only through a contract or a package export; Conversation imports them from here.
 * Each is a module with no dependency but the Conversation contract's caps, so a shell bundle stays small.
 */
export * from './bounds.ts';
export * from './html-kit.ts';
export * from './palette.ts';
