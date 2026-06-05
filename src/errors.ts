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
