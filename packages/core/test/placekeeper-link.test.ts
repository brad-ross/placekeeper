import { describe, expect, it } from "vitest";

import {
  decodePlacekeeperLinkFragment,
  decodePlacekeeperReadableViewPathname,
  decodePlacekeeperLink,
  encodePlacekeeperLinkFragment,
  encodePlacekeeperReadableViewPathname,
  encodePlacekeeperLink,
  PLACEKEEPER_LINK_MAX_LENGTH,
  placekeeperLinkBase,
} from "../src/placekeeper-link.js";

const itemId = "11111111-1111-4111-8111-111111111111";
const viewId = "22222222-2222-4222-8222-222222222222";

const exactDestinations = [
  [{ mode: "xyz", params: [10.5, 20, 1.25] }, "xyz&params=10.5,20,1.25"],
  [{ mode: "fit-page", params: [] }, "fit-page"],
  [{ mode: "fit-bounding-box", params: [] }, "fit-bounding-box"],
  [{ mode: "fit-horizontal", params: [612] }, "fit-horizontal&params=612"],
  [{ mode: "fit-vertical", params: [72.5] }, "fit-vertical&params=72.5"],
  [
    { mode: "fit-bounding-box-horizontal", params: [700] },
    "fit-bounding-box-horizontal&params=700",
  ],
  [
    { mode: "fit-bounding-box-vertical", params: [24] },
    "fit-bounding-box-vertical&params=24",
  ],
  [
    { mode: "fit-rectangle", params: [100, 200.25, 500, 700] },
    "fit-rectangle&params=100,200.25,500,700",
  ],
] as const;

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

  it.each(exactDestinations)("round-trips the canonical %s exact destination", (destination, encoded) => {
    const location = {
      kind: "destination" as const,
      page: 3,
      mode: destination.mode,
      params: destination.params,
    };

    expect(encodePlacekeeperLinkFragment(location)).toBe(`v=2&page=3&mode=${encoded}`);
    expect(decodePlacekeeperLinkFragment(`v=2&page=3&mode=${encoded}`)).toEqual(location);
    expect(decodePlacekeeperLink(encodePlacekeeperLink({
      path: "/tmp/paper.pdf",
      location,
    }))).toEqual({ path: "/tmp/paper.pdf", location });
  });

  it("keeps existing v1 page and item fragments byte-compatible", () => {
    expect(encodePlacekeeperLinkFragment({ kind: "page", page: 12 })).toBe("v=1&page=12");
    expect(encodePlacekeeperLinkFragment({ kind: "item", page: 3, itemId }))
      .toBe(`v=1&page=3&item=${itemId}`);
  });

  it("uses one canonical representation for finite destination parameters", () => {
    const location = {
      kind: "destination" as const,
      page: 4,
      mode: "fit-rectangle" as const,
      params: [0, -1.5, 1e-7, 1e21],
    };
    const fragment = "v=2&page=4&mode=fit-rectangle&params=0,-1.5,1e-7,1e+21";

    expect(encodePlacekeeperLinkFragment(location)).toBe(fragment);
    expect(decodePlacekeeperLinkFragment(fragment)).toEqual(location);
  });

  it.each([
    ["duplicate page", "v=2&page=3&page=3&mode=fit-page"],
    ["duplicate mode", "v=2&page=3&mode=fit-page&mode=fit-page"],
    ["duplicate params", "v=2&page=3&mode=xyz&params=1,2,3&params=1,2,3"],
    ["unknown key", "v=2&page=3&mode=fit-page&zoom=2"],
    ["unsupported mode", "v=2&page=3&mode=unknown"],
    ["missing params", "v=2&page=3&mode=xyz"],
    ["params on zero-arity mode", "v=2&page=3&mode=fit-page&params=1"],
    ["wrong parameter count", "v=2&page=3&mode=fit-rectangle&params=1,2,3"],
    ["NaN", "v=2&page=3&mode=fit-horizontal&params=NaN"],
    ["infinity", "v=2&page=3&mode=fit-horizontal&params=Infinity"],
    ["negative zero", "v=2&page=3&mode=fit-horizontal&params=-0"],
    ["leading zero", "v=2&page=3&mode=fit-horizontal&params=01"],
    ["explicit plus", "v=2&page=3&mode=fit-horizontal&params=+1"],
    ["redundant decimal", "v=2&page=3&mode=fit-horizontal&params=1.0"],
    ["redundant exponent", "v=2&page=3&mode=fit-horizontal&params=1e0"],
    ["uppercase exponent", "v=2&page=3&mode=fit-horizontal&params=1E+21"],
    ["control", "v=2&page=3&mode=fit-horizontal&params=1\u0000"],
    ["session field", "v=2&page=3&mode=fit-page&session=secret"],
    ["generation field", "v=2&page=3&mode=fit-page&generation=2"],
    ["identity field", "v=2&page=3&mode=fit-page&identity=derived"],
    ["task field", "v=2&page=3&mode=fit-page&task=secret"],
  ])("rejects a v2 exact destination with %s", (_caseName, fragment) => {
    expect(() => decodePlacekeeperLinkFragment(fragment)).toThrow();
  });

  it.each([
    ["wrong arity", { kind: "destination", page: 3, mode: "xyz", params: [1, 2] }],
    ["non-finite", { kind: "destination", page: 3, mode: "fit-horizontal", params: [NaN] }],
    ["negative zero", { kind: "destination", page: 3, mode: "fit-horizontal", params: [-0] }],
  ] as const)("refuses to encode exact destination data with %s", (_caseName, location) => {
    expect(() => encodePlacekeeperLinkFragment(location)).toThrow();
  });

  it("keeps page-only author destinations on the existing v1 page grammar", () => {
    expect(encodePlacekeeperLinkFragment({ kind: "page", page: 3 })).toBe("v=1&page=3");
    expect(() => decodePlacekeeperLinkFragment("v=2&page=3&mode=unknown")).toThrow();
  });

  it("keeps exact destinations generation-free and applies the shared length limit", () => {
    const encoded = encodePlacekeeperLinkFragment({
      kind: "destination",
      page: 8,
      mode: "xyz",
      params: [72, 144, 1.5],
    });
    expect(encoded).toBe("v=2&page=8&mode=xyz&params=72,144,1.5");
    expect(encoded).not.toMatch(/session|generation|identity|task|credential|selection|panel/iu);
    expect(() => decodePlacekeeperLinkFragment(
      `v=2&page=8&mode=xyz&params=72,144,${"1".repeat(PLACEKEEPER_LINK_MAX_LENGTH)}`,
    )).toThrow("length");
  });

  it("shares the exact safe-fragment grammar with browser recovery", () => {
    expect(decodePlacekeeperLinkFragment("v=1&page=12")).toEqual({ kind: "page", page: 12 });
    expect(decodePlacekeeperLinkFragment(`v=1&page=3&item=${itemId}`)).toEqual({
      kind: "item",
      page: 3,
      itemId,
    });
    expect(encodePlacekeeperLinkFragment({ kind: "item", page: 3, itemId }))
      .toBe(`v=1&page=3&item=${itemId}`);
    expect(() => decodePlacekeeperLinkFragment("#v=1&page=12")).toThrow();
    expect(() => decodePlacekeeperLinkFragment("v=1&page=12&page=13")).toThrow();
  });

  it.each([
    "/Users/Brad/My Paper.pdf",
    "/Users/Brad/论文.pdf",
    "/Users/Brad/literal # question ? percent %.pdf",
    "/Users/Brad/literal %2F filename.pdf",
  ])("round-trips a strict readable view route without filesystem access: %s", (path) => {
    const pathname = encodePlacekeeperReadableViewPathname({ viewId, path });
    expect(decodePlacekeeperReadableViewPathname(pathname)).toEqual({ viewId, path });
    expect(pathname).toBe(`/r/${viewId}${placekeeperLinkBase(path).slice("placekeeper://".length)}`);
  });

  it.each([
    ["non-v4 view ID", "/r/22222222-2222-2222-8222-222222222222/tmp/paper.pdf"],
    ["uppercase view ID", "/r/22222222-2222-4222-8222-22222222222A/tmp/paper.pdf"],
    ["query", `/r/${viewId}/tmp/paper.pdf?x=1`],
    ["fragment", `/r/${viewId}/tmp/paper.pdf#v=1&page=1`],
    ["empty segment", `/r/${viewId}/tmp//paper.pdf`],
    ["dot segment", `/r/${viewId}/tmp/./paper.pdf`],
    ["dot-dot segment", `/r/${viewId}/tmp/../paper.pdf`],
    ["encoded slash", `/r/${viewId}/tmp%2Fpaper.pdf`],
    ["encoded backslash", `/r/${viewId}/tmp/paper%5Cname.pdf`],
    ["literal backslash", `/r/${viewId}/tmp/paper\\name.pdf`],
    ["malformed escape", `/r/${viewId}/tmp/%ZZ.pdf`],
    ["encoded control", `/r/${viewId}/tmp/paper%00.pdf`],
    ["non-PDF", `/r/${viewId}/tmp/notes.txt`],
  ])("rejects a readable route with %s", (_caseName, pathname) => {
    expect(() => decodePlacekeeperReadableViewPathname(pathname)).toThrow();
  });

  it("rejects an oversized readable route before parsing", () => {
    expect(() => decodePlacekeeperReadableViewPathname(
      `/r/${viewId}/${"a".repeat(PLACEKEEPER_LINK_MAX_LENGTH)}.pdf`,
    )).toThrow("length");
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
    ["incomplete v2", "placekeeper:///tmp/paper.pdf#v=2&page=1"],
    ["zero page", "placekeeper:///tmp/paper.pdf#v=1&page=0"],
    ["signed page", "placekeeper:///tmp/paper.pdf#v=1&page=+1"],
    ["unsafe item", "placekeeper:///tmp/paper.pdf#v=1&page=1&item=review%20item"],
    ["uppercase item", "placekeeper:///tmp/paper.pdf#v=1&page=1&item=11111111-1111-4111-8111-11111111111A"],
    ["uppercase grammar", "placekeeper:///tmp/paper.pdf#V=1&PAGE=1"],
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
