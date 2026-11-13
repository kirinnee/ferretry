/**
 * The session-proof constants Access's `device` and `pair` modes check (today's `relay/src/lib/constants.ts`, the part they
 * read), copied verbatim. Placement gives the session layer to the kernel; until the kernel contract exports them,
 * Access keeps this copy.
 */
export const NONCE_BYTES = 32 as const;
export const ED25519_SPKI_BYTES = 44 as const;
export const ED25519_SIGNATURE_BYTES = 64 as const;
export const DEVICE_AUTH_LABEL = 'ferretry-device-auth-v2' as const;
export const DEVICE_PAIR_LABEL = 'ferretry-device-pair-v2' as const;
export const DEVICE_RENEW_LABEL = 'ferretry-device-renew-v2' as const;
/** Signed by the NEW key when a device replaces its key inside a session the old one opened. */
export const DEVICE_ROTATE_LABEL = 'ferretry-device-rotate-v2' as const;

/** Random bytes naming one running copy of the app; a step-up belongs to one of these. */
export const APP_SESSION_BYTES = 16 as const;
