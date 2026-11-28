import type { Actor } from './act.ts';
import type { PolicyRef } from './policy.ts';
import type { RootName } from './ports/roots.ts';
import type { CallStanding } from './route.ts';

/** Allows a plugin to ASK for a write pin, under this capability's configure axis; never grants caller authority. */
export interface WritePinPermission {
  readonly root: RootName;
  readonly capability: PolicyRef<'capability'>;
}

/** The kernel's question to Gate immediately before minting or using an explicitly requested write pin. */
export interface RootWriteJudgement extends WritePinPermission {
  readonly plugin: string;
  readonly actor: Actor;
  readonly standing?: CallStanding;
}
