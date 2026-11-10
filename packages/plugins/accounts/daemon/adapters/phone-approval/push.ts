import { agendaNotificationPath, type AgendaId } from '@ferretry/core-asks/contract';
import type { UsesHandle } from '@ferretry/kernel/manifest';
import type { AccessApi } from '@ferretry/plugin-access/contract';
import { PHONE_APPROVAL_TITLE } from '../../../contract/routes/index.ts';
import type { PhoneApprovalPushPort } from '../../lib/phone-approval/ports.ts';

/** The tag every push of one approval shares (`pa-<id>`): a new number replaces the last on the lock screen (I208). */
export const phoneApprovalTag = (id: string): string => `pa-${id}`;

/** The push body's bound: a lock screen shows a line, not a paragraph (today's `AGENDA_PUSH_BODY_LENGTH`). */
const PUSH_BODY_LENGTH = 240;

const oneLine = (text: string): string => text.replace(/\s+/gu, ' ').trim();
const clip = (text: string, maximum: number): string =>
  text.length <= maximum ? text : `${text.slice(0, maximum - 1).trimEnd()}…`;

/**
 * AN APPROVE-ON-PHONE CARD'S PUSH, through Access (docs/input-requests.md, "Approve on your phone"): one at the raise
 * (`sequence` 0) and one for each new number the daemon read, each at HIGH priority, held by the push service no longer
 * than the card has left, and under the approval's own tag so a new number REPLACES the old one. The heading is the
 * daemon's own and the body is `phoneApprovalWords`' push line: the place, never the account. When the card settles,
 * {@link clear} takes the line down on every device, so the push lasts no longer than the card (I208).
 *
 * Access off or unreadable: nothing is pushed and nothing is said to have been. Both calls are total.
 */
export class AccessPhoneApprovalPush implements PhoneApprovalPushPort {
  constructor(private readonly access: UsesHandle<AccessApi>) {}

  async push(
    ferret: string,
    askId: string,
    approval: { readonly id: string; readonly body: string; readonly sequence: number; readonly secondsLeft: number },
  ): Promise<void> {
    if (approval.secondsLeft <= 0) return;
    await this.access
      .current()
      ?.buzz({
        tag: phoneApprovalTag(approval.id),
        title: PHONE_APPROVAL_TITLE,
        body: clip(oneLine(approval.body), PUSH_BODY_LENGTH),
        url: agendaNotificationPath(ferret, askId as AgendaId),
        urgency: 'high',
        ferret,
        ttlSeconds: approval.secondsLeft,
      })
      .catch(() => undefined);
  }

  async clear(ferret: string, approvalId: string): Promise<void> {
    await this.access
      .current()
      ?.clear?.([phoneApprovalTag(approvalId)], undefined, ferret)
      .catch(() => undefined);
  }
}
