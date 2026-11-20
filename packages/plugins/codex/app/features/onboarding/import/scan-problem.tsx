/**
 * What an import page says when the scan could not be shown: the machine wants the person's own press (it may raise the
 * passkey), or it failed and a retry is offered. Nothing here holds a value.
 */
import { Button } from '@ferretry/app';
import type { ScanRead } from '@ferretry/plugin-runtimes/import-kit';

export function ScanProblem({ read, look }: { readonly read: ScanRead; readonly look: () => Promise<void> }) {
  if (read.kind === 'confirm')
    return (
      <>
        <p className="m-0 text-ui text-fg">This machine asks you to confirm before it shows what your Codex holds.</p>
        <div>
          <Button
            type="button"
            variant="primary"
            className="min-h-11 py-3"
            data-import-look=""
            onClick={() => void look()}
          >
            Look at my Codex
          </Button>
        </div>
      </>
    );
  if (read.kind === 'failed')
    return (
      <>
        <p role="alert" className="m-0 text-cell text-warn" data-import-failed="">
          {read.sentence}
        </p>
        <div>
          <Button type="button" className="min-h-11 py-3" data-import-look="" onClick={() => void look()}>
            Try again
          </Button>
        </div>
      </>
    );
  return null;
}
