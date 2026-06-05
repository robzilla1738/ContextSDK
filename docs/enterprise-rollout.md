# Enterprise rollout

The basic idea is simple: keep the sandbox disposable, but stop throwing away the employee's work.

contextSDK gives each agent run a mounted context with `/workspace`, `/memory`, `/artifacts`, `/logs`, `/cache`, and `/config`. When the run ends, the SDK checkpoints the tree, encrypts it, saves it to object storage, releases the lock, and tears down the runtime.

That gives an enterprise agent platform a persistence layer without making the sandbox itself permanent.

The important split is portable context versus runtime state. Portable context is the encrypted bundle that moves between providers. Runtime state is the provider-local machine state: installed packages, language caches, `node_modules`, virtualenvs, and build outputs. Vercel persistent named sandboxes are the first runtime-state implementation; other provider snapshots can plug into the same model later.

## Useful places to start

- Personal memory for employee preferences, project notes, and recurring tasks.
- Project workspaces for tickets, customer work, investigations, or repos.
- Artifacts for reports, screenshots, notebooks, exports, patches, and evidence.
- Regulated workflows where you need to know which agent changed what and when.
- Recovery after a sandbox dies.
- Cross-runtime portability across E2B, Vercel Sandbox, Modal, SSH VMs, and internal VM sandboxes.
- Warm dependency state for Vercel sessions without pushing dependency trees into object storage.

## Reference architecture

1. Context Broker
   - Wraps the SDK behind an enterprise API.
   - Checks policy, quotas, locks, and audit requirements before a run starts.

2. Encrypted storage
   - Uses S3-compatible object storage in production. A local directory store (`FsStorage`) with the same conditional-write semantics covers single-machine dev and proof-of-concept tiers without a bucket.
   - Stores generation-scoped bundle objects under `contexts/<id>/tree/<generation>-<attempt>.tree.tar.zst.enc` (and `contexts/<id>/image/...` for explicit ext4 contexts), plus `manifest.json`, `lock.json`, checkpoint bundles, and audit records. The manifest write is the single atomic commit point; an interrupted save can never strand a manifest pointing at ciphertext it cannot decrypt. Superseded objects are garbage-collected after commit; legacy fixed `current.*` keys are read transparently and migrate on next save.
   - Stores user and agent context, not dependency caches or full machine state.

3. Runtime provisioners
   - E2B, Vercel Sandbox, and Modal are the first adapters.
   - Internal Firecracker, EC2, Kubernetes VM sandboxes, and SSH VMs can use the same runtime interface.
   - Provider persistence or snapshots keep heavy runtime state warm when the provider supports it.
   - Adapters default sandbox lifetimes to session-sized timeouts (E2B 30 min, Vercel 45 min, Modal 60 min) instead of the providers' ~5-minute defaults; E2B and Vercel extend the countdown while a session is actively running via the lock-renewal heartbeat.

4. Policy engine
   - Maps employee identity, department, role, project, data class, runtime, and tool permissions to allowed actions.

5. Agent filesystem API
   - Gives the agent stable folders.
   - Writes version metadata under `/.contextsdk/`.

6. Admin operations
   - Inventory, active locks, usage, versions, restore, freeze, export, legal hold, deletion, and SIEM export.

## Rollout path

Phase 1: run an internal pilot.

Use one agent product, one runtime provider, and one shared storage backend. A single-machine pilot can run against the local `FsStorage` directory; for multi-machine use point every node at one S3-compatible bucket so the conditional-write lock protocol holds across hosts. Start with personal employee contexts. Require encryption, one active writer, audit events, quotas, and short-lived provider credentials. If the pilot uses Vercel, enable persistent named sandboxes so package installs stay provider-local.

Phase 2: add shared contexts.

Add project, ticket, customer, or team contexts. Add a context picker in the chat UI. Let admins browse versions and restore an older generation.

Phase 3: add enterprise controls.

Run DLP before save. Scan artifacts. Add retention, legal hold, KMS-backed keys, admin freeze/export/delete, and SIEM export.

Phase 4: add more runtimes.

Keep the storage contract stable while adding internal VM providers. Runtime snapshots are useful, but they should remain accelerators. The encrypted context bundle is the portable record.

## Security model

Treat context as sensitive application data.

Minimum controls:

- Encrypt context bundles at rest and in transit.
- Use short-lived runtime credentials.
- Enforce exclusive writer locks. The single-writer lock uses conditional writes (`If-None-Match` create, ETag `If-Match` for expired-lock takeover) with TTL/3 renewal; saves re-assert lock ownership and commit the manifest with compare-and-swap, so a concurrent writer or lock takeover aborts the save loudly rather than clobbering the other writer's data.
- Restrict file APIs to managed folders.
- Record audit events.
- Scan before save when policy requires it.
- Avoid text APIs for raw image or bundle transfer.
- Keep dependency caches out of the portable bundle unless policy explicitly opts them in.
- Apply retention, legal hold, and deletion policies.

Useful references:

- [NIST SP 800-207 Zero Trust Architecture](https://csrc.nist.gov/pubs/sp/800/207/final)
- [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework)
- [CISA Artificial Intelligence guidance](https://www.cisa.gov/ai)
- [OWASP Top 10 for LLM Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications)

## Positioning

This is not chatbot memory. It is operating context for AI work: files, notes, artifacts, logs, and version history that follow the agent across disposable compute.

The pitch I would use internally:

Keep the sandbox temporary. Keep the work. Let provider snapshots handle the machine.

## Current Package Status

Published on npm (install verified 2026-06-05):

- `@contextsdk/core@0.2.0`
- `@contextsdk/adapter-e2b@0.2.0`
- `@contextsdk/adapter-vercel@0.2.0`
- `@contextsdk/adapter-modal@0.2.0`
- `@contextsdk/cli@0.2.0`

The repository tracks `0.3.0` (unreleased). It adds the generation-keyed save commit protocol with manifest compare-and-swap, GCM tag/nonce pinning, the local `FsStorage` default so the CLI runs with zero cloud configuration, e2b SDK v2, session-sized sandbox lifetimes with `keepAlive()` and a 15-minute remote-command timeout, runtime-side archive validation with decompression-bomb caps, Vercel headless auth pass-through, an SSH adapter overhaul, and adapters declaring core as a peer dependency. One CLI breaking change: `contextsdk run` now prints the wrapped command's stdout/stderr and exits with its exit code (`--json` restores the envelope). See `CHANGELOG.md` for the full list.

The 0.2.0 release hardens lock acquisition with conditional writes, adds lock renewal and save-time ownership checks, records scrypt parameters in encryption metadata, and validates symlink and special-file entries in bundles.
