import type { StateDamage } from '../../contract/index.ts';

/**
 * A subsystem answers `store_damaged`, naming the file, and never as if the file were empty (§9.3). Thrown by the
 * calls that cannot return a result (`write`, `append`, `lines`, `sqlite`); `read` and `update` return the damage.
 */
export class StoreDamagedError extends Error {
  constructor(readonly damage: StateDamage) {
    super(damage.sentence);
    this.name = 'StoreDamagedError';
  }
}

/** A plugin asked for a file it did not declare, or named a file wrongly: a bug in the half, refused at once. */
export class UndeclaredStateFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UndeclaredStateFileError';
  }
}
