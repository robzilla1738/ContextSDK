import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const spawnCalls: Array<{ command: string; args: string[] }> = [];

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill(): void };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => undefined;
      queueMicrotask(() => child.emit("close", 0));
      return child;
    },
  };
});

const { SSHAdapter } = await import("../src/ssh-adapter.js");

describe("SSHAdapter", () => {
  it("builds ssh command arguments with non-interactive connection options", () => {
    const adapter = new SSHAdapter({ host: "vm.example.com", user: "agent", port: 2222, identityFile: "~/.ssh/id_ed25519" });
    expect(adapter.commandForTest("mount")).toEqual([
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-p",
      "2222",
      "-i",
      "~/.ssh/id_ed25519",
      "agent@vm.example.com",
      "mount",
    ]);
  });

  it("attaches via the unprivileged directory-bundle path", () => {
    const adapter = new SSHAdapter({ host: "vm.example.com" });
    expect(adapter.capabilities).toMatchObject({ directoryBundle: true, loopExt4: false });
    expect(adapter.provider).toBe("ssh");
  });

  it("always wraps remote commands in bash and uses sudo for cross-user runs", async () => {
    const adapter = new SSHAdapter({ host: "vm.example.com", user: "agent" });
    spawnCalls.length = 0;

    // Core scripts start with `set -Eeuo pipefail`, which dash rejects; the remote
    // command must therefore run under bash regardless of the login shell.
    await adapter.run("set -Eeuo pipefail\necho hi", { user: "root" });
    const sudoCommand = spawnCalls[0].args.at(-1);
    expect(sudoCommand).toMatch(/^sudo -n -u 'root' bash -lc /);

    await adapter.run("echo hi", { user: "agent" });
    const plainCommand = spawnCalls[1].args.at(-1);
    expect(plainCommand).toMatch(/^bash -lc /);
  });
});
