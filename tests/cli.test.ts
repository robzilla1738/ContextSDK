import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { firstNumber, parseDurationMs, program } from "../packages/cli/src/cli.js";

describe("cli", () => {
  it("reports the version from package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../packages/cli/package.json", import.meta.url), "utf8")) as { version: string };
    expect(program.version()).toBe(pkg.version);
  });

  it("registers the documented top-level commands", () => {
    const names = program.commands.map(command => command.name());
    for (const expected of ["doctor", "probe", "run", "provision", "session", "files", "versions", "init", "attach", "save", "detach", "status", "verify", "test"]) {
      expect(names).toContain(expected);
    }
  });

  it("supports stdin input and ownership flags on file and session commands", () => {
    const files = program.commands.find(command => command.name() === "files");
    const write = files?.commands.find(command => command.name() === "write");
    expect(write?.options.some(option => option.long === "--stdin")).toBe(true);

    const session = program.commands.find(command => command.name() === "session");
    for (const sub of ["save", "checkpoint"]) {
      const command = session?.commands.find(candidate => candidate.name() === sub);
      expect(command?.options.some(option => option.long === "--owner"), `session ${sub} --owner`).toBe(true);
    }
  });

  it("parses durations", () => {
    expect(parseDurationMs("250")).toBe(250);
    expect(parseDurationMs("250ms")).toBe(250);
    expect(parseDurationMs("5s")).toBe(5_000);
    expect(parseDurationMs("5m")).toBe(300_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
    expect(parseDurationMs("14d")).toBe(1_209_600_000);
    expect(() => parseDurationMs("nope")).toThrow(/invalid duration/);
  });

  it("picks the first defined numeric value", () => {
    expect(firstNumber(undefined, "", "42", 7)).toBe(42);
    expect(firstNumber(undefined, undefined)).toBeUndefined();
    expect(firstNumber(3, "42")).toBe(3);
  });
});
