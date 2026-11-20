/**
 * The browser entry for "a sheet shows a scroll bar only when it needs one": the app's REAL `BottomSheet`, holding the
 * content shapes the shipping callers give it (an app test reaches another package only through its contract, so the
 * plugin sheets are stood in for by their exact layout classes, not their data).
 *
 *   ?theme=<family>-<mode>
 *   ?sheet=<scene id>     one of SCENES below
 *   ?size=short|long      a few lines, or enough of them to overflow the sheet's ceiling
 *   ?wide=1               one unbreakable 900px line in the content: it must be clipped, never get a sideways bar
 */
import { createRoot } from 'react-dom/client';
import { BottomSheet } from '../../../src/ui/bottom-sheet.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const sheet = params.get('sheet') ?? 'chooser';
const long = params.get('size') === 'long';
const wide = params.get('wide') === '1';
const COUNT = long ? 60 : 3;

const lines = (prefix: string) =>
  Array.from({ length: COUNT }, (_, index) => `${prefix}-${index}`).map((key, index) => (
    <p key={key} className="m-0">
      {prefix} line {index + 1}
      {wide && index === 0 ? (
        <span style={{ display: 'inline-block', width: 900, whiteSpace: 'nowrap' }}> wide </span>
      ) : null}
    </p>
  ));

const CEILING = 'min(90dvh, calc(var(--app-h, 100dvh) - var(--gap-xs)))';

/** Each scene is one caller's shape: its panel props and the exact layout classes of what it puts inside. */
const SCENES: Record<string, () => React.ReactNode> = {
  // app/shell/daemon-chooser.tsx: padding and gap on the panel, content with no scroller of its own.
  chooser: () => (
    <BottomSheet id="s" open onClose={() => {}} closeLabel="Cancel" panelClassName="gap-sm p-md">
      <div className="flex min-w-0 flex-col gap-sm">
        <h2 className="m-0 text-base">Which machine?</h2>
        {lines('Machine')}
        <button type="button">Cancel</button>
      </div>
    </BottomSheet>
  ),
  // access/device-notice: padding on the panel, plain content.
  device: () => (
    <BottomSheet id="s" open onClose={() => {}} closeLabel="Dismiss" panelClassName="px-panel pb-panel">
      <div className="flex min-w-0 flex-col gap-2 pb-md text-ui leading-base text-fg">
        <h2 className="m-0 text-title font-semibold text-warn">New device paired</h2>
        {lines('Detail')}
      </div>
    </BottomSheet>
  ),
  // ferrets/header/actions-menu, conversation/modes-menu: the body is the sheet's one scroller.
  actions: () => (
    <BottomSheet id="s" open onClose={() => {}} closeLabel="Close" panelClassName="bg-surface">
      <div className="min-h-0 flex-1 overflow-y-auto" data-ferret-action-sheet="">
        <div className="flex flex-col gap-xs p-panel">{lines('Action')}</div>
      </div>
    </BottomSheet>
  ),
  // skills / catalogs: a 720px column whose body scrolls.
  skill: () => (
    <BottomSheet
      id="s"
      open
      onClose={() => {}}
      closeLabel="Close"
      maxHeight="min(92dvh, calc(var(--app-h, 100dvh) - var(--gap-sm)))"
      panelClassName="mx-auto max-w-[720px]"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-sm overflow-y-auto p-panel">{lines('Skill')}</div>
    </BottomSheet>
  ),
  // updates/whats-new, mcp/sign-in, access/pair-phone: a fixed header over a scrolling body.
  details: () => (
    <BottomSheet
      id="s"
      open
      onClose={() => {}}
      closeLabel="Close"
      panelClassName="kt-details bg-surface"
      maxHeight={CEILING}
    >
      <header className="flex min-w-0 shrink-0 items-start gap-sm border-b border-border-soft px-panel pb-row-y">
        <h2 className="m-0 text-base">What's new</h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-panel py-md">{lines('Release')}</div>
    </BottomSheet>
  ),
  // ferrets/info: ONE fixed height (60%), the content area scrolls.
  info: () => (
    <BottomSheet id="s" open onClose={() => {}} closeLabel="Close Info" height="60%">
      <div className="flex min-h-0 flex-1 flex-col gap-sm overflow-y-auto p-panel">{lines('Info')}</div>
    </BottomSheet>
  ),
  // runtimes/profile-library, voice debug, config-file editors: a header, a body and a footer.
  editor: () => (
    <BottomSheet
      id="s"
      open
      onClose={() => {}}
      closeLabel="Close"
      panelClassName="kt-details bg-surface"
      maxHeight={CEILING}
    >
      <header className="shrink-0 border-b border-border-soft px-panel pb-row-y">
        <h2 className="m-0 text-base">Edit</h2>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-sm overflow-y-auto p-panel">{lines('Field')}</div>
      <footer className="flex shrink-0 justify-end gap-sm border-t border-border-soft px-panel py-row-y">
        <button type="button">Save</button>
      </footer>
    </BottomSheet>
  ),
};

createRoot(document.getElementById('root') as HTMLElement).render(
  <div data-scene={sheet}>{(SCENES[sheet] ?? (SCENES.chooser as () => React.ReactNode))()}</div>,
);
