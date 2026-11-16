/** `@ferretry/plugin-accounts/contract` (§2.1): wire schemas, port + token, events, policy refs, words. */
export * from './policy.ts';
export * from './port.ts';
export * from './wire.ts';
export * from './words.ts';

/**
 * The shapes of the state files Accounts declares, for a reader outside the daemon that must write or check them:
 * the index (`accounts.json`) and the seals it names, the standing sign-in rules (`sign-in-rules.json`), the paste
 * rules' parts (`copy-rules.json`) and the sealed document's declaration (`login-secrets.json`). No value is in any
 * of them. Each comes from its own file, never `routes/index.ts`: two route files import this index back.
 */
export { type AccountIndexDocument, AccountIndexDocumentSchema, sealedNamesOf } from './routes/accounts.ts';
export { DEFAULT_PASTE_RULE_SETTINGS, PasteRuleSchema, PasteRuleSettingsSchema } from './routes/secure-copy.ts';
export { LOGIN_SECRETS } from './routes/sealed.ts';
export { type SignInRulesDocument, SignInRulesDocumentSchema } from './routes/sign-in-rules.ts';
