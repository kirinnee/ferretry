/**
 * @ferretry/plugin-lessons/contract: wire schemas, state and config declarations, port + token, events (§2.1).
 * Lessons owns lessons, suggestions and approvals (§2.3): a rule learned from a correction, the owner's verdict on it,
 * and the Apply that writes it into the Global lessons document or a project's AGENTS.md / CLAUDE.md.
 */
export * from './config.ts';
export * from './global.ts';
export * from './policy.ts';
export * from './port.ts';
export * from './state.ts';
export * from './suggest.ts';
export * from './wire.ts';
