import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { ReviewTooltipButton } from '../review/ReviewTooltipButton.js';
import { ReviewIcon, type ReviewIconName } from '../review/ReviewIcon.js';

const features = [
  {
    id: 'read', label: 'Read with focus', icon: 'file',
    description: 'Keep the document in view. Bring up the outline when you need to navigate, then put it away again.',
    actions: ['Open and close the workspace.', 'Jump to a section in Outline.', 'Change the zoom and lock horizontal scrolling.'],
  },
  {
    id: 'reference', label: 'Follow references', icon: 'references',
    description: 'Read straight through or follow a thread. Every link previews where it goes. Open a citation, table, or appendix beside your place: its tab is named for what it points to, and the passage it links to stays highlighted.',
    actions: ['Click Appendix A on page 15 to preview it.', 'Choose Open in References.', 'Scroll the reference, then follow another link.'],
  },
  {
    id: 'annotate', label: 'Make comments', icon: 'annotations',
    description: 'Highlight a passage, suggest an edit, or leave a note. The app saves your annotations automatically, and they’re compatible with other viewers. On the web, export a copy to take them with you.',
    actions: ['Select a passage to highlight or comment.', 'Write a comment and save it.', 'Click an annotation to revisit or edit it.'],
  },
] as const satisfies readonly { id: string; label: string; icon: ReviewIconName; description: string; actions: readonly string[] }[];

export function ProductShowcase() {
  const [index, setIndex] = useState(0);
  const [activation, setActivation] = useState(0);
  const selectFeature = (next: number) => {
    setIndex(next);
    setActivation((value) => value + 1);
  };
  const [compactControls, setCompactControls] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)');
    const update = () => setCompactControls(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const viewport = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setScale(entry.contentRect.width / 1000);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const controls = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const feature = features[index]!;
  return <section className="landing-showcase" id="features" aria-label="Feature demos">
    <div className="landing-demo-selector review-workspace__activity-strip">
      <div className="review-workspace__tabs" role="tablist" aria-label="Explore features" data-workspace-mode-count="3">
        {features.map((item, itemIndex) => <span key={item.id} className="review-workspace__mode-segment" data-workspace-mode-selected={index === itemIndex ? 'true' : 'false'} role="presentation">
          <ReviewTooltipButton label={item.label} tooltip={compactControls ? item.label : false} type="button" ref={(button) => { controls.current[itemIndex] = button; }}
            role="tab" className="review-workspace__mode-tab"
            id={`${id}-${item.id}`} aria-label={item.label} aria-selected={index === itemIndex}
            aria-controls={`${id}-panel`} tabIndex={index === itemIndex ? 0 : -1}
            onClick={() => selectFeature(itemIndex)}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? features.length - 1
                : (itemIndex + (event.key === 'ArrowRight' ? 1 : -1) + features.length) % features.length;
              selectFeature(next);
              controls.current[next]?.focus();
            }}>
            <ReviewIcon name={item.icon} />
            <span className="review-workspace__mode-label" aria-hidden="true">{item.label}</span>
          </ReviewTooltipButton>
        </span>)}
      </div>
    </div>
    <div className="landing-demo-row" id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${feature.id}`}>
      <div ref={viewport} className="landing-demo-viewport" style={{ '--demo-scale': scale } as CSSProperties}>
      <iframe className="landing-demo-frame" src="?demo=read"
        data-demo-mode={feature.id} data-demo-activation={activation} title={`${feature.label} interactive demo`} aria-hidden={false}
        sandbox="allow-scripts allow-same-origin allow-forms" />
      </div>
      <div className="landing-demo-explanation">
        {/* The selected tab already names the demo on screen. */}
        <h2 className="sr-only">{feature.label}</h2>
        <p>{feature.description}</p>
        <ul>{feature.actions.map((action) => <li key={action}>{action}</li>)}</ul>
      </div>
    </div>
  </section>;
}
