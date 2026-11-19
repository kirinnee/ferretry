/**
 * Point the preview ref at a commit, then wait for its deploy (slot.ts `upgrade-v5`, and `reset-v5`). The 5.0 preview app is
 * deployed by `pwa-pages-v5.yaml` ONLY on a push to `refs/heads/rebuild/preview`, so the owner's slot decides when it moves:
 *
 *   1. read the ref on origin (read-only `git ls-remote`);
 *   2. decide (deploy-gate.ts `decidePush`): create it, fast-forward it, or leave it when it already is the commit. A commit that
 *      is not a descendant of what the ref holds is REFUSED, so the preview never goes backwards;
 *   3. push `<commit>:refs/heads/rebuild/preview`, never forced, never any other ref;
 *   4. wait until the run for that exact commit has a green `Deploy PWA` job (deploy-gate.ts `waitVerdict`); a run that ended any
 *      other way, or never appeared, refuses.
 * Every refusal happens BEFORE the daemon is stopped. `git` and `gh` come in as ports, so tests run with fakes and never push.
 */
import {
  decidePush,
  deployJobSucceeded,
  PREVIEW_DEPLOY_WORKFLOW,
  PREVIEW_POLL_MS,
  PREVIEW_REF,
  PREVIEW_REMOTE,
  previewRunsFor,
  waitVerdict,
  type Observed,
} from './deploy-gate.ts';

export interface Ran {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

export interface PreviewPorts {
  readonly git: (args: readonly string[]) => Promise<Ran>;
  readonly gh: (args: readonly string[]) => Promise<Ran>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly say: (line: string) => void;
}

/** A refusal with its reason. slot.ts turns it into the one-line `refusing: …` the kit prints. */
export class PreviewRefusal extends Error {}

const refuse = (why: string): never => {
  throw new PreviewRefusal(why);
};
const short = (sha: string): string => sha.slice(0, 10);
const detail = (ran: Ran): string => `exit ${String(ran.code)}: ${ran.err.trim().slice(0, 200)}`;
const refName = `refs/heads/${PREVIEW_REF}`;

/** The commit the preview ref holds on origin, or undefined when it does not exist yet. */
async function readPreviewHead(ports: PreviewPorts): Promise<string | undefined> {
  const ran = await ports.git(['ls-remote', '--heads', PREVIEW_REMOTE, refName]);
  if (ran.code !== 0)
    return refuse(
      `could not read ${refName} on ${PREVIEW_REMOTE} (git ${detail(ran)}), so I cannot tell where the preview is`,
    );
  const lines = ran.out.split('\n').filter(line => line.trim() !== '');
  if (lines.length === 0) return undefined;
  const match = lines.length === 1 ? /^([0-9a-f]{40})\s+(\S+)$/u.exec(lines[0] ?? '') : null;
  if (match === null || match[2] !== refName)
    return refuse(`unexpected answer to the read of ${refName}: ${ran.out.trim().slice(0, 200)}`);
  return match[1];
}

/** Whether `ancestor` is an ancestor of `commit` (merge-base: 0 yes, 1 no); undefined when git could not say. */
async function isAncestor(ports: PreviewPorts, ancestor: string, commit: string): Promise<boolean | undefined> {
  const fetched = await ports.git(['fetch', '--quiet', PREVIEW_REMOTE, refName]);
  if (fetched.code !== 0) return undefined;
  const ran = await ports.git(['merge-base', '--is-ancestor', ancestor, commit]);
  return ran.code === 0 ? true : ran.code === 1 ? false : undefined;
}

async function pushPreviewRef(ports: PreviewPorts, commit: string): Promise<void> {
  const current = await readPreviewHead(ports);
  const ancestor = current === undefined || current === commit ? undefined : await isAncestor(ports, current, commit);
  const decision = decidePush(current, commit, ancestor);
  if (decision === 'refuse')
    return refuse(
      `commit ${short(commit)} is not a descendant of ${short(current ?? '')}, which ${refName} holds on ${PREVIEW_REMOTE}${ancestor === undefined ? ' (git could not say how they relate)' : ''}; the preview never goes backwards, so build a newer commit. Nothing was pushed or stopped`,
    );
  if (decision === 'already') {
    ports.say(`${refName} already points at ${short(commit)}; waiting for its deploy`);
    return;
  }
  // Never --force: git itself also refuses anything that is not a fast-forward. Only this ref, only this commit.
  const pushed = await ports.git(['push', PREVIEW_REMOTE, `${commit}:${refName}`]);
  if (pushed.code !== 0)
    return refuse(`could not push ${short(commit)} to ${refName} (git ${detail(pushed)}); nothing was stopped`);
  ports.say(
    `${refName}: ${decision === 'create' ? 'created at' : 'fast-forwarded to'} ${short(commit)}; waiting for its deploy`,
  );
}

async function observe(ports: PreviewPorts, commit: string, viewed: Map<number, boolean>): Promise<Observed[]> {
  const listed = await ports.gh([
    'run',
    'list',
    '--workflow',
    PREVIEW_DEPLOY_WORKFLOW,
    '--branch',
    PREVIEW_REF,
    '--limit',
    '100',
    '--json',
    'databaseId,headSha,conclusion,headBranch,status',
  ]);
  if (listed.code !== 0)
    return refuse(
      `could not read the Pages deploy runs with gh (${detail(listed)}), so I cannot say ${short(commit)} is live`,
    );
  let runs: unknown;
  try {
    runs = JSON.parse(listed.out);
  } catch {
    return refuse('gh did not return the deploy runs as JSON');
  }
  const observed: Observed[] = [];
  for (const run of previewRunsFor(runs, commit)) {
    if (run.state === 'pending') observed.push({ id: run.id, state: 'pending' });
    else if (run.state === 'success') {
      let deployed = viewed.get(run.id);
      if (deployed === undefined) {
        const view = await ports.gh(['run', 'view', String(run.id), '--json', 'jobs']);
        if (view.code !== 0)
          return refuse(`could not read the jobs of Pages deploy run ${String(run.id)} with gh (${detail(view)})`);
        try {
          deployed = deployJobSucceeded(JSON.parse(view.out));
        } catch {
          return refuse(`gh did not return the jobs of run ${String(run.id)} as JSON`);
        }
        viewed.set(run.id, deployed);
      }
      observed.push({ id: run.id, state: deployed ? 'deployed' : 'skipped' });
    } else observed.push({ id: run.id, state: run.state });
  }
  return observed;
}

/**
 * Make the preview app live for `commit`: move the ref to it (fast-forward only), then wait for the deploy. Resolves only when a run
 * of exactly this commit has a successful `Deploy PWA` job; throws PreviewRefusal otherwise.
 */
export async function ensurePreviewDeployed(ports: PreviewPorts, commit: string): Promise<void> {
  await pushPreviewRef(ports, commit);
  const started = ports.now();
  const viewed = new Map<number, boolean>();
  let readFailures = 0;
  for (;;) {
    let observed: Observed[];
    try {
      observed = await observe(ports, commit, viewed);
      readFailures = 0;
    } catch (error) {
      // A run list that fails once is a blip; three in a row is not something to wait out.
      if (!(error instanceof PreviewRefusal) || ++readFailures >= 3) throw error;
      await ports.sleep(PREVIEW_POLL_MS);
      continue;
    }
    const verdict = waitVerdict(observed, ports.now() - started);
    if (verdict.kind === 'live') {
      ports.say(`the hosted 5.0 app is live for ${short(commit)}`);
      return;
    }
    if (verdict.kind === 'refuse')
      return refuse(`commit ${short(commit)} is not live on the hosted app: ${verdict.why}; nothing was stopped`);
    await ports.sleep(PREVIEW_POLL_MS);
  }
}
