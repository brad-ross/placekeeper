import { describe, expect, it } from "vitest";

import {
  decodePlacekeeperLink,
  encodePlacekeeperLink,
  PLACEKEEPER_LINK_MAX_LENGTH,
  placekeeperLinkBase,
} from "../src/placekeeper-link.js";

const itemId = "11111111-1111-4111-8111-111111111111";

describe("Placekeeper link codec", () => {
  it.each([
    "/Users/Brad/My Paper.pdf",
    "/Users/Brad/论文.pdf",
    "/Users/Brad/literal # question ? percent %.pdf",
    "/Users/Brad/literal %2F filename.pdf",
  ])("round-trips a canonical absolute PDF path: %s", (path) => {
    const encoded = encodePlacekeeperLink({
      path,
      location: { kind: "item", page: 12, itemId },
    });

    expect(decodePlacekeeperLink(encoded)).toEqual({
      path,
      location: { kind: "item", page: 12, itemId },
    });
    expect(encoded).toBe(`${placekeeperLinkBase(path)}#v=1&page=12&item=${itemId}`);
  });

  it("classifies page-only and portable-item locations with a page fallback", () => {
    expect(decodePlacekeeperLink("placekeeper:///tmp/paper.pdf#v=1&page=1")).toEqual({
      path: "/tmp/paper.pdf",
      location: { kind: "page", page: 1 },
    });
    expect(decodePlacekeeperLink(
      `placekeeper:///tmp/paper.pdf#v=1&page=3&item=${itemId}`,
    )).toEqual({
      path: "/tmp/paper.pdf",
      location: { kind: "item", page: 3, itemId },
    });
  });

  it.each([
    ["authority", "placekeeper://host/tmp/paper.pdf#v=1&page=1"],
    ["userinfo", "placekeeper://user@host/tmp/paper.pdf#v=1&page=1"],
    ["port", "placekeeper://host:123/tmp/paper.pdf#v=1&page=1"],
    ["query", "placekeeper:///tmp/paper.pdf?x=1#v=1&page=1"],
    ["relative path", "placekeeper:tmp/paper.pdf#v=1&page=1"],
    ["encoded slash", "placekeeper:///tmp%2Fpaper.pdf#v=1&page=1"],
    ["malformed escape", "placekeeper:///tmp/%ZZ.pdf#v=1&page=1"],
    ["duplicate key", "placekeeper:///tmp/paper.pdf#v=1&page=1&page=2"],
    ["unknown key", "placekeeper:///tmp/paper.pdf#v=1&page=1&zoom=2"],
    ["unknown version", "placekeeper:///tmp/paper.pdf#v=2&page=1"],
    ["zero page", "placekeeper:///tmp/paper.pdf#v=1&page=0"],
    ["signed page", "placekeeper:///tmp/paper.pdf#v=1&page=+1"],
    ["unsafe item", "placekeeper:///tmp/paper.pdf#v=1&page=1&item=review%20item"],
    ["encoded control", "placekeeper:///tmp/paper%00.pdf#v=1&page=1"],
    ["session state", "placekeeper:///tmp/paper.pdf#v=1&page=1&session=secret"],
  ])("rejects %s", (_caseName, input) => {
    expect(() => decodePlacekeeperLink(input)).toThrow();
  });

  it("rejects oversized input before parsing it", () => {
    expect(() => decodePlacekeeperLink(
      `placekeeper:///${"a".repeat(PLACEKEEPER_LINK_MAX_LENGTH)}.pdf#v=1&page=1`,
    )).toThrow("length");
  });

  it("does not permit session-only viewer state in the typed location", () => {
    const encoded = encodePlacekeeperLink({
      path: "/tmp/paper.pdf",
      location: { kind: "page", page: 8 },
    });
    expect(encoded).toBe("placekeeper:///tmp/paper.pdf#v=1&page=8");
    expect(encoded).not.toMatch(/zoom|scroll|selection|search|panel|generation|task|credential/iu);
  });
});
