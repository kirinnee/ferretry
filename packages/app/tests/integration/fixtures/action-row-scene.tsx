/**
 * The browser entry for the C59 shared answer-row rules over fake data: the `ActionRow` (two answers, a lone primary, a lone
 * secondary), the recovery `fy-action-stack`, an inline action inside a sentence, and the step frame's footer with one, two and
 * three buttons.
 *
 *   ?theme=<family>-<mode>
 *   ?scene=row|narrow|stack|inline|footer1|footer2|footer3
 */
import { createRoot } from 'react-dom/client';
import { StepPageFrame } from '../../../src/compose/step-page-frame.tsx';
import { ActionRow } from '../../../src/ui/action-row.tsx';
import { Button } from '../../../src/ui/primitives.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const scene = params.get('scene') ?? 'row';
const noop = (): void => {};

const Row = () => (
  <div className="mx-auto flex max-w-[600px] flex-col gap-6 p-3" data-case="row">
    <div data-sample="two">
      <ActionRow
        secondary={<Button data-b="secondary">Not now</Button>}
        primary={
          <Button variant="primary" data-b="primary">
            Pair this device
          </Button>
        }
      />
    </div>
    <div data-sample="lone-primary">
      <ActionRow
        primary={
          <Button variant="primary" data-b="primary">
            Continue
          </Button>
        }
      />
    </div>
    <div data-sample="lone-secondary">
      <ActionRow secondary={<Button data-b="secondary">Check again</Button>} />
    </div>
    <div data-sample="long" className="flex flex-col gap-3">
      <ActionRow
        primary={
          <Button variant="primary" data-b="primary">
            <span aria-hidden="true">↓</span>
            Sign in to Codex
          </Button>
        }
      />
      <ActionRow primary={<Button variant="primary">Import</Button>} />
      <ActionRow primary={<Button variant="primary">Connect another GitHub account</Button>} />
    </div>
  </div>
);

/** The row in containers of several widths inside one wide window: it must fit the CONTAINER, whatever the window (O8-1 review). */
const NARROW_WIDTHS = [160, 309, 399, 400, 604] as const;
const Narrow = () => (
  <div className="flex flex-col gap-6 p-3" data-case="narrow">
    {NARROW_WIDTHS.map(width => (
      <div key={width} data-sample={`w-${width}`} style={{ width, maxWidth: '100%' }}>
        <ActionRow
          secondary={<Button data-b="secondary">Start over</Button>}
          primary={
            <Button variant="primary" data-b="primary">
              Cancel sign-in
            </Button>
          }
        />
      </div>
    ))}
  </div>
);

const Stack = () => (
  <div className="mx-auto max-w-[600px] p-3" data-case="stack">
    <div className="fy-action-stack" data-sample="stack">
      <Button variant="primary">Look for the login again</Button>
      <Button>Start a new sign-in</Button>
      <Button>Use a device code instead</Button>
    </div>
  </div>
);

const Inline = () => (
  <div className="mx-auto max-w-[360px] p-3" data-case="inline">
    <p data-sample="inline" className="m-0 text-ui leading-base text-muted">
      Have Claude or Codex open?{' '}
      <button type="button" className="fy-inline-action" onClick={noop}>
        Let an agent do it
      </button>
    </p>
  </div>
);

const Footer = ({ back, later }: { readonly back: boolean; readonly later: boolean }) => (
  <div style={{ height: '100vh', overflow: 'auto' }} data-case="footer">
    <StepPageFrame
      title="A page"
      {...(back ? { back: { onClick: noop } } : {})}
      {...(later ? { later: { onClick: noop } } : {})}
      next={{ label: 'Create project', onClick: noop }}
    >
      <p>Body</p>
    </StepPageFrame>
  </div>
);

const root = document.getElementById('root');
if (root === null) throw new Error('the scene page has no #root');
createRoot(root).render(
  scene === 'stack' ? (
    <Stack />
  ) : scene === 'narrow' ? (
    <Narrow />
  ) : scene === 'inline' ? (
    <Inline />
  ) : scene === 'footer1' ? (
    <Footer back={false} later={false} />
  ) : scene === 'footer2' ? (
    <Footer back later={false} />
  ) : scene === 'footer3' ? (
    <Footer back later />
  ) : (
    <Row />
  ),
);
