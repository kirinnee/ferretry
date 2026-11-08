/**
 * A REQUEST CLIENT FOR ONE PUBLISHER, AS A CATALOG MEMBER.
 *
 * A member session is a request session on the member route table (`/v1/shared/*`) and nothing else
 * (docs/relay-protocol.md §14 "Member sessions"). The surfaces call `request(path, schema, init)`; how the session
 * reaches the publisher (its own address, then whatever relays it published, then the discovered rendezvous) is a
 * carrier matter the shell's member transport answers (`member-transport.ts`).
 *
 * TWO REFUSALS ARE TOLD APART FROM EVERYTHING ELSE, because a person must never be left guessing:
 *
 * - `MemberRefusedError`: the publisher refused this KEY (`4403` on a new session, `401 unauthorized` on an
 *   open one). Nothing here deletes anything on it; the caller marks the subscription and asks the person.
 * - `MemberUnreachableError`: no carrier reached the publisher. The key may be perfectly good.
 *
 * Every other answer is the publisher's own, as a `DaemonCallError` whose `code` is the top-level `code` of
 * its `{ error, code }` body (`member_locked`, `member_registration_closed`, `share_other_member`, …).
 */

import type { z } from 'zod';

/** The publisher refused this browser's key. Final: another carrier would be told the same. */
export class MemberRefusedError extends Error {
  constructor() {
    super('the publisher no longer accepts this browser');
    this.name = 'MemberRefusedError';
  }
}

/** No carrier reached the publisher. Says nothing about the key. */
export class MemberUnreachableError extends Error {
  constructor(readonly tried: number) {
    super('no way of reaching the publisher answered');
    this.name = 'MemberUnreachableError';
  }
}

/** What a member surface calls. `request` has the catalog surfaces' shape; `close` ends the session. */
export interface MemberClient {
  request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T>;
  close(): void;
}
