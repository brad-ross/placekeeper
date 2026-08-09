import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CommentComposer } from "../src/review/CommentComposer.js";

describe("CommentComposer Warm Neutral contract", () => {
  it("owns its field and action styling without changing optional or disabled semantics", () => {
    const html = renderToStaticMarkup(
      <CommentComposer
        title="Highlight comment"
        optional
        onSave={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(html).toContain("data-comment-composer");
    expect(html).toContain('class="comment-composer__field"');
    expect(html).toContain('class="comment-composer__input"');
    expect(html).toContain("Comment (optional)");
    expect(html).toContain("Keep without comment");
    expect(html).toContain('review-button review-button--primary');
    expect(html).toContain('class="lucide lucide-check review-icon"');
    expect(html).not.toContain("disabled");
  });

  it("keeps required whitespace-only content disabled on initial render", () => {
    const html = renderToStaticMarkup(
      <CommentComposer
        title="Page Note"
        initialValue="   "
        onSave={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(html).toContain("Save comment");
    expect(html).toContain("disabled");
  });
});
