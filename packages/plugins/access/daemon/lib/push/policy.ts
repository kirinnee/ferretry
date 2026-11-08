import {
  type Buzz,
  fittingPushCount,
  fittingPushTag,
  type PushDeviceView,
  PushDeviceViewSchema,
  type PushNotificationPayload,
  PushNotificationPayloadSchema,
} from '../wire.ts';
import type { PushSubscriptionRecord } from './types.ts';

/**
 * The pure decisions of the push domain: what an enrolment looks like to a caller, and what an
 * enrolment confirmation says.
 *
 * They live apart from the service because each is a total function over its inputs, and the service
 * is the part that touches a store and a network.
 *
 * THERE IS NO PREFERENCE-BASED FILTER HERE, DELIBERATELY. Every enrolled device is sent every event
 * (`PushService.notify`); which ones a reader is shown is a decision their own browser makes from its
 * own local storage, never one this daemon stores or enforces on a device's behalf. That is what lets
 * "every machine sends every event; each device decides what to show" hold even for a browser this
 * daemon has never previously described — there is no stale preference row to consult or omit.
 */

/**
 * One enrolment, as the wire describes it.
 *
 * THE ENDPOINT AND THE KEY HALVES ARE NOT IN `PushDeviceViewSchema`, and that is the point of going
 * through the schema rather than spreading the record: the triple a push service accepts is a bearer
 * capability to buzz somebody's phone, and a list route that echoed it back would hand that capability
 * to every caller who can read the list. The projection is the boundary, so a field added to the
 * record cannot leak by being forgotten about here.
 */
export function pushDeviceView(record: PushSubscriptionRecord): PushDeviceView {
  return PushDeviceViewSchema.parse({
    id: record.id,
    deviceName: record.deviceName,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expirationTime: record.subscription.expirationTime,
  });
}

/**
 * What a freshly enrolled device is told.
 *
 * IT IS SENT, NOT ASSUMED, and the reason is in `PushService.register`: storing an endpoint proves
 * nothing about whether it can be reached, and an enrolment that reports success over an endpoint the
 * push service has already discarded is exactly the "both halves agree with their own fixtures" defect
 * this surface was built to end.
 *
 * `url` is the application root rather than a deep link. A notification that opened the right screen
 * needs the client's own route table, and inventing a path here would be a second opinion about the
 * client's URLs — see the GAPs named on `PushService`.
 */
export function enrolmentConfirmation(deviceName: string): PushNotificationPayload {
  return PushNotificationPayloadSchema.parse({
    version: 1,
    eventKey: 'push-enrolled',
    title: 'Notifications are on',
    body: `${deviceName} will be told when this machine needs you.`,
    tag: 'push-enrolment',
    url: '/',
    count: fittingPushCount(1),
  });
}

/**
 * The push one buzz goes out as (another plugin's words, handed to Access's `buzz` port).
 *
 * PARSED HERE, NOT TRUSTED: an over-cap title, body or url throws at the sender instead of reaching a phone as an
 * unreadable push. A TAG IS NEVER A REASON TO REFUSE: one the worker could not read (`fittingPushTag`) is left off,
 * so the buzz is shown untagged — not replaced or cleared by tag — rather than lost. The tag still names the event.
 */
export function buzzPayload(message: Buzz): PushNotificationPayload {
  const tag = fittingPushTag(message.tag);
  return PushNotificationPayloadSchema.parse({
    version: 1,
    eventKey: message.tag,
    title: message.title,
    body: message.body,
    ...(tag === undefined ? {} : { tag }),
    url: message.url,
    count: fittingPushCount(1),
  });
}
