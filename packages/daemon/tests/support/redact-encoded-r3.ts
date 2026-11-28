// Frozen encoded-value pass from 5e4f86ca09, before the path regression. Fake samples only.
const HIDDEN_TEXT = '‹hidden›';
const WORD = /[^\s"'`,;()[\]{}<>]+/gu;
const ENCODED_RUN = /[A-Za-z0-9+/_-]{32,}={0,2}/gu;

/** FileSecretKey.ensure writes 32 bytes as 44 base64 characters, including the final padding. */
const VAULT_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/u;
/** Padded base64 ciphertext (AES-GCM appends its authentication tag to the encrypted bytes). */
const PADDED_CIPHERTEXT = /^(?:[A-Za-z0-9+/]{4}){7,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/u;

function highEntropy(value: string): boolean {
  // A complete on-disk key or padded ciphertext is never a code identifier, whatever its entropy.
  if (VAULT_KEY.test(value) || PADDED_CIPHERTEXT.test(value)) return true;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  // Short hex IDs and 40-character Git SHAs are public references. Base64 needs mixed classes;
  // long wordlike camel/Pascal runs inside an identifier (even with a year) are ordinary content.
  // Every character must belong to a word segment; finding one word inside random bytes proves nothing.
  // Strip segments (including the usual Id suffix) in one pass, without nested ambiguous repetitions.
  const identifier =
    value.replace(/[A-Z][a-z]{2,}|Id|[a-z]{3,}|[0-9]{1,4}/gu, '') === '' && /[a-z]{3}[A-Z][a-z]{2}/u.test(value);
  return /^[a-fA-F0-9]+$/u.test(value)
    ? value.length >= 64 && entropy >= 3
    : entropy >= 4 && /[A-Z]/u.test(value) && /[a-z]/u.test(value) && /[0-9]/u.test(value) && !identifier;
}

export function referenceRedactEncoded(text: string, hide: () => void): string {
  return text.replace(WORD, (word, offset: number) => {
    // An embedded image is usable component content, even when the PNG bytes stand alone.
    if (
      (!VAULT_KEY.test(word) && /^(?:iVBORw0KGgo|\/9j\/|R0lGOD)/u.test(word)) ||
      /data:image\/[a-z0-9.+-]+;base64,$/iu.test(text.slice(Math.max(0, offset - 100), offset))
    )
      return word;
    // Ordinary paths and URLs are references, not unnamed encoded values.
    if (
      !/^[A-Za-z0-9+/_-]{32,}={1,2}$/u.test(word) &&
      (/^(?:[a-z][a-z0-9+.-]*:\/\/|\.?\.?\/|~\/)/iu.test(word) || /\/[\w.-]+\.[a-z]{1,8}(?:[?#].*)?$/iu.test(word))
    )
      return word;
    return word.replace(ENCODED_RUN, (value, at: number) => {
      const before = text.slice(Math.max(0, offset + at - 100), offset + at);
      if (!VAULT_KEY.test(value) && /(?:sha(?:256|512)|integrity|checksum)["']?\s*[:=-]\s*["']?$/iu.test(before))
        return value;
      if (!highEntropy(value)) return value;
      hide();
      return HIDDEN_TEXT;
    });
  });
}
