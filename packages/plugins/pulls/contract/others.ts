/**
 * STAND-IN for a plugin contract this one may not depend on (the same one Agenda keeps, `agenda/contract/others.ts`).
 * The watch `uses` Access (§2.3) to buzz the owner's phone; the port is Access's. The generator matches ports by name, so
 * this has the same name. A real dependency on `@ferretry/plugin-access` would change the Bun install digest and with it
 * the pinned Nix hash on every merge, so the shape of what is used is restated here instead: only what the watch calls.
 */
import { definePort } from '@ferretry/kernel/contract';

export interface AccessBuzzApi {
  /** Sends one push to every live enrolment; resolves how many devices it reached. */
  buzz(message: {
    readonly tag: string;
    readonly title: string;
    readonly body: string;
    readonly url: string;
    /** Names the ONE event the buzz is about (never its `tag`). */
    readonly eventKey?: string;
    /** What the push is about, for the device's own filter (Agenda's "PRs & CI" switch). */
    readonly kind?: 'pr' | 'ci';
  }): Promise<number>;
}
export const AccessPort = definePort<AccessBuzzApi>('access');
