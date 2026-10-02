# Codex native transport qualification (U3)

U3 supplies an installed stdio adapter, credential-free versioned shell, private
app protocol, verified document chunk transfer, and trusted prompt context. The
shell inspects canonical review state; production reader integration follows in
U4. Stop dependent native integration until the actual installed host gate passes.
Unit tests, in-memory SDK bridges, and the previous synthetic probe cannot pass it.

## Build and install

Run `pnpm build:codex-mcp`, `pnpm typecheck`, and `pnpm test:codex-native`.
Normal `pnpm build` includes the adapter. The macOS builder requires self-contained
`dist/codex-mcp/server.js` and `review-v1.html` and copies them to
`Contents/Resources/codex-mcp`. The existing whole-artifact identity and signature
cover these files. Existing active-review upgrade deferral remains in force.

The existing compatibility plugin registers `./.mcp.json`, the official
compatibility format. There is no unused portable `mcp.json` duplicate. Its sole
server `placekeeper` executes `/bin/sh -c` with the fixed command
`exec /bin/sh "$HOME/Applications/Placekeeper.app/Contents/Resources/integrations/codex-plugin/scripts/mcp.sh"`. The explicit shell expands `HOME`; the wrapper uses the installed bundled Node runtime and adapter. MCP arguments are literal argv, so plugin-hook `PLUGIN_ROOT` expansion must not be assumed here. The adapter accesses the existing
private daemon socket, adds no HTTP listener and cannot stop the daemon on EOF.

Use the existing app/plugin installation flow, review its trust prompts, enable
the matching MCP server and lifecycle hooks, and reload Codex as instructed.
Copying files alone does not prove activation. A missing, disabled or incompatible
cached panel requires restoring/enabling the matching installation, reloading
Codex, and reopening through `$placekeeper`. A browser fallback cannot pass U3.

## Prepare the evidence report

```
pnpm qualify:codex-native init /absolute/private/path/u3-host-report.json
```

Record exact Codex build, OS, plugin version and installed artifact digest. Use
two small real reviewed PDFs with distinguishable items, such as private copies
of `test/fixtures/pdfs/text-native-with-annotations.pdf`. The operator must
explicitly authorize creating actual chats and performing host qualification.

Never publish handoffs, bind proofs, pending/presentation capabilities, reconnect
tickets, private `_meta`, or PDF bytes. Retain raw evidence privately. Report only
sanitized hook field shapes, hashed task identifiers, receipt identifiers,
status/timestamps, revision, digest and Save Sync outcomes. Each check requires an
actual-host observation and timestamp. Report verification checks completeness;
it cannot certify that self-reported observations are true. Review the evidence.

## Exercise the packaged flow

1. In each actual chat ask `$placekeeper` to open its explicitly named PDF. Exercise
   the shipped direct launcher, trusted Bash claim hook and exact
   `mcp__placekeeper__display_review` handoff. Confirm a native panel reports
   verified generation, revision, Save Sync and digest. Capture actual launcher
   and display PostToolUse field shapes and prove equal trusted hook task identity.
   Display structured output must be exactly the closed correlation receipt.
2. Record readiness-before-attestation and attestation-before-readiness from actual
   host events. The display call returns before its hook. Missing or wrong-task
   attestation remains pending/denied. If either ordering cannot be established,
   mark it unproved; simulated hook payloads cannot fill the gap.
3. Two invocations of the same cached shell must receive distinct private invocation
   data. App capabilities must be absent from model content and structured output.
   Confirm actual host enforcement of app-only `review_app` visibility. Data calls
   create no additional panels; only display carries the UI resource URI.
4. Using authorized host qualification controls, swap receipts across the actual
   chats. Task mismatch must deny admission. Replay old display results and verify
   they cannot activate a new attempt. Never weaken hooks or manually bind a task
   to manufacture a pass.
5. Accept a review change through an existing authorized service/CLI operation or
   participating view. A subsequent **real user prompt** must obtain that chat's
   current revision, Review Items, Existing PDF Annotations and Save Sync, then
   bounded current PDF evidence through the shipped skill's existing commands.
   Pending/failed persistence must preserve accepted work without reporting it as
   saved. The other chat's actual prompt obtains only its own review.
6. Exercise protected recovery using shipped resume/discard/fork continuation,
   scoped offer and stable operation ID. Exercise focused ownership denial: the
   skill explains conflict and offers an explicitly requested independent review
   without repeated launches or silent takeover.

## Per-panel lifecycle gate

The shell independently renews its authenticated presentation every five seconds
regardless of visibility. Watermark polling occurs after completion at one second
while visible and five seconds while hidden; it never renews participation. The
service disconnect timeout is 30 seconds. A verified document materialization is
reused only for the same incarnation and exact immutable descriptor; review
revision and Save Sync watermark changes do not poll PDF bytes. The shell imposes
no document-size cap; host allocation failure has explicit memory recovery guidance.
Shared stdio process health grants no
panel authority. Successful renewal timestamps appear in the qualification shell.

Observe renewals before, throughout and after chat switching, hiding/restoration,
and fullscreen expansion/restoration for longer than the disconnect timeout.
Record timestamps independently from watermark polling. Hiding must not revoke a
live panel. If host suspension expires hidden panels, record required capability
failure and stop dependent interaction work.

Close one panel and prove teardown/detach or measured timeout revokes only that
presentation, preserving work and peers. Lose one transport and record the scoped
timeout. Start two stdio clients and end one; daemon identity and the peer must
remain active. Old attempt renewal/release replies cannot renew or detach a
successor. The U3 shell discloses unverifiable connection loss and directs
reopening through the skill. Full restart/client hydration is later integration.

```
pnpm qualify:codex-native verify /absolute/private/path/u3-host-report.json
```

A complete passing report plus reviewed raw evidence establishes the host baseline.
Missing trusted identity, private metadata isolation, app-only calls, real prompt
currentness or reliable hidden renewal fails or leaves the gate unproved. Preserve
the evidence and stop U4-dependent work.
