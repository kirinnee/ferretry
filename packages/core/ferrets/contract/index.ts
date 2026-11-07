/**
 * `@ferretry/core-ferrets/contract` (§2.2, §4.3, §4.4, §4.6): ferret identity and state, the harness, runner (with
 * `attach`, spine D15) and login kinds, the launch and sitrep hooks, `ferret.changed`, the Ferrets port and its files.
 * Re-exports the kernel-bound `WorkFolders` port Ferrets provides (spine D4).
 */
export {
  type FencedPath,
  type FolderRefusal,
  type WorkFolders,
  WorkFoldersPort,
} from '@ferretry/kernel/contract';
export * from './hooks.ts';
export * from './ids.ts';
export * from './kinds.ts';
export * from './port.ts';
export * from './records.ts';
export * from './slots.ts';
export * from './state.ts';
export * from './transfer.ts';
export * from './subtree.ts';
