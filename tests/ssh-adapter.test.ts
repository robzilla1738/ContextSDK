import { describe, expect, it } from "vitest";
import { SSHAdapter } from "../src/ssh-adapter.js";

describe("SSHAdapter", () => {
  it("builds ssh command arguments", () => {
    const adapter = new SSHAdapter({ host: "vm.example.com", user: "agent", port: 2222, identityFile: "~/.ssh/id_ed25519" });
    expect(adapter.commandForTest("mount")).toEqual([
      "ssh",
      "-p",
      "2222",
      "-i",
      "~/.ssh/id_ed25519",
      "agent@vm.example.com",
      "mount",
    ]);
  });
});
