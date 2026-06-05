import { E2BAdapter, type E2BAdapterOptions } from "./e2b-adapter.js";
import type { RuntimeAdapter, RuntimeProvisioner } from "@contextsdk/core";

export class E2BProvisioner implements RuntimeProvisioner {
  private readonly options: E2BAdapterOptions;

  constructor(options: E2BAdapterOptions = {}) {
    this.options = options;
  }

  async createSessionRuntime(options: E2BAdapterOptions = {}): Promise<RuntimeAdapter> {
    return E2BAdapter.create({ ...this.options, ...options });
  }

  async destroyRuntime(runtime: RuntimeAdapter): Promise<void> {
    await runtime.dispose?.();
  }
}
