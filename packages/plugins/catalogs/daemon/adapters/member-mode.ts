import type { HolderId, ModeRedemption, SessionId, SessionMode } from '@ferretry/kernel/contract';
import type { CredentialProvider } from '@ferretry/core-gate/contract';
import { InstantSchema } from '@ferretry/std';
import type { MemberJoinProof } from '../lib/boundary.ts';
import type { CatalogMemberService } from '../lib/catalog-members/service.ts';
import type { MemberPasskeyService } from '../lib/catalog-members/passkeys.ts';
import type { MemberJoinGate } from '../lib/catalog-members/join.ts';
import type { LiveMemberSessions } from '../lib/catalog-members/sessions.ts';
import type { MemberJoinCarrier } from './member-session.ts';

/** The kernel's `MemberRedemptionBody`, with the passkey proof typed as Catalogs reads it. */
type MemberRedemptionBody =
  | {
      readonly act: 'join';
      readonly code: string;
      readonly clientName: string;
      readonly memberKey: string;
      readonly boxKey: string;
      readonly passkey?: MemberJoinProof;
    }
  | { readonly act: 'join-options'; readonly code: string; readonly memberKey: string; readonly origin: string };

export function memberMode(deps: {
  members: CatalogMemberService;
  passkeys: MemberPasskeyService;
  join: MemberJoinGate;
  live: LiveMemberSessions;
}) {
  const pages = new Map<SessionId, { readonly keyId: string; readonly appSession: string }>();
  let generation = 0;
  let previous = '';
  const credentials: CredentialProvider = {
    standing(holder) {
      const access = deps.members.accessNow(holder);
      if (access === undefined) return 'unknown';
      const until = deps.passkeys.unlockExpiresAt(access.keyId);
      return {
        kind: 'member',
        holder,
        catalogs: access.catalogIds,
        ...(until === undefined ? {} : { unlockedUntil: InstantSchema.parse(new Date(until).toISOString()) }),
      };
    },
    generation() {
      const next = `${deps.members.generation()}:${deps.passkeys.generation()}`;
      if (next !== previous) {
        previous = next;
        generation += 1;
      }
      return generation;
    },
  };
  const mode: SessionMode = {
    principalKind: 'member',
    async holder(proof) {
      if (proof.mode !== 'member' || typeof proof.body !== 'object' || proof.body === null) return undefined;
      const keyId = (proof.body as { keyId?: unknown }).keyId;
      if (typeof keyId !== 'string') return undefined;
      const access = await deps.members.access(keyId);
      return access === undefined ? undefined : { holder: keyId as HolderId, key: access.memberKey };
    },
    watch(holder, watch) {
      const access = deps.members.accessNow(holder);
      if (access === undefined) return undefined;
      const release = deps.live.track(access.memberId, access.keyId, () => watch.revoked(), watch.session);
      const checked = deps.members.accessNow(holder);
      if (checked === undefined || checked.memberId !== access.memberId) {
        release();
        return undefined;
      }
      pages.set(watch.session, { keyId: access.keyId, appSession: watch.appSession });
      void deps.members.touchKey(access.keyId).catch(() => undefined);
      return () => {
        release();
        pages.delete(watch.session);
      };
    },
    async redeem(attempt: ModeRedemption) {
      if (attempt.proof.mode !== 'member' || typeof attempt.proof.body !== 'object' || attempt.proof.body === null)
        return 'refused';
      const body = attempt.proof.body as MemberRedemptionBody;
      const carrier: MemberJoinCarrier =
        attempt.carrier === 'relay'
          ? { kind: 'relay' }
          : attempt.carrier === 'tunnel'
            ? { kind: 'tunnel' }
            : { kind: 'direct', rateLimitKey: attempt.peer };
      if (body.act === 'join-options') {
        const answer = await deps.join.options({ ...body, prove: attempt.prove }, carrier);
        if (!answer.ok) return 'refused';
        return answer.answer.kind === 'open'
          ? { outcome: 'join-open', fields: { why: answer.answer.why } }
          : {
              outcome: 'join-challenge',
              fields: { memberLabel: answer.answer.memberLabel, options: answer.answer.options },
            };
      }
      if (body.act !== 'join') return 'refused';
      const answer = await deps.join.join({ ...body, prove: attempt.prove }, carrier);
      return answer.ok ? { outcome: 'joined', fields: { response: answer.response } } : 'refused';
    },
  };
  return { mode, credentials, pages };
}
