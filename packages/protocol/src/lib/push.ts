import { z } from 'zod';
import { InstantSchema, NonNegativeFiniteSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';

export const PushNotificationKindSchema = z.enum(['attention', 'question', 'failed', 'completed']);
export type PushNotificationKind = z.infer<typeof PushNotificationKindSchema>;

export const PushPreferencesSchema = z.object({
  events: z.record(PushNotificationKindSchema, z.boolean()),
  interactiveOnly: z.boolean(),
});
export type PushPreferences = z.infer<typeof PushPreferencesSchema>;

const PushEndpointSchema = z
  .url()
  .max(4_096)
  .superRefine((value, context) => {
    if (!URL.canParse(value)) return;
    const endpoint = new URL(value);
    if (endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '') {
      context.addIssue({ code: 'custom', message: 'endpoint must be an HTTPS URL without credentials' });
    }
  });

const P256dhSchema = z.base64url().length(87);
const AuthSecretSchema = z.base64url().length(22);

const PushDeviceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\p{Cc}\p{Cf}]*$/u);

export const BrowserPushSubscriptionSchema = z.strictObject({
  endpoint: PushEndpointSchema,
  expirationTime: NonNegativeFiniteSchema.nullable(),
  keys: z.strictObject({
    p256dh: P256dhSchema,
    auth: AuthSecretSchema,
  }),
});
export type BrowserPushSubscription = z.infer<typeof BrowserPushSubscriptionSchema>;

export const RegisterPushDeviceRequestSchema = z.strictObject({
  deviceName: PushDeviceNameSchema,
  subscription: BrowserPushSubscriptionSchema,
  prefs: PushPreferencesSchema,
});
export type RegisterPushDeviceRequest = z.infer<typeof RegisterPushDeviceRequestSchema>;

export const PushDeviceViewSchema = z.object({
  id: z.string().regex(/^push-[0-9a-f-]{36}$/u),
  deviceName: PushDeviceNameSchema,
  createdAt: InstantSchema,
  updatedAt: InstantSchema,
  expirationTime: NonNegativeFiniteSchema.nullable(),
  prefs: PushPreferencesSchema,
});
export type PushDeviceView = z.infer<typeof PushDeviceViewSchema>;

export const PushDeviceListResponseSchema = z.object({
  devices: z.array(PushDeviceViewSchema),
});
export type PushDeviceListResponse = z.infer<typeof PushDeviceListResponseSchema>;

export const VapidPublicKeyResponseSchema = z.object({
  publicKey: z.string().min(1),
});
export type VapidPublicKeyResponse = z.infer<typeof VapidPublicKeyResponseSchema>;

const PushPayloadBaseShape = {
  version: z.literal(1),
  eventKey: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  tag: z.string().min(1),
  url: z.string().min(1),
  count: PositiveIntegerSchema,
};

export const PushNotificationPayloadSchema = z.union([
  z.strictObject({
    ...PushPayloadBaseShape,
    sessionId: z.string().min(1),
    kind: PushNotificationKindSchema,
  }),
  z.strictObject(PushPayloadBaseShape),
]);
export type PushNotificationPayload = z.infer<typeof PushNotificationPayloadSchema>;

export const PushDeliveryResultSchema = z.object({
  delivered: NonNegativeIntegerSchema,
  failed: NonNegativeIntegerSchema,
});
export type PushDeliveryResult = z.infer<typeof PushDeliveryResultSchema>;

export const PushErrorCodeSchema = z.enum(['invalid', 'corrupt_store', 'not_found']);
export type PushErrorCode = z.infer<typeof PushErrorCodeSchema>;
