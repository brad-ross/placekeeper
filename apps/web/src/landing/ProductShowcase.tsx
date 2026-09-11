import { useId, useState } from "react";
import { ReviewIcon, type ReviewIconName } from "../review/ReviewIcon.js";

const surfaces = [
  { id: "read", label: "Read with focus", icon: "outline", caption: "A quiet reading space. An outline that keeps the whole document within reach." },
  { id: "annotate", label: "Keep your thoughts", icon: "annotations", caption: "Highlights, comments, and edits, collected beside the passages that prompted them." },
  { id: "reference", label: "Follow a reference", icon: "references", caption: "Look up a linked passage alongside your reading. Your original place stays put." },
] as const satisfies readonly { id: string; label: string; icon: ReviewIconName; caption: string }[];

/** An illustrative document, not a second live PDF runtime on the landing page. */
export function ProductShowcase() {
  const [active, setActive] = useState<(typeof surfaces)[number]>(surfaces[2]);
  const id = useId();
  return <section className="landing-showcase" id="features" aria-labelledby={`${id}-title`}>
    <div className="landing-showcase__intro">
      <span className="landing-eyebrow" id={`${id}-title`}>A closer look</span>
      <span className="landing-showcase__hint">One document. Room to think.</span>
    </div>
    <div className="landing-showcase__switcher" role="group" aria-label="Explore app surfaces">
      {surfaces.map((surface) => <button key={surface.id} type="button" aria-pressed={active.id === surface.id}
        aria-controls={`${id}-preview`} onClick={() => setActive(surface)}>
        <ReviewIcon name={surface.icon} size={16} />{surface.label}
      </button>)}
    </div>
    <div className="landing-preview" id={`${id}-preview`} role="img" aria-label={`Illustrative Placekeeper preview: ${active.caption}`}>
      <div className="landing-preview__chrome" aria-hidden="true">
        <span className="landing-preview__filename"><ReviewIcon name="file" size={15} /> The art of close reading.pdf <ReviewIcon name="chevron-down" size={12} /></span>
        <span className="landing-preview__pagination"><ReviewIcon name="chevron-left" size={14} /> 4 <span>/ 18</span><ReviewIcon name="chevron-right" size={14} /></span>
        <span className="landing-preview__tools"><ReviewIcon name="minus" size={14} /> 100% <ReviewIcon name="plus" size={14} /><i /><ReviewIcon name="search" size={16} /><ReviewIcon name="panel-right" size={16} /></span>
      </div>
      <div className={`landing-preview__body landing-preview__body--${active.id}`} aria-hidden="true">
        {active.id === "read" && <aside className="landing-preview__outline">
          <span className="landing-preview__panel-title"><ReviewIcon name="outline" size={14} /> Outline</span>
          {["Abstract", "1  Introduction", "2  Reading with attention", "3  Following the thread", "4  Discussion", "References"].map((label, index) => <div className={index === 2 ? "is-current" : ""} key={label}>{label}<span>{[1, 2, 4, 8, 12, 16][index]}</span></div>)}
        </aside>}
        <div className="landing-preview__paper-wrap"><article className="landing-preview__paper">
          <div className="landing-preview__running">THE ART OF CLOSE READING <span>4</span></div>
          <h3>2 &nbsp; Reading with attention</h3>
          <p>Reading is more than moving from one page to the next. It is a conversation between what is on the page and what we bring to it: a question, a memory, an idea taking shape.</p>
          <p>The most useful tools make room for that conversation. <mark>They hold the detail in view without letting the larger argument slip away.</mark> A note in the margin becomes a way back into a thought.</p>
          <p>But a document rarely unfolds in a straight line. An unfamiliar term invites a search. A footnote leads to an earlier passage. A claim sends us to the evidence in <span className="landing-preview__citation">Table 1</span>.</p>
          <h4>2.1 &nbsp; A place to return to</h4>
          <p>These detours are part of understanding. The challenge is to follow them without losing the thread. Keeping the original passage in sight makes the return feel effortless.</p>
          <p>With the source and its context side by side, attention can move between them. The connection becomes visible; the argument becomes easier to follow.</p>
          <div className="landing-preview__footnote">1. Close reading leaves space for questions as well as answers.</div>
        </article></div>
        {active.id === "annotate" && <aside className="landing-preview__workspace">
          <span className="landing-preview__panel-title"><ReviewIcon name="annotations" size={15} /> Annotations <span>3</span></span>
          <div className="landing-preview__annotation"><small><span className="landing-dot landing-dot--yellow" /> Highlight · Page 4</small><blockquote>They hold the detail in view without letting the larger argument slip away.</blockquote><p>This is the central idea. Bring it into the introduction.</p></div>
          <div className="landing-preview__annotation"><small><ReviewIcon name="edit" size={12} /> Replacement · Page 4</small><p><del>feel effortless</del><br /><ins>keep the argument in view</ins></p></div>
          <div className="landing-preview__annotation"><small><ReviewIcon name="note" size={12} /> Page note · Page 8</small><p>Revisit this section alongside the evidence in Table 1.</p></div>
        </aside>}
        {active.id === "reference" && <aside className="landing-preview__workspace landing-preview__reference">
          <span className="landing-preview__panel-title"><ReviewIcon name="references" size={15} /> References <ReviewIcon name="plus" size={14} /></span>
          <div className="landing-preview__reference-tab"><ReviewIcon name="link" size={13} /> Table 1 <span>Page 9</span><ReviewIcon name="close" size={12} /></div>
          <div className="landing-preview__reference-page">
            <small>9</small><h4>Table 1. A reader’s workspace</h4>
            <table><thead><tr><th>Moment</th><th>What stays close</th></tr></thead><tbody><tr><td>A question</td><td>The passage</td></tr><tr><td>A connection</td><td>The reference</td></tr><tr><td>A new thought</td><td>The margin</td></tr></tbody></table>
            <p>Each part of the workspace supports the same task: staying with an idea long enough to understand it.</p>
          </div>
          <div className="landing-preview__return"><ReviewIcon name="lock" size={13} /> Your reading stays on page 4</div>
        </aside>}
      </div>
    </div>
    <p className="landing-showcase__caption" aria-live="polite">{active.caption} <span>Illustrative preview</span></p>
  </section>;
}
