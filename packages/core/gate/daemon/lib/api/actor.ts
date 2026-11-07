import type { HolderId } from '@ferretry/kernel/contract';
import {
  type ApiActor,
  deviceActor,
  ferretActor,
  type TokenClass,
  wardenActor,
} from '../../../contract/index.ts';

/**
 * Per-call actor attribution (today's `api/actor.ts`, with `peer:` renamed `ferret:` and `session` renamed `ferret`,
 * §1). Every authenticated call is attributed to WHOEVER caused it — the human via `fy` (`admin-cli`) or the app
 * (`admin-ui`), a warden (`warden:<its ferret>`), a ferret (`ferret:<id>`), or a device (`device:<holder>`). It is
 * resolved once at admission and handed to the handler, never read from an ambient context. Attribution only: it
 * never decides anything, because a header can move it.
 */
export interface ApiActorInput {
  readonly tokenClass: TokenClass;
  /** The kernel-stamped holder, present only for a device. */
  readonly holder?: HolderId;
  /**
   * The acting pane's own ferret id: for a ferret token it is the ferret the TOKEN names, never a header's; for the
   * admin token or the warden token it is the `x-ferretry-session-id` self-identification.
   */
  readonly ferret?: string;
  /** Client self-identification, e.g. `cli`. The browser sends nothing, so absent plus an admin token means the app. */
  readonly client?: string;
}

/** Today's `resolveApiActor`. Never answers `daemon`: a call always has a human or an agent behind it. */
export function resolveApiActor(input: ApiActorInput): ApiActor {
  if (input.tokenClass === 'device') {
    const holder = input.holder?.trim();
    return holder === undefined || holder === '' ? 'device' : deviceActor(holder);
  }
  const ferret = input.ferret?.trim();
  if (input.tokenClass === 'ferret') return ferretActor(ferret ?? '');
  if (input.tokenClass === 'warden') return ferret === undefined || ferret === '' ? 'warden' : wardenActor(ferret);
  if (ferret !== undefined && ferret !== '') return ferretActor(ferret);
  return input.client?.trim() === 'cli' ? 'admin-cli' : 'admin-ui';
}
