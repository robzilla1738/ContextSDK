# Enterprise rollout

The basic idea is simple: keep the sandbox disposable, but stop throwing away the employee's working state.

contextSDK gives each agent run a mounted context with `/workspace`, `/memory`, `/artifacts`, `/logs`, `/cache`, and `/config`. When the run ends, the SDK checkpoints the tree, encrypts it, saves it to object storage, releases the lock, and tears down the runtime.

That gives an enterprise agent platform a persistence layer without making the sandbox itself permanent.

## Useful places to start

- Personal memory for employee preferences, project notes, and recurring tasks.
- Project workspaces for tickets, customer work, investigations, or repos.
- Artifacts for reports, screenshots, notebooks, exports, patches, and evidence.
- Regulated workflows where you need to know which agent changed what and when.
- Recovery after a sandbox dies.
- Cross-runtime portability across E2B, Vercel Sandbox, Modal, SSH VMs, and internal VM sandboxes.

## Reference architecture

1. Context Broker
   - Wraps the SDK behind an enterprise API.
   - Checks policy, quotas, locks, and audit requirements before a run starts.

2. Encrypted storage
   - Uses S3-compatible object storage.
   - Stores `current.tree.tar.zst.enc`, optional `current.img.enc`, `manifest.json`, `lock.json`, checkpoint bundles, and audit records.

3. Runtime provisioners
   - E2B, Vercel Sandbox, and Modal are the first adapters.
   - Internal Firecracker, EC2, Kubernetes VM sandboxes, and SSH VMs can use the same runtime interface.

4. Policy engine
   - Maps employee identity, department, role, project, data class, runtime, and tool permissions to allowed actions.

5. Agent filesystem API
   - Gives the agent stable folders.
   - Writes version metadata under `/.contextsdk/`.

6. Admin operations
   - Inventory, active locks, usage, versions, restore, freeze, export, legal hold, deletion, and SIEM export.

## Rollout path

Phase 1: run an internal pilot.

Use one agent product, one runtime provider, and one storage bucket. Start with personal employee contexts. Require encryption, one active writer, audit events, quotas, and short-lived provider credentials.

Phase 2: add shared contexts.

Add project, ticket, customer, or team contexts. Add a context picker in the chat UI. Let admins browse versions and restore an older generation.

Phase 3: add enterprise controls.

Run DLP before save. Scan artifacts. Add retention, legal hold, KMS-backed keys, admin freeze/export/delete, and SIEM export.

Phase 4: add more runtimes.

Keep the storage contract stable while adding internal VM providers. The runtime should be replaceable compute, not the persistence layer.

## Security model

Treat context as sensitive application data.

Minimum controls:

- Encrypt context bundles at rest and in transit.
- Use short-lived runtime credentials.
- Enforce exclusive writer locks.
- Restrict file APIs to managed folders.
- Record audit events.
- Scan before save when policy requires it.
- Avoid text APIs for raw image or bundle transfer.
- Apply retention, legal hold, and deletion policies.

Useful references:

- [NIST SP 800-207 Zero Trust Architecture](https://csrc.nist.gov/pubs/sp/800/207/final)
- [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework)
- [CISA Artificial Intelligence guidance](https://www.cisa.gov/ai)
- [OWASP Top 10 for LLM Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications)

## Positioning

This is not chatbot memory. It is operating context for AI work: files, notes, artifacts, logs, and version history that follow the agent across disposable compute.

The pitch I would use internally:

Keep the sandbox temporary. Keep the work.
