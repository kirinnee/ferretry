/** Only the member-key event Catalogs emits; Access owns the signal's listeners. */
export interface PasskeysChangedSignal {
  emit(change: { readonly cause: 'member-key-forgotten'; readonly keyId: string }): Promise<void>;
}
