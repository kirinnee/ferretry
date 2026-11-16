import { OwnFolder } from '../adapters/session/sessions-root.ts';
import { paneFileStores } from '../lib/ferrets/session-stores/pane-files.ts';
import { parseSessionId } from '../lib/session-id.ts';
import type { FerretsContext, FerretsFeature } from './types.ts';

/**
 * The ferret's question file (`FY_QUESTION_FILE`) and media folder (`FY_MEDIA_DIR`): two files of its own session folder
 * the pane is handed by name. They were two members of the session port the service reached for while it built the
 * environment; they are launch stores now, so the next per-ferret file is one more file like this one and no port member.
 */
function register(f: FerretsContext) {
  const { sessionFiles, launch } = f;
  const stores = paneFileStores({
    root: ferret => sessionFiles.root(parseSessionId(ferret)),
    ensureMediaFolder: async ferret => {
      const id = parseSessionId(ferret);
      await new OwnFolder(sessionFiles.root(id)).ensure();
      await new OwnFolder(sessionFiles.mediaRoot(id)).ensure();
    },
  });
  for (const store of stores) launch.paneVariable(store);
  return undefined;
}

export default { id: 'session-pane-files', register } satisfies FerretsFeature;
