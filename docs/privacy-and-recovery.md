# Privacy and recovery

The service binds to `127.0.0.1`, uses scoped launch capabilities, and keeps PDF bytes, drafts, exports, SyncTeX hints, and Codex handoff artifacts on this Mac. No adapter uploads documents, forwards a port, or requests network access. The Codex handoff lists exactly which local artifacts an external task may receive; read containment is enforced by that task's Codex sandbox, not audited by PDF Proofreader.

Recoverable snapshots live under `~/Library/Application Support/PDF Proofreader`. Mutable data never belongs inside the signed app bundle. **Finish** and **Discard** revoke the live session and remove app recovery state synchronously. They cannot erase copies already captured by APFS snapshots, Time Machine, cloud backup, or user-created exports. Removing the app does not remove recovery data; remove that directory separately only after confirming no draft is needed.

Default Save creates a collision-safe `*-reviewed.pdf` and leaves the source unchanged. Codex delivery creates a reviewed PDF, handoff JSON, result directory, disposition JSON, and—after a successful clean rebuild—a distinct revised PDF. Failed export retains the acknowledged draft. Replace Original is a separate explicit action and fails closed on drift, signatures, encryption, permissions, or filesystem identity changes.
