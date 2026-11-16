import { ApiError } from '@ferretry/kernel/contract';
import { sessionFilesystemRoutes } from '../lib/runtime/mounts/session-filesystem.ts';
import { AGENT_READ_FENCE, SessionFilesystem } from '../lib/session/filesystem/index.ts';
import { KernelSessionRootPinner } from '../adapters/session/filesystem/index.ts';
import { callerIsAgent } from '../lib/ferrets/launch-origin.ts';
import type { FeatureContribution, FerretsContext, FerretsFeature } from './types.ts';

function register(f: FerretsContext): FeatureContribution | undefined {
  const { kernel, registry, sessionFiles, sessionFilesystemOf, sessionGit, pathFerret, agentMayReach } = f;
  // The file browser (today's session-filesystem mount) over the kernel: each ferret's `work` root pins its folder and
  // walks beneath it by descriptor and Git runs in the held object. For an AGENT the pin refuses (`denied`, 403) every
  // path inside the state home and every hard link, and the service asks the pin's name verdict wherever a name never
  // passes through the walk (Git's change list, a HEAD read, a badge); a PERSON is unfenced, as today (S47). The
  // service is stateless, so one is made for the ferret a request names.
  const fileBrowser = sessionFilesystemRoutes({
    filesystem: sessionFilesystemOf,
    // `scope=media` (F-0327): the ferret's `media/` folder on the sessions root, held open the same way and no wider.
    media: ferret =>
      new SessionFilesystem(new KernelSessionRootPinner(sessionFiles.mediaRoot(ferret)), sessionGit, () =>
        kernel.clock.nowMs(),
      ),
    redaction: kernel.redaction,
    reach: async call => {
      const id = await pathFerret(call);
      agentMayReach(call, id);
      const folder = registry.get(id)?.folder;
      if (folder === undefined) throw new ApiError(404, `no ferret ${id}`, 'not-found');
      // S47, today's `agentFence`: an agent reads only its own ferret's and its helpers' files (above), behind the
      // state-home fence; a person reads unfenced.
      return { id, cwd: folder, ...(callerIsAgent(call) ? { fence: AGENT_READ_FENCE } : {}) };
    },
  });

  return { routes: fileBrowser };
}

export default { id: 'file-browser', register } satisfies FerretsFeature;
