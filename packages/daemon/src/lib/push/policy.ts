import {
  type PushDeviceView,
  PushDeviceViewSchema,
  type PushNotificationPayload,
  PushNotificationPayloadSchema,
  type PushPreferences,
} from '@ferretry/protocol';
import type { PushDispatch, PushSubscriptionRecord } from './types.ts';

/**
 * The pure decisions of the push domain: what an enrolment looks like to a caller, whether a device
 * agreed to hear about something, and what an enrolment confirmation says.
 *
 * They live apart from the service because each is a total function over its inputs, and the service
 * is the part that touches a store and a network.
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
    prefs: record.prefs,
  });
}

/**
 * Whether one device agreed to be told about this.
 *
 * THERE IS NO SILENCE TO INTERPRET. `PushPreferencesSchema` demands an answer for every notification
 * kind, so an enrolment either says yes or says no and this function never has to guess what an absent
 * opinion meant — which is the whole reason the wire shape is a complete record rather than a partial
 * one. A reader who has said nothing cannot be enrolled at all.
 *
 * A payload about NO session bypasses both rules. `interactiveOnly` is a reader declining unattended
 * session noise, and an enrolment confirmation is neither about a session nor noise they can predict;
 * silencing it with a session preference would leave somebody who just turned notifications on with no
 * evidence that anything worked.
 */
export function acceptsDispatch(prefs: PushPreferences, dispatch: PushDispatch): boolean {
  if (!('kind' in dispatch.payload)) return true;
  if (!prefs.events[dispatch.payload.kind]) return false;
  return !(prefs.interactiveOnly && dispatch.interactive === false);
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
    count: 1,
  });
}
