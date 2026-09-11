---
title: "Prove CSS extraction equivalence with ordered source expansion"
date: "2026-09-10"
category: workflow-issues
module: Review stylesheet ownership verification
problem_type: workflow_issue
component: testing_framework
severity: medium
applies_when:
  - "Stylesheets are split or relocated without an intended behavior change"
  - "Ordered overrides and shared host consumers make declaration presence insufficient"
  - "Existing visual snapshots already fail before the extraction"
tags: [css, cascade, refactoring, visual-regression, baseline-comparison]
---

# Prove CSS extraction equivalence with ordered source expansion

## Context

The September 2026 repository reorganization moved CSS into component-owned files while preserving aggregate entrypoints. The final import graph shows the new ownership, but it cannot explain how the extraction was checked against the original cascade. The [verification audit](../../audits/2026-09-10-repository-organization-verification.md) records the results; this learning preserves the comparison method, whose original implementation was a temporary investigation script.

The useful distinction is between an ordered stream of CSS and a collection of declarations. A selector inventory would accept moving a late override earlier. A test that reads only a newly shortened entrypoint might see imports instead of the rules it previously checked. Existing visual failures also prevent a simple green/red result from identifying which differences the extraction introduced.

## Guidance

Compare each baseline entrypoint with its candidate after expanding local imports **at their original positions**. Parse both with the same parser. Retain node nesting, selectors, declaration order, property values, importance, and at-rule names and conditions. Remove comments and parser bookkeeping only. Sorting object keys makes serialization stable; sorting the node or declaration arrays would destroy the property being proved.

Keep the accepted import language explicit. The extraction used bare quoted local paths. Reject conditional imports, URL forms, and other unsupported syntax rather than flattening away their conditions. This is a constrained comparison technique, not a replacement for the browser's CSS import implementation. Likewise, compare inputs with the same URL-resolution context: unchanged relative asset text does not establish equivalence if a stylesheet is moved to a different directory.

Use a second text check when preservation of original bodies matters: each extracted body should be an exact contiguous substring of its baseline source. This covers comments and formatting deliberately omitted by the parsed-tree comparison. Neither check implies that minified bundles will have identical bytes.

Keep existing source-contract assertions and adapt their input reader. Placekeeper's `test/support/read-css-source.ts` recursively substitutes simple quoted imports in place; `apps/web/test/review-layout.test.tsx` uses it to keep checking the aggregate stylesheet. It has no general conditional-import parser or cycle guard. Do not treat that helper as complete expansion for a future, broader import language.

## Why This Matters

The structural comparison makes a stylesheet move reviewable even when the stored screenshots are already stale. It must still be paired with rendered evidence: an equivalent stylesheet does not prove equivalent class application, loaded assets, DOM structure, or native paint.

For an already-failing visual workload, pair baseline and candidate **actual** images by test and snapshot identity, and compare those files directly. Equal failure totals are insufficient: different images can both fail the same stored expectation. Record failures that occur before capture and cases omitted by a failure limit as unverified. Do not regenerate expected snapshots to make an ownership refactor pass.

Native WebKit needs its own pixel check before resize; browser layout bounds cannot establish that its compositor painted a surface. The [native first-paint learning](../ui-bugs/native-webkit-workspace-first-paint-redundant-clipping.md) owns that diagnosis and its entry-path requirements. A successful direct-file launch does not establish native picker coverage.

## When to Apply

Use this method for extraction or relocation that claims to preserve the cascade. If declarations, token scope, import conditions, relative URL bases, or ordering intentionally change, investigate those changes separately; the source-equality proof no longer establishes their equivalence. Preserve scoped token and portal consumers as part of the comparison's entrypoint set.

## Examples

The following core comparison reproduces the normalization used for the extraction. It assumes filesystem paths for matching baseline and candidate entrypoints. PostCSS is resolved from Vite's existing dependency tree for the proof; it is not a new product dependency.

```js
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const postcss = createRequire(require.resolve('vite/package.json'))('postcss');

function expand(file) {
  const root = postcss.parse(fs.readFileSync(file, 'utf8'), { from: file });
  root.walkAtRules('import', (node) => {
    assert.match(node.params, /^['"][^'"]+['"]$/);
    const dependency = path.resolve(path.dirname(file), node.params.slice(1, -1));
    node.replaceWith(...expand(dependency).nodes);
  });
  return root;
}

function normalize(node) {
  if (node.type === 'comment') return undefined;
  const result = {};
  for (const key of Object.keys(node).sort()) {
    if (['raws', 'source', 'parent', 'proxyCache', 'lastEach', 'indexes'].includes(key)) continue;
    if (key === 'nodes') result.nodes = node.nodes.map(normalize).filter(Boolean);
    else if (typeof node[key] !== 'function') result[key] = node[key];
  }
  return result;
}

assert.deepEqual(normalize(expand(candidateEntry)), normalize(expand(baselineEntry)));
```

This small proof assumes an acyclic graph of supported local imports. Review the parser metadata exclusions if the parser changes; do not discard a newly encountered semantic field just to obtain equality.

For example, `apps/web/src/app/neutral-chrome.css` deliberately imports annotation-reader styles before the late workspace-interaction refinements. Preserve that order even when both files contain selectors for the same component. In `apps/web/src/app/review-viewer-framing.css`, retain the general drawer clip and subsequent Mac overflow exception together in the effective stream.

In the dated extraction, nine expanded original stylesheet trees matched and fifteen extracted bodies retained contiguous original text. All thirty emitted actual visual images matched byte-for-byte despite the existing snapshot failures. The audit records the unexecuted cases and native launch limitations; these results establish only the comparisons performed, not a green suite or universal rendering equivalence.

## Related

- [Contributor guidance](../../../CONTRIBUTING.md) lists current stylesheet owners, token boundaries, and canonical test commands.
- [Repository organization verification](../../audits/2026-09-10-repository-organization-verification.md) records the original comparison results and their limits.
- [Native WebKit first paint](../ui-bugs/native-webkit-workspace-first-paint-redundant-clipping.md) explains why geometry and paint need separate evidence.
