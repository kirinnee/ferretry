import type { PullDetail } from '../../../contract/index.ts';

/** What changed, in numbers, and where the file-by-file diff is. Replaced by the diff viewer when it lands. */
export function FilesTab({ pull }: { readonly pull: PullDetail }) {
  return (
    <section aria-label="Files" className="kt-panel grid gap-xs p-panel" data-pull-files="">
      <p className="m-0 text-ui text-fg">
        {pull.changedFiles} {pull.changedFiles === 1 ? 'file' : 'files'} changed:{' '}
        <span className="text-ok">+{pull.additions}</span> <span className="text-err">−{pull.deletions}</span> across{' '}
        {pull.commits} {pull.commits === 1 ? 'commit' : 'commits'}.
      </p>
      <p className="m-0 text-meta text-muted">
        The file-by-file diff is on GitHub for now.{' '}
        <a href={`${pull.url}/files`} rel="noopener noreferrer" target="_blank">
          Open the files on GitHub
        </a>
      </p>
    </section>
  );
}
