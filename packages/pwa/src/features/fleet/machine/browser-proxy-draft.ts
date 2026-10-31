import { BrowserProxySettingSchema, type BrowserProxySetting, SECRET_REFERENCE_SOURCE } from '@ferretry/protocol';

/** What the Browser proxy form holds while it is being edited: text, and the NAMES of secrets, never their values. */
export interface BrowserProxyDraft {
  readonly url: string;
  /** Bypass entries, one per line or comma-separated. */
  readonly bypass: string;
  readonly usernameSecret: string;
  readonly passwordSecret: string;
}

export const EMPTY_PROXY_DRAFT: BrowserProxyDraft = { url: '', bypass: '', usernameSecret: '', passwordSecret: '' };

const WHOLE_REFERENCE = new RegExp(`^${SECRET_REFERENCE_SOURCE}$`, 'u');

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;

export const isSecretName = (text: string): boolean => SECRET_NAME.test(text);

/** What was typed as a secret name; a pasted `${secret:NAME}` reference counts as its name. */
export const nameTyped = (text: string): string => secretName(text.trim()) || text.trim();

const secretName = (reference: string | undefined): string => WHOLE_REFERENCE.exec(reference ?? '')?.[1] ?? '';

export const draftOf = (setting: BrowserProxySetting | null | undefined): BrowserProxyDraft =>
  setting === null || setting === undefined
    ? EMPTY_PROXY_DRAFT
    : {
        url: setting.url,
        bypass: setting.bypass.join('\n'),
        usernameSecret: secretName(setting.username),
        passwordSecret: secretName(setting.password),
      };

export const bypassEntries = (text: string): string[] =>
  text
    .split(/[\n,]/u)
    .map(entry => entry.trim())
    .filter(entry => entry !== '');

/** The setting the draft describes, or the one sentence that says what to fix. */
export function settingOf(
  draft: BrowserProxyDraft,
): { readonly ok: true; readonly setting: BrowserProxySetting } | { readonly ok: false; readonly problem: string } {
  const username = nameTyped(draft.usernameSecret);
  const password = nameTyped(draft.passwordSecret);
  for (const [field, name] of [
    ['username', username],
    ['password', password],
  ] as const) {
    if (name !== '' && !isSecretName(name)) {
      return {
        ok: false,
        problem: `The ${field} secret name takes capital letters, digits and _, like PROXY_${field === 'username' ? 'USER' : 'PASSWORD'}.`,
      };
    }
  }
  const parsed = BrowserProxySettingSchema.safeParse({
    url: draft.url,
    bypass: bypassEntries(draft.bypass),
    ...(username === '' ? {} : { username: `\${secret:${username}}` }),
    ...(password === '' ? {} : { password: `\${secret:${password}}` }),
  });
  if (parsed.success) return { ok: true, setting: parsed.data };
  const issue = parsed.error.issues[0];
  const field = issue?.path[0];
  const prefix = field === 'username' || field === 'password' ? `The ${field} secret: ` : '';
  return { ok: false, problem: `${prefix}${issue?.message ?? 'this proxy setting is not valid'}` };
}
