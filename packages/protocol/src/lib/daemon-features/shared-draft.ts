/** The shared composer draft (`shared-draft.*`). One fragment of `DAEMON_FEATURES`; `index.ts` spreads them all. */
export const SHARED_DRAFT_FEATURES = {
  /**
   * A shared-draft presence frame may name the files a composer is still uploading (`uploading`, &F331). A daemon
   * without this name closes the whole stream on the field, because the frame is strict: the app reports uploads
   * only where the machine reports it, and otherwise the other devices see a file once it has landed.
   */
  sharedDraftUploading: 'shared-draft.uploading.1',
  /**
   * One shared draft per Inbox item (B142): the draft routes and stream take `?item=A5`, a snapshot and a send name their
   * slot, and an item closing deletes its draft. A daemon without this name ignores `?item` and would hand back the CHAT
   * draft for the item, so the app opens no shared draft for an item there: the reply box keeps its words on this device
   * only, and never touches the chat draft.
   */
  sharedDraftSlots: 'shared-draft.slots.1',
} as const;
