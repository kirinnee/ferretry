/**
 * The browser's half of copying secrets from one machine to another (docs/secrets.md).
 *
 * THIS BROWSER IS A COURIER THAT CANNOT READ WHAT IT CARRIES. It asks the TARGET for a one-time public
 * key, hands that offer to the SOURCE with the names a person picked, and hands the sealed bundle the
 * source answers back to the target. The values inside the bundle are encrypted to a private key that
 * never left the target, so nothing here can open them — there is still no route that returns a value.
 *
 * The source asks for a passkey for this act every time. That arrives as the daemon's own
 * `403 grant_step_up_required`, which the carrier turns into the passkey prompt and retries; nothing
 * here handles it.
 */

import {
  type IFyApiClient,
  type SealedSecretBundle,
  type SecretExportResponse,
  SecretExportResponseSchema,
  type SecretImportOffer,
  SecretImportOfferSchema,
  type SecretImportResult,
  SecretImportResultSchema,
} from '@ferretry/protocol';

/** The only client capability this module uses. */
export type SecretCloneClient = Pick<IFyApiClient, 'request'>;

const SECRET_IMPORTS_URL = '/v1/secrets/imports';
const SECRET_EXPORTS_URL = '/v1/secrets/exports';

/** On the TARGET: open one import and read its public offer. */
export async function openSecretImport(target: SecretCloneClient): Promise<SecretImportOffer> {
  return await target.request(SECRET_IMPORTS_URL, SecretImportOfferSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/** On the SOURCE: seal these names to that offer. Answers ciphertext only the target opens. */
export async function exportSecrets(
  source: SecretCloneClient,
  offer: SecretImportOffer,
  names: readonly string[],
): Promise<SecretExportResponse> {
  return await source.request(
    `${SECRET_EXPORTS_URL}/${encodeURIComponent(offer.importId)}`,
    SecretExportResponseSchema,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offer, names }),
    },
  );
}

/** On the TARGET: file the bundle into its store, once. */
export async function completeSecretImport(
  target: SecretCloneClient,
  bundle: SealedSecretBundle,
): Promise<SecretImportResult> {
  return await target.request(
    `${SECRET_IMPORTS_URL}/${encodeURIComponent(bundle.importId)}`,
    SecretImportResultSchema,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bundle }),
    },
  );
}

/** The whole copy, in the order it must happen. The bundle passes through here and is not kept. */
export async function copySecrets(
  source: SecretCloneClient,
  target: SecretCloneClient,
  names: readonly string[],
): Promise<SecretImportResult> {
  const offer = await openSecretImport(target);
  const { bundle } = await exportSecrets(source, offer, names);
  return await completeSecretImport(target, bundle);
}
