/**
 * The few schemas Accounts' wire needs that today live in another subsystem's wire and that no contract Accounts may
 * import exports as they are today. Each is copied field for field from `packages/protocol/src/lib/*` at
 * `bb89d054d`; each is a contract gap for the lead (TODO(contract)). Nothing here is Accounts' own fact.
 */
import { z } from 'zod';

// TODO(contract): `@ferretry/std` brands and normalises an instant (`InstantSchema` transforms to `toISOString()`).
// A rule's signed body is hashed as RFC 8785 bytes, so a stored instant must round-trip unchanged: keep today's plain
// one (`protocol/src/lib/common.ts`).
export const InstantSchema = z.iso.datetime({ offset: true });

// TODO(contract): Asks' `AskIdSchema` brands the id (`AskId`); today's agenda id is a plain string. Same pattern.
export const AgendaIdSchema = z.string().regex(/^A[1-9][0-9]*$/u);

// TODO(contract): today's `protocol/src/lib/session.ts` `AgentNameSchema`; Ferrets' `FerretNameSchema` is wider.
const AGENT_NAME_MAX_LENGTH = 32;
export const AgentNameSchema = z
  .string()
  .trim()
  .min(1, 'a name must not be empty')
  .max(AGENT_NAME_MAX_LENGTH, `a name must be at most ${AGENT_NAME_MAX_LENGTH} characters`)
  .regex(/^[A-Za-z][A-Za-z0-9-]*$/, 'a name must start with a letter and contain only letters, digits or hyphens');

// TODO(contract): Gate's contract has the `StoredStepUpProof` interface but not its schema or the challenge life.
/** How long one passkey challenge lives (`protocol/src/lib/step-up.ts`). */
export const PASSKEY_CHALLENGE_TTL_SECONDS = 120 as const;

const Base64UrlSchema = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/u, 'not unpadded base64url');

// TODO(contract): Access's ids (`protocol/src/lib/pairing.ts`); a plugin contract may not import Access's contract.
export const PairedDeviceIdSchema = z.string().regex(/^fy_device_id_[A-Za-z0-9_-]{22}$/u, 'invalid device id');

/** A daemon id is the SHA-256 fingerprint of its persisted Ed25519 public key. */
export const DaemonIdSchema = z.string().regex(/^fy_daemon_[A-Za-z0-9_-]{43}$/u, 'invalid daemon id');
export type DaemonId = z.infer<typeof DaemonIdSchema>;

/**
 * A STORED PROOF: what the daemon keeps of a verified ceremony for a stored-proof act, so the assertion can be checked
 * again offline — the device that proved it and the assertion's bytes exactly as the authenticator signed them.
 */
export const StoredStepUpProofSchema = z.strictObject({
  deviceId: PairedDeviceIdSchema,
  credentialId: Base64UrlSchema(1_366),
  clientDataJSON: Base64UrlSchema(5_462),
  authenticatorData: Base64UrlSchema(5_462),
  signature: Base64UrlSchema(1_366),
});
export type StoredStepUpProof = z.infer<typeof StoredStepUpProofSchema>;

// TODO(contract): Browsers' contract has no element ref schema (`protocol/src/lib/browser-target.ts`).
/** A ref as a snapshot writes it: `e12`, or `f1e3` inside a frame. */
const BROWSER_REF_PATTERN = /^(?:f\d{1,6})?e\d{1,7}$/u;
export const BrowserRefSchema = z
  .string()
  .trim()
  .regex(BROWSER_REF_PATTERN, 'a ref is what a page snapshot names an element: e12, or f1e3 inside a frame');

// TODO(contract): Vault's contract has no field element schema (`protocol/src/lib/input-request.ts`).
const boundedLine = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'must be one line with no control characters');

/**
 * The element a browser field names, the way every browser act names one: a snapshot's `ref` or a selector.
 * It is the agent's POINTER, never a fact: the daemon resolves it and observes what is actually there.
 */
export const InputFieldElementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('selector'), selector: boundedLine(512) }),
  z.strictObject({ kind: z.literal('ref'), ref: BrowserRefSchema }),
]);
export type InputFieldElement = z.infer<typeof InputFieldElementSchema>;

// TODO(contract): Vault's contract has no store health (`protocol/src/lib/secrets.ts`).
export const SecretStoreHealthSchema = z.enum(['ready', 'damaged']);
