# Web beta operation and release

The Placekeeper web beta is a front-end-only, export-only companion and lightweight tryout for the full app. It is implemented and testable as a static artifact, but **it is not cleared or promoted for public use yet**. Do not add a clickable public beta URL until every promotion gate below is complete.

## Reader contract

The beta opens exactly one local PDF or one compatible public HTTPS PDF up to 64 MiB (67,108,864 bytes). Local bytes and Review State remain in the active tab; there is no Placekeeper upload, account, analytics, application telemetry, autosave, recovery store, service worker, or intentional durable browser storage. GitHub may still log ordinary requests for the site and packaged assets. A reload or closed tab loses the review. Exporting a reviewed PDF is the only durability action.

A remote URL is requested directly from its host with browser-managed credentials omitted, no referrer, no cache, and redirects disabled. The complete URL—including query parameters and signed tokens—is still transmitted, together with ordinary network metadata such as the reader's IP address and a CORS `Origin`. CORS failure can happen after the request has reached the host. Browser, operating-system, DNS, enterprise-network, extension, security-software, GitHub, and remote-host logging are outside Placekeeper's control. When direct CORS access fails, download the PDF through a trusted route and upload the local file.

The project site is non-confidential because its GitHub Pages origin is shared with unrelated pages. Frame, opener, and controlling-service-worker checks reduce some risks but are not origin isolation. PDFs remain untrusted input, and export is not a sanitizer: other source content is preserved rather than comprehensively inspected or removed.

Replace, Delete, Insert, Highlight, and Page Note are supported. A reviewed copy with valid Portable Annotation Identity can be uploaded again and its Placekeeper-owned items restored as editable Review Items without duplicate owned projections. Foreign annotations and links are preserved on a best-effort basis when the PDF is eligible for rewrite. Signed, encrypted, permission-restricted, malformed, stalled, or otherwise unexportable PDFs fail before authoring.

Each export captures one revision, rewrites it, reopens the result, and narrowly checks its page count and expected Placekeeper-owned annotation identities and appearances before asking the browser to start a download. This does not comprehensively validate the rest of the PDF, and Placekeeper cannot confirm that the browser retained the download. Edits made after the captured revision remain dirty and require another export. Reopen every important output independently.

Current desktop Chromium and Firefox are the advertised targets. Playwright WebKit is a release regression engine, not evidence for branded Safari; real desktop Safari must pass the live qualification before Safari support is promoted. Mobile browsers and PDF-content screen-reader accessibility are best effort.

For the fuller privacy and recovery distinction between local service-backed hosts and this beta, see [Privacy and recovery](privacy-and-recovery.md#front-end-only-web-beta). For reader troubleshooting, see [Support and diagnostics](support.md#web-beta). The distributed artifact exposes its generated privacy page and [third-party notices](../THIRD_PARTY_NOTICES.md).

## Fixed publication target and dormant gate

The only planned first-release target is:

- Origin: `https://brad-ross.github.io`
- Project base: `/placekeeper/`
- Expected page URL after clearance: `https://brad-ross.github.io/placekeeper/`

That address is recorded here for operator verification, not as a live reader link. The deployment workflow is manual-only and must fail closed unless the repository variable `PLACEKEEPER_PAGES_PUBLICATION` has the exact literal value `enabled`. Keep the variable absent or set to a value other than `enabled` while publication is dormant. A disabled workflow prevents a new deployment; it does not retract a site that was already published.

## Prepublication checklist

Record evidence outside transient Actions artifacts so another operator can identify the exact candidate and the next action.

- [ ] Record completed Placekeeper naming, marketplace, and domain clearance, including evidence location, approver, and date. Do not reinterpret or summarize away the external clearance record's legal substance.
- [ ] Confirm the distribution posture introduces no first-party license grant and no new production dependency or license beyond the reviewed lockfile and generated inventory. Review `THIRD_PARTY_NOTICES.md`, the artifact's `third-party-notices.html`, `production-dependencies.json`, and the embedded PDFium revision.
- [ ] Review and merge the static-browser implementation and workflows to trusted `main`. Record the immutable source SHA selected for release.
- [ ] In repository **Settings → Pages**, select **GitHub Actions** as the publishing source. A workflow cannot safely substitute this one-time setting with the normal token.
- [ ] Protect the `github-pages` environment: restrict deployments to `main`, require the designated reviewer, and confirm the environment URL is supplied only by the deployment job.
- [ ] Verify the configured Pages result is exactly the origin, base, and expected page URL above. An origin or base mismatch is a no-go, not a reason to weaken the check.
- [ ] Keep `PLACEKEEPER_PAGES_PUBLICATION` dormant while recording the candidate tuple. For a later release, set it to exactly `enabled`; absent, mixed-case, whitespace-padded, or other values must remain disabled.
- [ ] Record candidate provenance: triggering actor; gate state; source SHA; workflow run ID and attempt; artifact name and artifact ID; `content-manifest.json` SHA-256 digest; configured target origin/base; environment approval/result; deployment result; and reported `page_url`.
- [ ] Preserve the candidate's `version.json`, `content-manifest.json`, dependency inventory, and payload-manifest digest as release evidence. Do not depend on GitHub retaining the uploaded Pages artifact for rollback.
- [ ] Before first dispatch, write down either the last-known-good source SHA plus payload-manifest digest, or the first-release unpublish owner and procedure below.
- [ ] Manually dispatch only from trusted `main`. If `main` moved after packaging, the freshness fence must classify the candidate as superseded and publish nothing.

The release workflow builds the Pages artifact once, tests that same directory sequentially, verifies it was not mutated, and lets the environment-gated deploy job consume only the named same-run artifact. It does not run on each `main` push or on a schedule, and it ends after deployment without spending a hosted job on live-origin testing.

The routine `.github/workflows/static-web.yml` gate is deliberately smaller. It runs only for pull requests whose static dependency surface changed, cancels an older run for the same pull request, and uses one read-only Ubuntu job with the Chromium critical profile. It never uses `pull_request_target`, receives no deploy or OIDC permission, and retains short-lived browser diagnostics only when the gate fails.

The manual `.github/workflows/deploy-pages.yml` path has exactly two jobs. The unprotected `package` job has only `contents: read`; it checks out once without persisted credentials, installs once, builds once, runs static unit and PDF conformance checks followed by exhaustive Chromium and representative Firefox/WebKit coverage against that one directory, revalidates its unchanged bytes, and uploads one run-and-attempt-named Pages artifact. The `deploy` job is the only job attached to the protected `github-pages` environment and the only job with Pages/OIDC write permission. It performs no checkout, install, or repository-script execution. Immediately before the official deploy action it reads trusted `main` through the GitHub API, verifies the packaged source is still current, verifies the official upload returned a numeric artifact ID for the deterministic same-run name, and verifies the configured origin and `/placekeeper/` project base. Any mismatch stops publication.

## Live smoke and terminal classifications

After a successful deployment, use a clean trusted local checkout whose `HEAD` is the deployed source SHA. Do not supply a GitHub token or Pages permission to the smoke process. Run the local script with the recorded page URL, source SHA, and content-manifest digest:

```sh
pnpm smoke:static-pages -- --url https://brad-ross.github.io/placekeeper/ --source <deployed-source-sha> --content <content-manifest-sha256>
```

The command refuses to run when a GitHub/Actions token is present, the checkout is dirty, `HEAD` or the local trusted `origin/main` ref differs from `--source`, or `remote.origin.url` is not the reviewed `brad-ross/placekeeper` repository. Fetch and inspect trusted `main`, create a clean checkout at the deployed source, remove token-bearing environment variables, and generate no fixture files before running it. The smoke creates its local annotated PDF entirely in memory.

The script uses a fresh browser context, cache-busted identity reads for at most ten minutes, complete payload-manifest hash and size verification, PDFium worker and `application/wasm` MIME checks, and one local upload-render-keyboard-annotate-export journey followed by an independent-context editable reopen. It prints one JSON record containing the probe commit, target URL, deployed source SHA, payload digest, observed tuple when available, browser version, timestamp, terminal result, and a bounded detail. Retain that record outside transient workflow artifacts. A non-`passed` classification exits nonzero.

For the first release, when there is deliberately no last-known-good site to roll back to, append `--first-release`. That makes an otherwise unreachable or broken first candidate terminally classify as `first-release-failure`, preserving the documented administrator-unpublish response rather than implying that a rollback target exists. Do not use the flag after a known-good release has been recorded.

Classify the outcome exactly once:

- **passed** — the observed source and complete payload cohort equal the expected tuple and the full scripted journey passes. Next: perform and record the real desktop Safari qualification below.
- **propagation-timeout** — the expected identity did not become coherent within the documented ten-minute limit. Next: stop promotion, preserve the observations, and investigate Pages/cache state before one new smoke attempt; do not relabel this as an application regression.
- **superseded** — the live coherent source is newer or otherwise differs because the candidate is no longer current. Next: select and record a fresh trusted-`main` candidate; do not publish or promote the stale tuple.
- **regression** — the expected coherent identity appeared but manifest, asset, worker, MIME, security, or PDF journey checks failed. Next: stop promotion and begin the rollback procedure.
- **first-release-failure** — the first public deployment cannot pass the expected-identity smoke and there is no last-known-good release. Next: have the repository administrator unpublish Pages and disable publication.

For first promotion, open the live URL in a real, current desktop Safari window and record Safari/macOS versions, time, deployed source SHA, and payload digest. Select a local eligible PDF that contains a foreign annotation, render it, create a Review Item, export, independently reopen the downloaded copy, confirm the owned item is editable exactly once, and confirm the foreign annotation remains. Playwright WebKit does not replace this check.

Only after both the scripted smoke is `passed` and the Safari qualification passes may the operator change README copy to a clickable link. The promoted copy must retain the non-confidential label and visible privacy and third-party-notice links. Completing a deployment alone is not authorization to promote.

## Rollback and first-release unpublish

For a regression when a last-known-good release exists:

1. Disable further publication by removing `PLACEKEEPER_PAGES_PUBLICATION` or changing it away from exact `enabled` while selecting the rollback.
2. Revert or restore the last-known-good source on `main` through normal reviewed history. The rollback commit is a new, truthful source identity; do not copy the old source SHA into its provenance.
3. Confirm the newly built candidate's payload-manifest digest exactly matches the recorded last-known-good payload digest. If it does not, stop and investigate rather than calling it a rollback.
4. Re-enable the exact variable, manually dispatch the new `main` rollback source, and record the new run, attempt, artifact name and ID, source SHA, payload digest, environment/deployment results, and `page_url`.
5. Run the complete local live smoke against the new source identity and known-good payload digest. Keep the README unlinked or remove its promoted link until the smoke passes.

Do not rely on a retained Pages artifact: rollback is a new build and deployment whose content identity is compared with the separately retained last-known-good digest.

If the first public release fails and no known-good site exists, an administrator must open repository **Settings → Pages** and unpublish/disable the site, then make `PLACEKEEPER_PAGES_PUBLICATION` dormant. Verify the project URL no longer serves the beta, record the unpublish time and actor, keep the README unlinked, and return to candidate review. Disabling the variable or workflow by itself does not remove already served content.

Public distribution under the Placekeeper name remains gated until this checklist, one classified complete live smoke, the real-Safari qualification, and README promotion are all recorded. Until then, the exact next action is to keep publication dormant and complete external clearance—not to dispatch or advertise the Pages site.
