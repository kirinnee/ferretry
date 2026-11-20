/**
 * THE FIXED SPECIMEN PAGE the theme matrix measures (`theme-matrix.visual.test.ts`): the real shared primitives over fake
 * data, one of each thing a style has to draw: body and muted text, headings, a link, buttons in every variant, an input,
 * a card, status badges, a row of choice cards and an open menu. It owns NO style or palette: the test sets the three root
 * attributes (`data-style`, `data-palette`, `data-mode`) and reads what the page then draws, so a style or palette added
 * to the catalogue is measured without touching this file.
 *
 * Every element the test measures says so: `data-spec="text|edge|focus"`. A `text` element is read against the colour it
 * sits on, an `edge` is a control's own border against what is behind it, a `focus` element is reached by the real keyboard (Tab, then the arrow keys in the choice row and the menu) and its ring read; the choice cards and the menu rows are measured too, by their own classes.
 *
 *   ?style=<id>&palette=<id>&mode=<light|dark>      (the test re-sets these in place for every combination)
 */
import { Check } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import { ChoiceCards } from '../../../src/compose/choice-cards.tsx';
import { Badge, Button, Card, PanelBody, PanelHeader } from '../../../src/ui/primitives.tsx';
import { ContextMenu } from '../../../src/ui/context-menu.tsx';

const params = new URLSearchParams(window.location.search);
const root = document.documentElement;
root.setAttribute('data-style', params.get('style') ?? 'studio');
root.setAttribute('data-palette', params.get('palette') ?? 'studio');
root.setAttribute('data-mode', params.get('mode') === 'dark' ? 'dark' : 'light');

const noop = () => undefined;

const OPTIONS = [
  { id: 'left', title: 'Left', line: 'The menu beside your work' },
  { id: 'right', title: 'Right', line: 'The menu on the other edge' },
] as const;

createRoot(document.getElementById('root') as HTMLElement).render(
  <main className="bg-bg text-fg" data-specimen="" style={{ minHeight: '100vh', padding: 16 }}>
    <h1 data-spec="text" style={{ fontFamily: 'var(--font-display)' }}>
      Specimen heading
    </h1>
    <p data-spec="text">
      Body text sits on the page: a sentence long enough to wrap on a phone, so the measure is real.
    </p>
    <p className="text-muted" data-spec="text">
      Muted text is the quiet line under a title.
    </p>
    <p>
      <code className="mono" data-spec="text">
        mono sample 0123
      </code>
    </p>
    <p>
      <a href="#specimen" data-spec="text focus">
        A link in the running text
      </a>
    </p>
    <div className="flex flex-wrap items-center gap-sm" style={{ margin: '12px 0' }}>
      <Button variant="primary" data-spec="text focus">
        Primary
      </Button>
      <Button data-spec="text edge focus">Outline</Button>
      <Button variant="ghost" data-spec="text focus">
        Ghost
      </Button>
      <Button variant="danger" data-spec="text focus">
        Danger
      </Button>
    </div>
    <input
      aria-label="Name"
      className="kt-input"
      data-spec="text edge focus"
      defaultValue="Ferret name"
      style={{ maxWidth: '100%' }}
    />
    <Card data-spec="panel-edge" style={{ margin: '12px 0' }}>
      <PanelHeader>
        <span data-spec="text">Card header</span>
      </PanelHeader>
      <PanelBody>
        <p data-spec="text">Card body on the raised surface.</p>
        <p className="text-muted" data-spec="text">
          Muted text on the raised surface.
        </p>
        <div className="flex flex-wrap items-center gap-sm">
          <Badge tone="ok" data-spec="text">
            ok
          </Badge>
          <Badge tone="warn" data-spec="text">
            warn
          </Badge>
          <Badge tone="err" data-spec="text">
            err
          </Badge>
          <Badge tone="accent" data-spec="text">
            accent
          </Badge>
        </div>
      </PanelBody>
    </Card>
    <ChoiceCards label="Menu side" onChange={noop} options={OPTIONS} value="left" />
    <p style={{ marginTop: 12 }}>
      <Check aria-hidden size={16} /> <span data-spec="text">Done</span>
    </p>
    <section className="fy-page" style={{ padding: 0 }}>
      <h1 data-spec="text">Shell page heading</h1>
    </section>
    {/* Fixed below the content (the matrix opens the page 1200px tall), so on a phone the menu never covers the text. */}
    <ContextMenu
      anchor={{ x: 16, y: 840 }}
      ariaLabel="Ferret actions"
      items={[
        { key: 'resume', label: 'Resume', onSelect: noop },
        { key: 'rename', label: 'Rename…', detail: 'F2', onSelect: noop },
        { key: 'stop', label: 'Stop ferret', danger: true, separatorBefore: true, onSelect: noop },
      ]}
      onClose={noop}
      open
    />
  </main>,
);
