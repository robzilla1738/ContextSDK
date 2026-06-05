# Security Policy

contextSDK stores encrypted agent state and moves it across sandbox providers,
so we treat integrity and confidentiality issues as the highest-priority bugs.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.3.x   | yes       |
| < 0.3   | upgrade   |

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/robzilla1738/ContextSDK/security/advisories/new).
Do not open a public issue for anything that could be exploitable.

Include what you can: affected package and version, a reproduction or proof of
concept, and the impact you believe it has. You can expect an acknowledgement
within 72 hours.

## Scope notes

- Portable bundles are encrypted with AES-256-GCM; keys derive from a
  passphrase via scrypt (parameters recorded in metadata) or a raw 32-byte key.
  The manifest (ids, generation counters, encryption metadata, file counts) is
  intentionally not encrypted — do not put secrets in context ids or version
  messages.
- Archive safety (path traversal, link escapes, special files, decompression
  caps) is enforced both on the host and inside the runtime before extraction.
  Bypasses of either layer are in scope.
- The single-writer lock protocol prevents accidental concurrent writes; it is
  not a defense against a malicious actor with write access to the storage
  bucket, who can corrupt or delete objects regardless.
