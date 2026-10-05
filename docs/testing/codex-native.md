# Codex native transport qualification (U3)

U3 supplies an installed stdio adapter, credential-free versioned shell, private
app protocol, verified document chunk transfer, and trusted prompt context. The
shell inspects canonical review state; production reader integration follows in
U4. Stop dependent native integration until the actual installed host gate passes.
Unit tests, in-memory SDK bridges, and the previous synthetic probe cannot pass it.

## Recorded U3 host baseline

The reviewed actual-host U3 gate passed on Codex build 12947, commit
`b4107526316a0f152770b1306bd61cc578498c90`, macOS 26.7 build 25G229, plugin
`0.1.0+codex.20260813212014`, installed artifact
`70c333f866f24564ebbf62c477292e2a196ca6423b9f433f63e75d27ece67fa6`.
The [sanitized qualification record](codex-native-u3-qualification.json) contains
the 18 gate checks, the approved hidden explicit reconnect alternative, current
receipt-swap/replay proofs, original observation dates and inherited evidence
provenance. Raw receipts and logs remain private. The existing report verifier
checks completeness; the passing conclusion also required review of actual evidence.

Current chat switching and Restore/reexpand preserved the same owning instance
and authenticated renewal beyond the 30-second disconnect timeout. The earlier
build-12776 Restore continuity failure remains historical. Hidden participation
was qualified through explicit fresh reconnect after unavailable context;
uninterrupted hidden renewal was not established. Close expiry measured 326084 ms
from click, while owning bridge-loss expiry measured 30576 ms from last authenticated
renewal. The close result does not establish immediate detach or expiry within
30 seconds of clicking. Recovery covers selected resume. Bounded PDF evidence
comes from actual human prompts, separately from current UI observations.

This baseline closes U3 transport and correlation qualification for that exact
host and artifact. U4 production reader integration and U5-U8 acceptance still
require implementation and qualification. The reproducible procedures below
remain the gate for another host or artifact.

```
pnpm qualify:codex-native verify docs/testing/codex-native-u3-qualification.json
```

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

The candidate default sets `async:true` only on the exact
`^mcp__placekeeper__display_review$` PostToolUse handler. The Bash claim,
UserPromptSubmit and SessionEnd hooks remain synchronous. The display hook keeps
its command, matcher and output contract, with a 55-second display-only timeout. Under the official
[background-hook contract](https://learn.chatgpt.com/docs/hooks), it receives the
same trusted event input and runs without holding up the host. Informational
output, including denial warnings, is deferred until a later agent safe point;
it cannot block or rewrite the triggering tool result. SessionEnd cancels
unfinished background hooks and discards undelivered output.

Service admission still requires the genuine receipt attestation for the claimed
task and authenticated shell readiness. Either may arrive first. Readiness alone
returns only pending status, with no document or presentation authority; absent,
expired or revoked attestation cannot activate the panel. Hook output carries no
app capabilities. The async setting is a candidate configuration, not ordering
evidence: after the normal trust and reload flow, capture the exact installed
hooks configuration and artifact provenance and prove both orders on the actual
host before passing U3 or proceeding to U4.

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

Observe renewal and instance identity before and after chat switching, hiding/restoration,
and fullscreen expansion/restoration for longer than the disconnect timeout. Record
timestamps independently from watermark polling. A host-preserved panel must continue
renewing. A suspended/remounted panel may lose participation, but must clearly show
Reconnect and must supply unavailable context until a fresh explicit reconnect succeeds.
The original pending result, cached state and remembered association cannot restore authority.

For a remount, request reconnect explicitly in its own chat. The shipped skill runs a
fresh canonical installed launcher and the normal trusted claim/display/readiness flow,
with new authority and ordinary protected recovery. Verify recovered accepted work and
truthful Save Sync, then a real prompt with current evidence. Verify the peer chat's
context remains isolated. Remembered reconnect hints are advisory, bounded and do not
reserve ownership or retain Interaction Holds. The initial daemon-local hint expires
after 24 hours and does not survive service restart; then explicitly name the PDF again.
Never claim this safe reconnect passed uninterrupted hidden renewal. Record the original
renewal check honestly, including any failure, and add the separately timestamped
`hidden-explicit-reconnect`, `chat-switch-explicit-reconnect` or
`expand-restore-explicit-reconnect` check as applicable. Its evidence must describe
unavailable context, ended old participation, explicit same-chat request, fresh
trusted launch/display, recovered work and current prompt evidence. The verifier
accepts that actual-host recovery check as the scoped lifecycle alternative; it
does not alter the original observation.

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
currentness or a truthful lifecycle with either continued renewal or safe explicit fresh reconnect fails or leaves the gate unproved. Preserve
the evidence and stop U4-dependent work.

## Opt-in owning-shell qualification controls

`native-qualification-controls.json` in the existing private application-support
root is separate from the observation-only `native-qualification.json`. An absent
or invalid controls descriptor leaves normal transport/admission behavior unchanged.
Do not activate controls merely by enabling `observe:true`.

The closed descriptor has `version:1`, a 32-character lowercase hex `actionId`,
`action` (`request-teardown` or `bridge-close`), ISO `createdAt`/`expiresAt` with a
maximum 30-minute lifetime, `budget:1`, and a closed `target` containing only
`runId`, `processNonce`, `invocationNonce`, `runtimeId`, and `attemptId`. Use exact
identifiers from the already observed own display invocation; these are correlation,
never identity or authority. It contains no task identity, capability, path, PID,
command, or private protocol envelope. The file must be owner-only 0600, regular,
not a symlink and have one link. Consumption uses an exclusive owner-only tombstone
in a checked 0700 controls directory, permanently limiting the run to one grant.
Do not remove that tombstone to retry a run; uncertain consumption fails closed.

After arming, the owning server's next successful ordinary authenticated app
response may carry one separate sanitized private controls grant. The cached shell
checks its actual invocation, closed metadata, expiry and one-action budget before
showing a qualification button. Arming alone never closes anything. An explicit
click calls the public pinned SDK `App.requestTeardown()` or `App.close()` on that
shell's own App instance. Teardown notification completion is recorded as
`requested`; it does not establish host acceptance. Existing actual host teardown
still uses the normal authenticated detach path. Bridge close stops local timers,
clears materialization and current review UI, and closes only the own app bridge;
it deliberately does not detach first. Measure ordinary service lease expiry and
peer preservation. This is not MCP stdio EOF. Local observations contain only
sanitized action, selector, timestamp and outcome; SDK exception text is discarded.

The v1 descriptor rejects timing and public-result experiments. Those use the
separate closed `native-qualification-experiments.json` contract below. These
controls enable observations; they cannot satisfy an actual-host gate without
independently reviewed installed-host evidence.

## Original-shell authenticated old-attempt probe

`native-qualification-old-attempt.json` is a separate closed opt-in descriptor,
with `version:1`, `actionId`, `action:retire-own-attempt-then-probe-once`, canonical
`createdAt`/`expiresAt` (at most 30 minutes), `budget:1` and the same exact closed
five-field `target` above. The application-support root and consume directory
must be checked owner-only 0700; the descriptor must be owner-only 0600, regular,
single-link, not a symlink and at most 2048 bytes. It shares the permanent
`native-qualification-controls/<runId>.consumed` tombstone with v1 close controls
and public experiments: one logical action per run across all contracts.
Observation alone never enables it. No paths, task identities, commands or
capabilities are accepted in the descriptor.

Only a genuine successful owning pending `ready`/`status` activation or
presentation-authority `renew` may deliver the sanitized private
`placekeeper/qualification-old-attempt` grant. The shell checks its own active
runtime/attempt and observed run/invocation before exposing the first button.
Arming never executes anything. An explicit **retire this own attempt** click
snapshots only its own presentation identity/capability in a private in-memory
controller, invalidates the ordinary incarnation, stops renew/poll and clears
materialized document/UI before one normal authenticated own detach. The
original SDK App bridge stays open. An uncertain, denied or failed detach wipes
the snapshot with no retry. A successful ordinary detach exposes the second
explicit button; it never launches or admits a successor automatically.

Before clicking **probe old attempt once after verified successor**, the operator
must verify a real fresh same-chat successor through the ordinary installed
launch, trusted hook, display and readiness flow, including current evidence,
accepted work and Save Sync. That second click uses the original own
`App.callServerTool` channel to send at most one old `renew`, then one old
`detach`, with fresh request IDs and only the original authority. Both must be
denied; any unexpected success is recorded honestly and cannot be counted as a
pass. No successor authority, document/resource/mutation call or bridge surrogate
is involved. Verify the real successor still renews and supplies current prompt
context, with the peer unchanged.

Authority is retained for at most 120 seconds from retirement, bounded by grant
expiry, with expiry checked before each call. Requests use the pinned SDK's
AbortSignal and five-second maximum timeout, also enforced by a local deadline.
Cancellation, timeout, completion, teardown and actual SDK `onclose`/`onerror`
wipe it. A new tool-result delivery to the retired shell also wipes it as
unsupported, without accepting or parsing successor authority. The ordinary
pending capability is released at retirement. Old ordinary or probe replies cannot resurrect timers, UI or controller
state. Sanitized controller diagnostics contain selectors, phases, method/result,
denial category and timestamps only; private envelopes never enter DOM,
sessionStorage, files, caller diagnostics, model output or error messages.

This trial requires the host to preserve the original shell and its App bridge
while the real successor appears. Perform one bounded survival attempt. A
teardown/disconnect reports unsupported; a vanished/remounted shell cannot report
its own disappearance, so the operator must record unsupported externally and
stop. Never forward its credentials to a new shell or service harness. Record
exact installed artifact/served-shell byte provenance and actual Codex build
independently; this source chunk adds no embedded build fingerprint. Unit mock
coverage proves implementation safety only, and public receipt replay does not
prove authenticated old-attempt denial. The U3 verifier remains unchanged.

## Bounded public-result experiments

The separate experiment descriptor has `version:1`, `actionId` (32 lowercase hex
characters), `createdAt`/`expiresAt` (canonical ISO timestamps, at most 30 minutes),
and `budget:1`. It accepts exactly one of these actions and no extra fields:

- `genuine-attestation-delay`: `target:{runId,processNonce}`, `delayMs` from 1 to
  1000. Selects the next actual successful display from that exact observed server
  process and observation run. The server records its genuine closed receipt;
  the actual hook matches that receipt after trusted event parsing, consumes one
  scheduling slot, waits the fixed delay, then sends the unchanged ordinary
  attestation request with the genuine event's task identity. It never waits for
  readiness. Delay is disabled unless measured Node process startup/elapsed plus delay plus
  the existing 5-second service budget leaves at least 1 second within the
  existing 8-second delay eligibility bound. Node elapsed time excludes host
  queue/shell overhead before Node starts; actual installed timing must establish
  that the reserved margin covers this overhead. Hook-control failures always fall
  through to ordinary attestation. The experiment itself does not alter hook
  configuration; it uses the candidate default's async display hook. Its maximum
  1000 ms delay and existing timing checks remain unchanged.
- `genuine-attestation-after-readiness`: `target:{runId,processNonce}`, `waitMs`
  from 1 to 40000. Selects one genuine public receipt and keeps the original
  async hook alive until an exact daemon marker or a bounded incomplete outcome.
  The daemon writes public issuance expiry before returning display in at most
  64 immutable slots per action/run, and stops issuance after run reservation or
  shared controls consumption. Unrelated preselection displays can exhaust this
  finite budget; missing, exhausted or uncertain slots disable scheduling and
  ordinary display/attestation continue. With no valid new descriptor it writes
  no expiry slots. The hook scans at most 64 slots once, then reads only its exact
  chosen slot during waiting. The daemon writes
  the scheduling marker only after authenticated pending capability, current
  generation and native claim validation, while ready and still unattested.
  The marker never grants authority. The hook polls only exact owner-only files
  at up to 250 ms intervals, freezes monotonic selection and lifetime caps,
  reserves the ordinary five-second control call plus five seconds margin, and
  always proceeds to its unchanged normal attestation. Descriptor cancellation,
  hostile state, aged launches or exhausted budgets finish as incomplete.
  Shared run tombstones and exclusive hook consumption prevent reuse; immutable
  `hook-terminal.json` reports scheduling only. A `ready` terminal is not U3 PASS:
  qualification requires actual daemon ready-first evidence, accepted ordinary
  attestation by this same genuine hook and normal status promotion. Verify the
  real host honors the 55-second async timeout and mounting remains available.
- `paired-public-result-exchange`: exactly two `targets:{runId,processNonce}` in
  the same run with distinct processes, and `rendezvousMs` from 1 to 5000. Each
  process selects one next actual successful display. Only their closed public
  receipts are exchanged; private pending and qualification metadata remain in
  each original invocation. The two real chats must have independent normal
  launch claims and overlapping genuine displays. Process selection is scheduling
  correlation, never task identity. Verify the actual issued invocation/task-hash
  correlation afterward; unexpected or concurrent selection invalidates evidence.
- `old-public-result-on-fresh-display`: one exact `target:{runId,processNonce}`
  and explicit `source:{runId,invocationNonce}` referring to a locally recorded
  genuinely issued public receipt. A fresh normal display keeps its own private
  metadata and returns only that old closed receipt. The source registry contains
  public correlations and receipts only. Independently establish that the source
  was attested or ended. This tests public-result replay; it cannot establish old
  authenticated renew/detach denial or successor preservation.

All selectors are 32 lowercase hex characters. There are no descriptor-supplied
tasks, capabilities, private envelopes, paths, PIDs, commands, model tools or UI
resources. Files use the existing bounded nonblocking read helper, reject
symlinks, hard links, devices/FIFOs, foreign owners and permissions other than
0600, and live in checked owner-only 0700 directories. Issued public receipt
records are bounded by the existing observer's per-run invocation budget.

Experiment initialization exclusively reserves an immutable run manifest, fixes a
shared same-host `hrtime` deadline before any pair slot, then exclusively consumes
the same permanent run tombstone used by v1 owning-shell controls. Only that
initializer can publish a ready marker. An already-consumed v1 run blocks the
experiment; an experiment prevents later v1 actions even after descriptor
replacement. Never delete manifests, markers or tombstones to retry a run.
Interrupted initialization leaves incomplete evidence and no retry.

For pairs, the total rendezvous budget includes initialization and uses the host
monotonic clock; descriptor wall expiry is a separate additional guard. Each
fixed process slot is exclusive. A single immutable terminal file, exclusively
created and never overwritten/deleted, chooses commit (both genuine receipts)
or abort. A valid abort returns each own normal receipt. A valid commit requires
each surviving process to return the opposite receipt; there is no independent
normal fallback after commit. Existing partial, unreadable or invalid terminal
state produces bounded sanitized unavailable results. A process resuming after
the shared deadline cannot deliver a committed replacement. This is a time budget;
process suspension can delay completion and leaves the experiment incomplete.

Absent/invalid descriptors before consumption preserve ordinary display behavior.
A consumed pair's uncertain state may instead produce the existing sanitized
integration-unavailable error. Files named `delivery-N.json` record server delivery
intent only; they do not prove actual host delivery. A crash, missing peer intent,
ambiguous selection, missing actual hook or late delivery is incomplete evidence,
never a pass. Require both real unchanged hooks, exact result/private-invocation
mismatch rejection by each own shell, denial and nonpromotion in the daemon, and
independent peer/current-context preservation as applicable. Safe denial booleans
record panel existence, restart, already-attested, attempt/generation match and
owner match. Claimed/current state is separate correlated prior evidence, not an
atomic predicate observed at denial; the original short-circuit guard is unchanged.

A valid delay may still fail to establish readiness-before-attestation if actual
host scheduling delays shell readiness. Stop after that bounded trial and leave
the ordering unproved. Unit multiprocess/fixture hook tests prove
implementation safety only. Installed build/configuration/provenance, genuine
hook/readiness ordering, two distinct real tasks, actual receipt routing, old
receipt status, current prompts, private-shell behavior and old authenticated
attempt denial remain actual-host prerequisites. The verifier and U4 gate are
unchanged. The private retire/probe controller is outside this implementation.
