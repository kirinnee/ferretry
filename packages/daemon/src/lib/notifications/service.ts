import {
  type AttentionItem,
  type AttentionSnapshot,
  type DirectNotificationRequest,
  DirectNotificationResponseSchema,
} from '@ferretry/protocol';
import {
  agentConfinedTo,
  isAttentionSessionId,
  type AttentionActor,
  type AttentionRaisedObserver,
} from '../attention/index.ts';
import {
  attentionNotificationAttribution,
  attentionNotificationPayload,
  decideNotificationReplay,
  directNotificationFingerprint,
  directNotificationPayload,
  notificationKey,
} from './policy.ts';
import {
  NotificationRecordSchema,
  type NotificationClock,
  type NotificationDeliveryLedger,
  type NotificationPushDispatcher,
  type NotificationResult,
  type NotificationSerialExecutor,
  type NotificationSessionDirectory,
} from './types.ts';

export interface NotificationServiceOptions {
  readonly ledger: NotificationDeliveryLedger;
  readonly sessions: NotificationSessionDirectory;
  readonly push: NotificationPushDispatcher;
  readonly serial: NotificationSerialExecutor;
  readonly clock: NotificationClock;
}

/** Notification policy, durable duplicate suppression, and the sole call into push fan-out. */
export class NotificationService implements AttentionRaisedObserver {
  constructor(private readonly options: NotificationServiceOptions) {}

  async notifyDirect(
    sessionId: string,
    request: DirectNotificationRequest,
    actor: AttentionActor,
    attribution: string,
    requestId: string,
  ): Promise<NotificationResult> {
    if (!isAttentionSessionId(sessionId)) {
      return failure('invalid', `not a valid attention session id: ${sessionId}`);
    }
    if (!agentConfinedTo(actor, sessionId)) {
      return failure('forbidden', 'an agent may notify only its own session');
    }
    const logicalId = requestId.trim();
    if (logicalId === '') return failure('invalid', 'a notification request id must not be empty');
    const key = notificationKey({ origin: 'direct', requestId: logicalId });
    const incoming = directNotificationFingerprint(sessionId, request, attribution, logicalId);

    try {
      return await this.options.serial.run(key, async () => {
        const decision = decideNotificationReplay(await this.options.ledger.find(key), incoming);
        if (decision.decision === 'refuse') return decision.result;
        if (decision.decision === 'replay') {
          return {
            ok: true,
            value: DirectNotificationResponseSchema.parse({
              sessionId: decision.sessionId,
              delivered: decision.delivered,
            }),
          };
        }

        const session = await this.options.sessions.describe(sessionId);
        if (session === undefined) return failure('not-found', `no such session ${sessionId}`);
        const payload = directNotificationPayload(sessionId, session.name, request);
        const enrolled = (await this.options.push.list()).length;
        await this.options.ledger.append(
          NotificationRecordSchema.parse({
            v: 1,
            phase: 'requested',
            key,
            at: this.options.clock.now(),
            origin: 'direct',
            attribution,
            sessionId,
            request: incoming.request,
            sent: {
              kind: payload.kind,
              interactive: session.interactive,
              title: payload.title,
              body: payload.body,
            },
            enrolled,
          }),
        );

        let delivered: number;
        let failed: number;
        try {
          ({ delivered, failed } = await this.options.push.notify({ payload, interactive: session.interactive }));
        } catch (error) {
          const message = errorText(error);
          const at = this.options.clock.now();
          await this.options.ledger
            .append(
              NotificationRecordSchema.parse({
                v: 1,
                phase: 'outcome',
                key,
                at,
                delivered: 0,
                failed: 0,
                error: message,
              }),
            )
            .catch(() => undefined);
          return failure('corrupt', `notification delivery failed at ${at}: ${message}`);
        }

        await this.options.ledger
          .append(
            NotificationRecordSchema.parse({
              v: 1,
              phase: 'outcome',
              key,
              at: this.options.clock.now(),
              delivered,
              failed,
            }),
          )
          .catch(() => undefined);
        return {
          ok: true,
          value: DirectNotificationResponseSchema.parse({ sessionId, delivered }),
        };
      });
    } catch (error) {
      return failure('corrupt', `notification delivery state is unavailable: ${errorText(error)}`);
    }
  }

  /** Attention observer entry point; it is total even when every collaborator rejects. */
  async raised(sessionId: string, item: AttentionItem, snapshot: AttentionSnapshot): Promise<void> {
    await this.attentionRaised(sessionId, item, snapshot);
  }

  /** Announces one committed item at most once under its durable board identity. */
  async attentionRaised(sessionId: string, item: AttentionItem, snapshot: AttentionSnapshot): Promise<void> {
    const key = notificationKey({ origin: 'attention', sessionId, attentionId: item.id });
    await this.options.serial
      .run(key, async () => {
        if ((await this.options.ledger.find(key)) !== undefined) return;
        const session = await this.options.sessions.describe(sessionId);
        if (session === undefined) return;
        const payload = attentionNotificationPayload(sessionId, item, snapshot);
        const enrolled = (await this.options.push.list()).length;
        await this.options.ledger.append(
          NotificationRecordSchema.parse({
            v: 1,
            phase: 'requested',
            key,
            at: this.options.clock.now(),
            origin: 'attention',
            attribution: attentionNotificationAttribution(item),
            sessionId,
            attentionId: item.id,
            sent: {
              kind: payload.kind,
              interactive: session.interactive,
              title: payload.title,
              body: payload.body,
            },
            enrolled,
          }),
        );
        let delivered: number;
        let failed: number;
        try {
          ({ delivered, failed } = await this.options.push.notify({ payload, interactive: session.interactive }));
        } catch (error) {
          await this.options.ledger
            .append(
              NotificationRecordSchema.parse({
                v: 1,
                phase: 'outcome',
                key,
                at: this.options.clock.now(),
                delivered: 0,
                failed: 0,
                error: errorText(error),
              }),
            )
            .catch(() => undefined);
          return;
        }
        await this.options.ledger
          .append(
            NotificationRecordSchema.parse({
              v: 1,
              phase: 'outcome',
              key,
              at: this.options.clock.now(),
              delivered,
              failed,
            }),
          )
          .catch(() => undefined);
      })
      .catch(() => undefined);
  }
}

function failure(code: 'invalid' | 'forbidden' | 'not-found' | 'corrupt', message: string): NotificationResult<never> {
  return { ok: false, error: { code, message } };
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() === '' ? 'unknown notification delivery error' : message;
}
