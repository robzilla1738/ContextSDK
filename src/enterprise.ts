import { randomUUID } from "node:crypto";
import {
  createContext,
  endContextSession,
  readManifest,
  runWithContext,
  saveContextSession,
  startContextSession,
  statusContext,
} from "./context.js";
import { ContextSDKError } from "./errors.js";
import { parseSize } from "./local-image.js";
import type { RuntimeAdapter } from "./runtime.js";
import type { StorageAdapter } from "./storage.js";
import type {
  ContextManifest,
  ContextSession,
  EncryptionConfig,
  RuntimeProvisioner,
  RunWithContextOptions,
} from "./types.js";

export type EnterpriseAction =
  | "context.create"
  | "context.read"
  | "context.run"
  | "context.start"
  | "context.save"
  | "context.end"
  | "context.admin";

export type ContextScopeType = "personal" | "project" | "ticket" | "customer";
export type DataClassification = "public" | "internal" | "confidential" | "restricted";
export type AuditOutcome = "allow" | "deny" | "success" | "failure";

export interface EnterpriseActor {
  id: string;
  tenantId: string;
  email?: string;
  department?: string;
  roles: string[];
  disabled?: boolean;
}

export interface EnterpriseContextScope {
  type: ContextScopeType;
  ownerId?: string;
  projectId?: string;
  ticketId?: string;
  customerId?: string;
  teamId?: string;
}

export interface EnterpriseContextRequest {
  actor: EnterpriseActor;
  contextId: string;
  action: EnterpriseAction;
  scope: EnterpriseContextScope;
  classification: DataClassification;
  runtime?: string;
  requestedSizeBytes?: number;
  toolPermissions?: string[];
  metadata?: Record<string, unknown>;
}

export interface PolicyDecision {
  allow: boolean;
  reason: string;
  requiredControls?: string[];
}

export interface PolicyEngine {
  authorize(request: EnterpriseContextRequest): Promise<PolicyDecision>;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  tenantId: string;
  actorId: string;
  contextId: string;
  action: EnterpriseAction;
  outcome: AuditOutcome;
  reason?: string;
  runtime?: string;
  classification: DataClassification;
  scope: EnterpriseContextScope;
  metadata?: Record<string, unknown>;
}

export interface AuditSink {
  write(event: AuditEvent): Promise<void>;
}

export interface QuotaDecision {
  allow: boolean;
  reason: string;
}

export interface QuotaManager {
  check(request: EnterpriseContextRequest): Promise<QuotaDecision>;
}

export interface EnterpriseBrokerOptions {
  storage: StorageAdapter;
  encryption: EncryptionConfig;
  policy?: PolicyEngine;
  audit?: AuditSink;
  quota?: QuotaManager;
  provisioners?: Record<string, RuntimeProvisioner>;
}

export interface EnterpriseCreateOptions {
  actor: EnterpriseActor;
  contextId: string;
  scope?: EnterpriseContextScope;
  classification?: DataClassification;
  size: string | number;
  requestedSizeBytes?: number;
  force?: boolean;
}

export interface EnterpriseRunOptions {
  actor: EnterpriseActor;
  contextId: string;
  runtime: string;
  scope?: EnterpriseContextScope;
  classification?: DataClassification;
  createIfMissing?: boolean;
  size?: string | number;
  message?: string;
  saveOnError?: boolean;
  toolPermissions?: string[];
}

export interface EnterpriseManualSessionOptions extends EnterpriseRunOptions {
  runtimeAdapter?: RuntimeAdapter;
}

export class EnterpriseContextBroker {
  private readonly policy: PolicyEngine;
  private readonly audit: AuditSink;
  private readonly quota: QuotaManager;

  constructor(private readonly options: EnterpriseBrokerOptions) {
    this.policy = options.policy ?? new DefaultEnterprisePolicy();
    this.audit = options.audit ?? new NoopAuditSink();
    this.quota = options.quota ?? new NoopQuotaManager();
  }

  async create(options: EnterpriseCreateOptions): Promise<ContextManifest> {
    const request = this.request("context.create", {
      ...options,
      requestedSizeBytes: options.requestedSizeBytes ?? await parseSize(options.size),
    });
    await this.enforce(request);
    try {
      const manifest = await createContext({
        id: options.contextId,
        size: options.size,
        storage: this.options.storage,
        encryption: this.options.encryption,
        force: options.force,
      });
      await this.record(request, "success", "context created", { generation: manifest.generation });
      return manifest;
    } catch (error) {
      await this.record(request, "failure", errorMessage(error));
      throw error;
    }
  }

  async run<T>(options: EnterpriseRunOptions, fn: (session: ContextSession) => Promise<T>): Promise<T> {
    const request = this.request("context.run", {
      ...options,
      requestedSizeBytes: options.createIfMissing ? await parseSize(options.size ?? "256M") : undefined,
    });
    await this.enforce(request);
    try {
      const provisioner = this.options.provisioners?.[options.runtime];
      if (!provisioner) {
        throw new ContextSDKError(`no provisioner registered for runtime: ${options.runtime}`);
      }
      const result = await runWithContext({
        id: options.contextId,
        storage: this.options.storage,
        encryption: this.options.encryption,
        provisioner,
        createIfMissing: options.createIfMissing,
        size: options.size,
        saveOnError: options.saveOnError,
        author: options.actor.id,
        message: options.message ?? `${options.actor.id} agent session`,
      } satisfies RunWithContextOptions, fn);
      await this.record(request, "success", "context run completed");
      return result;
    } catch (error) {
      await this.record(request, "failure", errorMessage(error));
      throw error;
    }
  }

  async startSession(options: EnterpriseManualSessionOptions): Promise<ContextSession> {
    const request = this.request("context.start", {
      ...options,
      requestedSizeBytes: options.createIfMissing ? await parseSize(options.size ?? "256M") : undefined,
    });
    await this.enforce(request);
    try {
      const runtime = options.runtimeAdapter ?? await this.runtimeFor(options.runtime);
      const session = await startContextSession({
        id: options.contextId,
        storage: this.options.storage,
        encryption: this.options.encryption,
        runtime,
        createIfMissing: options.createIfMissing,
        size: options.size,
      });
      await this.record(request, "success", "context session started", { runtimeId: runtime.id });
      return session;
    } catch (error) {
      await this.record(request, "failure", errorMessage(error));
      throw error;
    }
  }

  async saveSession(options: {
    actor: EnterpriseActor;
    session: ContextSession;
    scope?: EnterpriseContextScope;
    classification?: DataClassification;
    message?: string;
  }): Promise<ContextManifest> {
    const request = this.request("context.save", {
      actor: options.actor,
      contextId: options.session.id,
      scope: options.scope,
      classification: options.classification,
      runtime: options.session.runtimeId,
    });
    await this.enforce(request);
    try {
      const manifest = await saveContextSession(options.session, {
        storage: this.options.storage,
        encryption: this.options.encryption,
        author: options.actor.id,
        message: options.message ?? `${options.actor.id} checkpoint`,
      });
      await this.record(request, "success", "context session saved", { generation: manifest.generation });
      return manifest;
    } catch (error) {
      await this.record(request, "failure", errorMessage(error));
      throw error;
    }
  }

  async endSession(options: {
    actor: EnterpriseActor;
    session: ContextSession;
    scope?: EnterpriseContextScope;
    classification?: DataClassification;
    forceUnlock?: boolean;
  }): Promise<void> {
    const request = this.request("context.end", {
      actor: options.actor,
      contextId: options.session.id,
      scope: options.scope,
      classification: options.classification,
      runtime: options.session.runtimeId,
    });
    await this.enforce(request);
    try {
      await endContextSession(options.session, {
        storage: this.options.storage,
        forceUnlock: options.forceUnlock,
      });
      await this.record(request, "success", "context session ended");
    } catch (error) {
      await this.record(request, "failure", errorMessage(error));
      throw error;
    }
  }

  async status(actor: EnterpriseActor, contextId: string, scope?: EnterpriseContextScope, classification?: DataClassification): Promise<unknown> {
    const request = this.request("context.read", { actor, contextId, scope, classification });
    await this.enforce(request);
    return statusContext({ id: contextId, storage: this.options.storage });
  }

  async manifest(actor: EnterpriseActor, contextId: string, scope?: EnterpriseContextScope, classification?: DataClassification): Promise<ContextManifest> {
    const request = this.request("context.read", { actor, contextId, scope, classification });
    await this.enforce(request);
    return readManifest(this.options.storage, contextId);
  }

  private async runtimeFor(runtime: string): Promise<RuntimeAdapter> {
    const provisioner = this.options.provisioners?.[runtime];
    if (!provisioner) {
      throw new ContextSDKError(`no provisioner registered for runtime: ${runtime}`);
    }
    return provisioner.createSessionRuntime();
  }

  private request(action: EnterpriseAction, options: {
    actor: EnterpriseActor;
    contextId: string;
    scope?: EnterpriseContextScope;
    classification?: DataClassification;
    runtime?: string;
    requestedSizeBytes?: number;
    toolPermissions?: string[];
    metadata?: Record<string, unknown>;
  }): EnterpriseContextRequest {
    return {
      actor: options.actor,
      contextId: options.contextId,
      action,
      scope: options.scope ?? { type: "personal", ownerId: options.actor.id },
      classification: options.classification ?? "internal",
      runtime: options.runtime,
      requestedSizeBytes: options.requestedSizeBytes,
      toolPermissions: options.toolPermissions,
      metadata: options.metadata,
    };
  }

  private async enforce(request: EnterpriseContextRequest): Promise<void> {
    let policy: PolicyDecision;
    try {
      policy = await this.policy.authorize(request);
    } catch (error) {
      await this.record(request, "failure", `policy engine error: ${errorMessage(error)}`);
      throw error;
    }
    if (!policy.allow) {
      await this.record(request, "deny", policy.reason);
      throw new ContextSDKError(`policy denied ${request.action}: ${policy.reason}`);
    }
    let quota: QuotaDecision;
    try {
      quota = await this.quota.check(request);
    } catch (error) {
      await this.record(request, "failure", `quota manager error: ${errorMessage(error)}`);
      throw error;
    }
    if (!quota.allow) {
      await this.record(request, "deny", quota.reason);
      throw new ContextSDKError(`quota denied ${request.action}: ${quota.reason}`);
    }
    await this.record(request, "allow", policy.reason, { requiredControls: policy.requiredControls });
  }

  private async record(request: EnterpriseContextRequest, outcome: AuditOutcome, reason?: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.audit.write({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      tenantId: request.actor.tenantId,
      actorId: request.actor.id,
      contextId: request.contextId,
      action: request.action,
      outcome,
      reason,
      runtime: request.runtime,
      classification: request.classification,
      scope: request.scope,
      metadata: { ...request.metadata, ...metadata },
    });
  }
}

export class DefaultEnterprisePolicy implements PolicyEngine {
  async authorize(request: EnterpriseContextRequest): Promise<PolicyDecision> {
    if (request.actor.disabled) {
      return { allow: false, reason: "actor is disabled" };
    }
    if (!request.actor.tenantId) {
      return { allow: false, reason: "actor tenant is required" };
    }
    if (request.scope.type === "personal" && request.scope.ownerId && request.scope.ownerId !== request.actor.id && !hasRole(request.actor, "admin")) {
      return { allow: false, reason: "actor cannot access another user's personal context" };
    }
    if (request.classification === "restricted" && !hasRole(request.actor, "restricted-context")) {
      return { allow: false, reason: "restricted contexts require restricted-context role" };
    }
    if (request.action === "context.admin" && !hasRole(request.actor, "admin")) {
      return { allow: false, reason: "admin role required" };
    }
    return {
      allow: true,
      reason: "allowed by default enterprise policy",
      requiredControls: [
        "encryption-at-rest",
        "exclusive-lock",
        "audit-event",
        "short-lived-runtime-credentials",
      ],
    };
  }
}

export class StaticQuotaManager implements QuotaManager {
  constructor(private readonly options: { maxContextSizeBytes?: number; allowedRuntimes?: string[] } = {}) {}

  async check(request: EnterpriseContextRequest): Promise<QuotaDecision> {
    if (this.options.maxContextSizeBytes && request.requestedSizeBytes && request.requestedSizeBytes > this.options.maxContextSizeBytes) {
      return { allow: false, reason: `requested context size exceeds ${this.options.maxContextSizeBytes} bytes` };
    }
    if (this.options.allowedRuntimes && request.runtime && !this.options.allowedRuntimes.includes(request.runtime)) {
      return { allow: false, reason: `runtime is not allowed: ${request.runtime}` };
    }
    return { allow: true, reason: "quota available" };
  }
}

export class InMemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];

  async write(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

export class StorageAuditSink implements AuditSink {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly prefix = "audit",
  ) {}

  async write(event: AuditEvent): Promise<void> {
    const safeTimestamp = event.timestamp.replace(/[:.]/g, "-");
    const key = `${this.prefix}/tenants/${sanitizeKeyPart(event.tenantId)}/contexts/${sanitizeKeyPart(event.contextId)}/${safeTimestamp}-${sanitizeKeyPart(event.id)}.json`;
    await this.storage.putObject(key, JSON.stringify(event, null, 2));
  }
}

export class NoopAuditSink implements AuditSink {
  async write(): Promise<void> {}
}

export class NoopQuotaManager implements QuotaManager {
  async check(): Promise<QuotaDecision> {
    return { allow: true, reason: "quota checks disabled" };
  }
}

function hasRole(actor: EnterpriseActor, role: string): boolean {
  return actor.roles.includes(role);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeKeyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-");
}
