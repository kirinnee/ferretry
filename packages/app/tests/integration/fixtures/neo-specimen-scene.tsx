/**
 * The browser entry for the Neo-brutalism specimen (r10 T13): every component family the app draws, over fake data, in
 * ONE page, under `?style=<id>&palette=<id>&mode=light|dark` (default neo / neo / light). The pieces are the REAL ones
 * (`Button`, `Badge`, `Card`, `.kt-input`, `Segmented`, `SettingSwitch`, `ChoiceCards`, `UnderlineTabs`, `ContextMenu`,
 * `StepProgress`, `OptionBars`, a bubble, a code block, a toast-like popover), so a polish to the style shows up on what
 * the app really draws. Fake data only; no daemon.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChoiceCards } from '../../../src/compose/choice-cards.tsx';
import { OptionBars } from '../../../src/compose/option-bars.tsx';
import { SettingGroup, SettingRow, Segmented, SettingSwitch } from '../../../src/compose/setting-row.tsx';
import '../../../src/compose/step-page-frame.css';
import { StepProgress } from '../../../src/compose/step-progress.tsx';
import { ContextMenu } from '../../../src/ui/context-menu.tsx';
import { ContextFilterChips } from '../../../src/ui/filter-chips.tsx';
import { Badge, Button, Card, Label, PanelBody, PanelHeader, Textarea } from '../../../src/ui/primitives.tsx';
import { UnderlineTabs } from '../../../src/ui/underline-tabs.tsx';

const params = new URLSearchParams(window.location.search);
const root = document.documentElement;
root.dataset.style = params.get('style') ?? 'neo';
root.dataset.palette = params.get('palette') ?? 'neo';
root.dataset.mode = params.get('mode') ?? 'light';
if (params.get('motion') === 'reduced') root.dataset.motion = 'reduced';

const noop = () => undefined;

function Specimen() {
  const [mode, setMode] = useState('light');
  const [on, setOn] = useState(true);
  const [choice, setChoice] = useState<string | null>('b');
  const [tab, setTab] = useState('one');
  const [chip, setChip] = useState('all');
  return (
    <main className="bg-bg text-fg" data-specimen="" style={{ minHeight: '100vh', padding: 16 }}>
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        <Card data-part="buttons">
          <PanelHeader>
            <Label>Buttons</Label>
          </PanelHeader>
          <PanelBody>
            <div className="flex flex-wrap items-center gap-sm">
              <Button data-part="btn-outline">Outline</Button>
              <Button data-part="btn-primary" variant="primary">
                Primary
              </Button>
              <Button data-part="btn-ghost" variant="ghost">
                Ghost
              </Button>
              <Button data-part="btn-danger" variant="danger">
                Delete
              </Button>
              <Button disabled>Disabled</Button>
              <Button size="sm">Small</Button>
            </div>
            <div className="flex flex-wrap items-center gap-sm" style={{ marginTop: 20 }}>
              <Badge tone="ok">ok</Badge>
              <Badge tone="warn">warn</Badge>
              <Badge tone="err">error</Badge>
              <Badge tone="pend">pending</Badge>
              <Badge tone="accent">accent</Badge>
            </div>
            {/* A user-defined label of any length (a login label) must wrap inside its row, in every style. */}
            <div className="flex min-w-0 flex-wrap gap-1" data-part="long-label" style={{ marginTop: 12 }}>
              <Badge tone="accent">
                work-laptop-staging-environment-sign-in-for-the-platform-engineering-team-2026
              </Badge>
            </div>
            <div className="md" style={{ marginTop: 12 }}>
              <h2>Display heading</h2>
              <p>Body prose stays in a readable face.</p>
            </div>
          </PanelBody>
        </Card>

        <Card data-part="inputs">
          <PanelHeader>
            <Label>Inputs</Label>
          </PanelHeader>
          <PanelBody>
            <div className="flex flex-col gap-sm">
              <input aria-label="Name" className="kt-input" data-part="input" defaultValue="Muriel the ferret" />
              <input aria-label="Empty" className="kt-input" placeholder="Search ferrets" />
              <Textarea aria-label="Note" defaultValue={'A note\nover two lines'} rows={2} />
              <select aria-label="Machine" className="kt-input" defaultValue="a">
                <option value="a">workshop-host</option>
                <option value="b">laptop</option>
              </select>
            </div>
          </PanelBody>
        </Card>

        <Card data-part="controls" style={{ gridColumn: '1 / -1' }}>
          <PanelHeader>
            <Label>Settings controls</Label>
          </PanelHeader>
          <PanelBody>
            <SettingGroup label="Appearance">
              <SettingRow
                name="Colour mode"
                hint="Light, dark or follow the device"
                control={() => (
                  <Segmented
                    label="Mode"
                    onChange={setMode}
                    options={[
                      { id: 'light', label: 'Light' },
                      { id: 'dark', label: 'Dark' },
                      { id: 'system', label: 'System' },
                    ]}
                    value={mode}
                  />
                )}
                wide
              />
              <SettingRow
                name="Reduce motion"
                hint="Stops the animations"
                control={labelId => <SettingSwitch checked={on} labelledBy={labelId} onChange={setOn} />}
              />
            </SettingGroup>
          </PanelBody>
        </Card>

        <Card data-part="choices">
          <PanelHeader>
            <Label>Choice cards</Label>
          </PanelHeader>
          <PanelBody>
            <ChoiceCards
              label="Layout"
              onChange={setChoice}
              options={[
                { id: 'a', title: 'Ferrets on the side', line: 'The v4 layout' },
                { id: 'b', title: 'Full width', line: 'One column' },
                { id: 'c', title: 'Compact', line: 'Denser rows', disabled: true },
              ]}
              value={choice}
            />
          </PanelBody>
        </Card>

        <Card data-part="nav">
          <PanelHeader>
            <Label>Tabs, chips, progress</Label>
          </PanelHeader>
          <PanelBody>
            <div className="flex flex-col gap-md">
              <UnderlineTabs
                current={tab}
                label="Specimen tabs"
                marker="data-specimen-tab"
                onSelect={setTab}
                tabs={[
                  { id: 'one', label: 'Workshop' },
                  { id: 'two', label: 'Laptop' },
                  { id: 'three', label: 'Cloud' },
                ]}
              />
              <ContextFilterChips
                chips={[
                  { key: 'all', label: 'All', count: 12 },
                  { key: 'mine', label: 'Mine', count: 4 },
                  { key: 'agents', label: 'Agents', count: 8 },
                ]}
                label="Filter"
                onChange={setChip}
                value={chip}
              />
              <StepProgress
                current="claude"
                of={7}
                segments={[
                  { id: 'machine', label: 'Machine' },
                  { id: 'claude', label: 'Claude Code' },
                  { id: 'codex', label: 'Codex' },
                  { id: 'device', label: 'This device' },
                ]}
                step={3}
              />
              <OptionBars
                bars={[
                  { label: 'Speed', value: 0.8, text: 'Fast' },
                  { label: 'Accuracy', value: 0.5, text: 'Good' },
                  { label: 'Size', value: 0.3, text: 'Small' },
                ]}
                label="Engine"
              />
            </div>
          </PanelBody>
        </Card>

        <Card data-part="content">
          <PanelHeader>
            <Label>Chat and code</Label>
          </PanelHeader>
          <PanelBody>
            <div className="flex flex-col gap-sm">
              <div className="kt-bubble-row">
                <div className="kt-bubble px-3 py-2">
                  <p className="kt-user-copy">Please rename the folder and run the tests.</p>
                </div>
              </div>
              <pre className="kt-code-block mono">{'const ferret = await fy.new();\nferret.say("hello");'}</pre>
              <div className="kt-meter" style={{ ['--meter' as string]: '60%' }} />
              <div className="kt-popover" data-part="popover" style={{ position: 'static', padding: 12 }}>
                A popover and its hard shadow
              </div>
            </div>
          </PanelBody>
        </Card>
      </div>
      {params.get('menu') === '1' ? (
        <ContextMenu
          anchor={{ x: 24, y: 24 }}
          open
          ariaLabel="Ferret actions"
          items={[
            { key: 'resume', label: 'Resume', onSelect: noop },
            { key: 'rename', label: 'Rename…', detail: 'F2', onSelect: noop },
            { key: 'pin', label: 'Pin', disabled: true, onSelect: noop },
            { key: 'stop', label: 'Stop ferret', danger: true, separatorBefore: true, onSelect: noop },
          ]}
          onClose={noop}
        />
      ) : null}
    </main>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Specimen />);
