export class ContextSDKError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextSDKError";
  }
}

export class ContextLockError extends ContextSDKError {
  constructor(message: string) {
    super(message);
    this.name = "ContextLockError";
  }
}

export class RuntimeCapabilityError extends ContextSDKError {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeCapabilityError";
  }
}

export class ObjectNotFoundError extends ContextSDKError {
  constructor(key: string) {
    super(`object not found: ${key}`);
    this.name = "ObjectNotFoundError";
  }
}

export class StorageConditionError extends ContextSDKError {
  constructor(message: string) {
    super(message);
    this.name = "StorageConditionError";
  }
}

export class RuntimeCommandError extends ContextSDKError {
  readonly label: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(label: string, result: { exitCode: number; stdout: string; stderr: string }) {
    super(`${label} failed with exit code ${result.exitCode}\n${result.stdout}\n${result.stderr}`.trim());
    this.name = "RuntimeCommandError";
    this.label = label;
    this.exitCode = result.exitCode;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}
