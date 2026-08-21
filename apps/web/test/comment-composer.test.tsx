import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CommentComposer } from "../src/review/CommentComposer.js";

describe("CommentComposer Warm Neutral contract", () => {
  it("owns its field and action styling without changing optional or disabled semantics", () => {
    const html = renderToStaticMarkup(
      <CommentComposer
        title="Highlight Comment"
        optional
        onSave={vi.fn()}
        onSkip={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(html).toContain("data-comment-composer-backdrop");
    expect(html).toContain("data-comment-composer");
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('class="comment-composer compact-editorial-modal"');
    expect(html).toContain('comment-composer__header compact-editorial-modal__header');
    expect(html).toContain('compact-editorial-modal__body');
    expect(html).toContain('comment-composer__actions compact-editorial-modal__footer');
    expect(html).toContain('class="comment-composer__field"');
    expect(html).toContain('class="comment-composer__input"');
    expect(html).toContain('<span class="sr-only">Comment (optional)</span>');
    expect(html).toContain(">Cancel</span>");
    expect(html).toContain(">Keep</span>");
    expect(html).not.toContain("Review note");
    expect(html).toContain('review-button review-button--primary');
    expect(html).toContain('class="lucide lucide-check review-icon"');
    expect(html).toContain('class="lucide lucide-arrow-right review-icon"');
    expect(html).not.toContain("disabled");
  });

  it("uses a truthful cancel action for optional edit-style composers without a skip handler", () => {
    const html = renderToStaticMarkup(
      <CommentComposer
        title="Edit Highlight"
        optional
        initialValue="Existing note"
        onSave={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(html).toContain(">Cancel</span>");
    expect(html).toContain('class="lucide lucide-x review-icon"');
    expect(html).not.toContain(">Keep</span>");
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

    expect(html).toContain(">Save</span>");
    expect(html).toContain("disabled");
  });

  it("keeps the field name accessible without repeating the modal title visually", () => {
    const html = renderToStaticMarkup(
      <CommentComposer
        title="Replacement"
        fieldLabel="Replacement"
        onSave={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(html).toContain('<span class="sr-only">Replacement</span>');
    expect(html).not.toContain('class="comment-composer__label"');
  });
});
