/**
 * The organisation type a Claude account file records (`oauthAccount.organizationType`), from the file's text. The ONE
 * non-secret field: the document is parsed only to find it and dropped, no token is looked at and nothing is kept. Text that
 * is not a JSON object, an account that is absent and a field that is not a non-empty string are `undefined`.
 */
export function organizationTypeOfAccountDocument(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  try {
    const document: unknown = JSON.parse(text);
    const account = (document as { oauthAccount?: unknown } | null)?.oauthAccount;
    const type = (account as { organizationType?: unknown } | null | undefined)?.organizationType;
    return typeof type === 'string' && type !== '' ? type : undefined;
  } catch {
    return undefined;
  }
}
