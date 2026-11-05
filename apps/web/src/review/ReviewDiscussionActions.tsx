import { useState } from 'react';
import type { ReviewContextSnapshot } from '../host/review-context-snapshot.js';
/** The chooser tracks IDs only; the click reads current accepted content. */
export function ReviewDiscussionActions(props: { readonly annotations: ReviewContextSnapshot['annotations']; readonly activeId?: string; readonly onDiscuss: (ids: readonly string[]) => void }) {
 const [chosen, setChosen] = useState<readonly string[]>([]);
 const selected = chosen.filter(id => props.annotations.some(a => a.id === id));
 return <details className="review-discussion-actions" data-review-contextual-ui>
  <summary>Discuss annotations in chat</summary>
  <fieldset><legend>Choose annotations</legend>
   {props.annotations.map(a => <label key={a.id}><input type="checkbox" checked={selected.includes(a.id)} onChange={e => setChosen(e.target.checked ? [...selected, a.id] : selected.filter(id => id !== a.id))} />Page {a.page} · {a.kind}: {a.text.slice(0, 120)}</label>)}
  </fieldset>
  {props.activeId ? <button type="button" onClick={() => setChosen([props.activeId!])}>Choose active annotation</button> : null}
  <button type="button" disabled={!selected.length} onClick={() => props.onDiscuss(selected)}>Discuss these annotations</button>
 </details>;
}
