#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { createJiti } from "jiti";
import { E2BAdapter, E2BProvisioner } from "@contextsdk/adapter-e2b";
import { ModalProvisioner, ModalSandboxAdapter } from "@contextsdk/adapter-modal";
import { VercelProvisioner, VercelSandboxAdapter } from "@contextsdk/adapter-vercel";
import {
  attachContext,
  buildSession,
  checkpointContextSession,
  contextKeys,
  createContext,
  defaultFsStorageDirectory,
  defaultMountPath,
  detachContext,
  FsStorage,
  probeRuntime,
  readManifest,
  remoteBundlePath,
  remoteImagePath,
  runWithContext,
  saveContext,
  saveContextSession,
  S3Storage,
  SSHAdapter,
  startContextSession,
  statusContext,
} from "@contextsdk/core";
import type {
  ContextFormat,
  ContextSession,
  EncryptionConfig,
  RuntimeProvisioner,
  ContextSDKConfig,
  StorageAdapter,
} from "@contextsdk/core";
import type { RuntimeAdapter } from "@contextsdk/core";

const cliPackage = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command();

program
  .name("contextsdk")
  .description("Portable encrypted context state for agent sandboxes and VMs")
  .version(cliPackage.version);

program
  .command("doctor")
  .description("check local configuration without printing secrets")
  .action(async () => {
    const config = configFromFile();
    const passphraseEnv = config.encryption?.passphraseEnv ?? "CONTEXTSDK_PASSPHRASE";
    const rawKeyHexEnv = config.encryption?.rawKeyHexEnv ?? "CONTEXTSDK_KEY_HEX";
    printJson({
      ok: true,
      storage: storageDescription(),
      env: {
        encryption: Boolean(process.env[passphraseEnv] || process.env[rawKeyHexEnv]),
        e2b: Boolean(process.env.E2B_API_KEY),
        // Vercel needs the full token/team/project triple for headless auth; an
        // OIDC token from `vercel env pull` also works on its own.
        vercel: Boolean(
          (process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID)
          || process.env.VERCEL_OIDC_TOKEN,
        ),
        modal: Boolean(process.env.MODAL_TOKEN_ID || process.env.MODAL_TOKEN_SECRET || process.env.MODAL_TOKEN || existsSync(resolve(homedir(), ".modal.toml"))),
      },
      defaultRuntime: config.defaultRuntime,
      localTools: {
        tar: hasCommand("tar"),
        zstd: hasCommand("zstd"),
        python3: hasCommand("python3"),
        // Only needed for explicit --format ext4 contexts; tree contexts (the
        // default) never touch ext4 tooling on the host.
        "mkfs.ext4 (ext4 format only)": hasCommand("mkfs.ext4") || hasCommand("mke2fs"),
        "e2fsck (ext4 format only)": hasCommand("e2fsck"),
      },
      packages: [
        "@contextsdk/core",
        "@contextsdk/cli",
        "@contextsdk/adapter-e2b",
        "@contextsdk/adapter-vercel",
        "@contextsdk/adapter-modal",
      ],
    });
  });

addRuntimeOptions(program
  .command("probe")
  .description("probe runtime capabilities and required tools"))
  .action(async (options: RuntimeCliOptions) => {
    const runtime = await runtimeFromOptions(options);
    try {
      printJson({ ok: true, probe: await probeRuntime({ runtime }) });
    } finally {
      await runtime.dispose?.();
    }
  });

addRuntimeOptions(program
  .command("run")
  .description("run a command inside a provisioned context session")
  .argument("<id>", "context id")
  .option("--create-if-missing", "create the context before attach if it does not exist")
  .option("--size <size>", "new context size when --create-if-missing is used", "256M")
  .option("--format <format>", "context format for --create-if-missing: tree or ext4", "tree")
  .option("--message <message>", "version save message", "contextsdk run")
  .option("--checkpoint-interval <duration>", "periodic checkpoint interval, for example 5m or 300000")
  .option("--json", "emit a JSON envelope instead of the command's own stdout/stderr")
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .argument("[command...]", "command to run inside the mounted context"))
  .action(async (id: string, commandParts: string[], options: RuntimeCliOptions & {
    createIfMissing?: boolean;
    size: string;
    format: ContextFormat;
    message: string;
    checkpointInterval?: string;
    json?: boolean;
  }) => {
    const storage = storageFromEnv();
    const encryption = encryptionFromEnv();
    if (options.createIfMissing && !await storage.headObject(contextKeys(id).manifest)) {
      await createContext({ id, size: options.size, format: options.format, storage, encryption, persistencePolicy: configFromFile().persistence });
    }
    // Everything after `--` is the verbatim command. Taking it straight from argv
    // avoids commander consuming a known contextsdk flag (e.g. --json, --message)
    // that legitimately belongs to the wrapped command.
    const separatorIndex = process.argv.indexOf("--");
    const resolvedCommandParts = separatorIndex !== -1 ? process.argv.slice(separatorIndex + 1) : commandParts;
    const command = resolvedCommandParts.length > 0 ? resolvedCommandParts.map(shellQuote).join(" ") : "";
    const provisioner = provisionerFromOptions(options);
    const runtime = provisioner ? undefined : await runtimeFromOptions(options, id);
    const result = await runWithContext({
      id,
      storage,
      encryption,
      provisioner,
      runtime,
      createIfMissing: false,
      message: options.message,
      persistencePolicy: configFromFile().persistence,
      runtimeState: runtimeStateMode(options),
      checkpoint: {
        intervalMs: options.checkpointInterval ? parseDurationMs(options.checkpointInterval) : configFromFile().checkpoint?.intervalMs,
      },
    }, async session => {
      if (!command) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      // The command result is reported, not thrown: throwing would funnel command
      // output into error logs and collapse the real exit code down to 1.
      return session.runtime.run(`cd ${shellQuote(session.mountPath)} && ${command}`, { user: "root" });
    });
    if (options.json) {
      printJson({ ok: result.exitCode === 0, result });
    } else {
      // Behave like the wrapped command: its stdout goes to stdout, its stderr
      // to stderr, and its exit code is this process's exit code.
      if (result.stdout) {
        process.stdout.write(result.stdout);
      }
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }
    }
    if (result.exitCode !== 0) {
      process.exitCode = result.exitCode;
    }
  });

addRuntimeOptions(program
  .command("provision")
  .description("create a runtime without attaching a context"))
  .action(async (options: RuntimeCliOptions) => {
    const runtime = await runtimeFromOptions(options);
    printJson({
      ok: true,
      runtimeId: runtime.id,
      provider: runtime.provider,
      capabilities: runtime.capabilities,
    });
  });

const session = program.command("session").description("manual context session lifecycle");

addRuntimeOptions(session
  .command("start")
  .description("attach a context and print the session descriptor")
  .argument("<id>", "context id")
  .option("--create-if-missing", "create the context before attach if it does not exist")
  .option("--size <size>", "new context size when --create-if-missing is used", "256M")
  .option("--format <format>", "context format for --create-if-missing: tree or ext4", "tree")
  .option("--mount-path <path>", "mount path inside the runtime")
  .option("--force-unlock", "replace an existing active lock"))
  .action(async (id: string, options: RuntimeCliOptions & {
    createIfMissing?: boolean;
    size: string;
    format: ContextFormat;
    mountPath?: string;
    forceUnlock?: boolean;
  }) => {
    const storage = storageFromEnv();
    const encryption = encryptionFromEnv();
    if (options.createIfMissing && !await storage.headObject(contextKeys(id).manifest)) {
      await createContext({ id, size: options.size, format: options.format, storage, encryption, persistencePolicy: configFromFile().persistence });
    }
    const runtime = await runtimeFromOptions(options, id);
    const started = await startContextSession({
      id,
      storage,
      encryption,
      runtime,
      mountPath: options.mountPath,
      forceUnlock: options.forceUnlock,
      createIfMissing: false,
      persistencePolicy: configFromFile().persistence,
    });
    printJson({ ok: true, session: summarizeSession(started) });
  });

addRuntimeOptions(session
  .command("save")
  .description("save the active session as a new context generation")
  .argument("<id>", "context id")
  .option("--message <message>", "version save message", "manual save")
  .option("--author <author>", "version author", "contextsdk")
  .option("--owner <owner>", "lock owner emitted by session start; enables ownership verification before writing")
  .option("--mount-path <path>", "mount path inside the runtime"))
  .action(async (id: string, options: RuntimeCliOptions & { message: string; author: string; owner?: string; mountPath?: string }) => {
    const runtime = await runtimeFromOptions(options, id);
    const active = await mountedFromCli(id, runtime, options);
    const manifest = await saveContextSession(buildSession(runtime, active), {
      storage: storageFromEnv(),
      encryption: encryptionFromEnv(),
      author: options.author,
      message: options.message,
      persistencePolicy: configFromFile().persistence,
      runtimeState: runtimeStateMode(options),
    });
    printJson({ ok: true, manifest });
  });

addRuntimeOptions(session
  .command("end")
  .description("detach the session and release the lock")
  .argument("<id>", "context id")
  .option("--owner <owner>", "lock owner emitted by session start")
  .option("--mount-path <path>", "mount path inside the runtime")
  .option("--force-unlock", "release the lock even if the owner differs"))
  .action(async (id: string, options: RuntimeCliOptions & { owner?: string; mountPath?: string; forceUnlock?: boolean }) => {
    const runtime = await runtimeFromOptions(options, id);
    await detachContext({
      id,
      storage: storageFromEnv(),
      runtime,
      mountPath: options.mountPath,
      owner: options.owner,
      forceUnlock: options.forceUnlock,
    });
    printJson({ ok: true });
  });

addRuntimeOptions(session
  .command("checkpoint")
  .description("write a checkpoint of the active session without ending it")
  .argument("<id>", "context id")
  .option("--reason <reason>", "checkpoint reason", "manual")
  .option("--owner <owner>", "lock owner emitted by session start; enables ownership verification before writing")
  .option("--mount-path <path>", "mount path inside the runtime"))
  .action(async (id: string, options: RuntimeCliOptions & { reason: string; owner?: string; mountPath?: string }) => {
    const runtime = await runtimeFromOptions(options, id);
    const active = await mountedFromCli(id, runtime, options);
    const manifest = await checkpointContextSession(buildSession(runtime, active), {
      storage: storageFromEnv(),
      encryption: encryptionFromEnv(),
      reason: options.reason,
      persistencePolicy: configFromFile().persistence,
    });
    printJson({ ok: true, manifest });
  });

const files = program.command("files").description("manage files inside a mounted context session");

addRuntimeOptions(files
  .command("list")
  .description("list files under a managed context path")
  .argument("<id>", "context id")
  .argument("[path]", "managed path", "workspace")
  .option("--mount-path <path>", "mount path inside the runtime"))
  .action(async (id: string, path: string, options: RuntimeCliOptions & { mountPath?: string }) => {
    const runtime = await runtimeFromOptions(options, id);
    const active = buildSession(runtime, await mountedFromCli(id, runtime, options));
    printJson({ ok: true, files: await active.files.list(path) });
  });

addRuntimeOptions(files
  .command("read")
  .description("write a context file's raw bytes to stdout")
  .argument("<id>", "context id")
  .argument("<path>", "managed path")
  .option("--mount-path <path>", "mount path inside the runtime"))
  .action(async (id: string, path: string, options: RuntimeCliOptions & { mountPath?: string }) => {
    const runtime = await runtimeFromOptions(options, id);
    process.stdout.write(await buildSession(runtime, await mountedFromCli(id, runtime, options)).files.read(path));
  });

addRuntimeOptions(files
  .command("write")
  .description("write data to a managed context path")
  .argument("<id>", "context id")
  .argument("<path>", "managed path")
  .argument("[data]", "text data; omit and pipe input with --stdin for sensitive values")
  .option("--stdin", "read data from standard input so it never appears in shell history or process listings")
  .option("--mount-path <path>", "mount path inside the runtime"))
  .action(async (id: string, path: string, data: string | undefined, options: RuntimeCliOptions & { mountPath?: string; stdin?: boolean }) => {
    const payload = await resolveWriteData(data, options.stdin);
    const runtime = await runtimeFromOptions(options, id);
    await buildSession(runtime, await mountedFromCli(id, runtime, options)).files.write(path, payload);
    printJson({ ok: true });
  });

addRuntimeOptions(files
  .command("remove")
  .description("remove a managed context path")
  .argument("<id>", "context id")
  .argument("<path>", "managed path")
  .option("--mount-path <path>", "mount path inside the runtime"))
  .action(async (id: string, path: string, options: RuntimeCliOptions & { mountPath?: string }) => {
    const runtime = await runtimeFromOptions(options, id);
    await buildSession(runtime, await mountedFromCli(id, runtime, options)).files.remove(path);
    printJson({ ok: true });
  });

const versions = program.command("versions").description("inspect context version metadata");

versions
  .command("list")
  .description("list version history summaries from the manifest")
  .argument("<id>", "context id")
  .action(async (id: string) => {
    const manifest = await readManifest(storageFromEnv(), id);
    printJson({
      ok: true,
      versions: manifest.versions ?? [],
      latestVersion: manifest.latestVersion,
      latestCheckpoint: manifest.latestCheckpoint,
      generation: manifest.generation,
      checkpointGeneration: manifest.checkpointGeneration ?? 0,
    });
  });

program
  .command("init")
  .description("create a new encrypted context in storage")
  .argument("<id>", "context id")
  .option("--size <size>", "raw ext4 image size when --format ext4 is used", "256M")
  .option("--format <format>", "context format: tree or ext4", "tree")
  .option("--force", "overwrite an existing context manifest")
  .action(async (id: string, options: { size: string; format: ContextFormat; force?: boolean }) => {
    const manifest = await createContext({
      id,
      size: options.size,
      format: options.format,
      storage: storageFromEnv(),
      encryption: encryptionFromEnv(),
      persistencePolicy: configFromFile().persistence,
      force: options.force,
    });
    printJson({ ok: true, manifest });
  });

addRuntimeOptions(program
  .command("attach")
  .description("attach a context to a runtime and mount it")
  .argument("<id>", "context id")
  .option("--mount-path <path>", "mount path inside the runtime")
  .option("--force-unlock", "replace an existing active lock"))
  .action(async (id: string, options: RuntimeCliOptions & { mountPath?: string; forceUnlock?: boolean }) => {
    const runtime = await runtimeFromOptions(options, id);
    const mounted = await attachContext({
      id,
      storage: storageFromEnv(),
      encryption: encryptionFromEnv(),
      runtime,
      mountPath: options.mountPath,
      forceUnlock: options.forceUnlock,
    });
    printJson({ ok: true, mounted });
  });

addRuntimeOptions(program
  .command("save")
  .description("pack, encrypt, and persist the mounted context as a new generation")
  .argument("<id>", "context id")
  .option("--mount-path <path>", "mount path inside the runtime"))
  .action(async (id: string, options: RuntimeCliOptions & { mountPath?: string }) => {
    const runtime = await runtimeFromOptions(options, id);
    const manifest = await saveContext({
      id,
      storage: storageFromEnv(),
      encryption: encryptionFromEnv(),
      runtime,
      mountPath: options.mountPath,
      persistencePolicy: configFromFile().persistence,
      runtimeState: runtimeStateMode(options),
    });
    printJson({ ok: true, manifest });
  });

addRuntimeOptions(program
  .command("detach")
  .description("unmount the context and release its lock")
  .argument("<id>", "context id")
  .option("--mount-path <path>", "mount path inside the runtime")
  .option("--owner <owner>", "lock owner emitted by attach")
  .option("--force-unlock", "release the lock even if the owner differs"))
  .action(async (id: string, options: RuntimeCliOptions & { mountPath?: string; owner?: string; forceUnlock?: boolean }) => {
    const runtime = await runtimeFromOptions(options, id);
    await detachContext({
      id,
      storage: storageFromEnv(),
      runtime,
      mountPath: options.mountPath,
      owner: options.owner,
      forceUnlock: options.forceUnlock,
    });
    printJson({ ok: true });
  });

program
  .command("status")
  .description("show the manifest and lock state for a context")
  .argument("<id>", "context id")
  .action(async (id: string) => {
    printJson({ ok: true, ...await statusContext({ id, storage: storageFromEnv() }) });
  });

program
  .command("verify")
  .description("verify that the stored objects referenced by the manifest exist and are encrypted")
  .argument("<id>", "context id")
  .action(async (id: string) => {
    const storage = storageFromEnv();
    const manifest = await readManifest(storage, id);
    const imageHead = await storage.headObject(manifest.imageKey);
    const treeHead = await storage.headObject(manifest.treeKey);
    printJson({
      ok: true,
      manifest,
      keys: contextKeys(id),
      image: imageHead,
      tree: treeHead,
      encryptedAtRest: manifest.treeKey.endsWith(".enc") && manifest.treeEncryption?.algorithm === "aes-256-gcm",
    });
  });

const test = program.command("test").description("generate or run validation scenarios");

addRuntimeOptions(test
  .command("blind-retrieval")
  .description("seed a synthetic context and emit a blind-retrieval prompt/answer pair")
  .argument("[id]", "context id", "blind-retrieval-demo")
  .option("--prompt-out <path>", "write a handoff prompt for another AI")
  .option("--answer-out <path>", "write the separated answer key")
  .option("--execute", "create and save the synthetic context in the selected runtime"))
  .action(async (id: string, options: RuntimeCliOptions & { promptOut?: string; answerOut?: string; execute?: boolean }) => {
    const prompt = [
      "You have access to a sandbox/VM with contextSDK mounted.",
      "Find the single Friday launch blocker for Project Meridian.",
      "Return the answer and cite exact filesystem paths.",
    ].join("\n");
    const answer = [
      "The single blocker is the missing Northwind Data Trust SOC 2 bridge letter.",
      "Expected evidence paths:",
      "/memory/projects/meridian/decision-log.md",
      "/workspace/projects/meridian/launch-checklist.md",
      "/artifacts/reports/board-summary-2026-06-03.md",
    ].join("\n");
    if (options.promptOut) {
      await writeFile(options.promptOut, prompt);
    }
    if (options.answerOut) {
      await writeFile(options.answerOut, answer, { mode: 0o600 });
    }
    if (options.execute) {
      await runSyntheticBlindRetrieval(id, options);
    }
    printJson({ ok: true, id, prompt, answerKeyWritten: Boolean(options.answerOut), executed: Boolean(options.execute) });
  });

addRuntimeOptions(test
  .command("crash-recovery")
  .description("exercise checkpoint-based crash recovery")
  .argument("[id]", "context id", "crash-recovery-demo")
  .option("--execute", "run a bounded checkpoint recovery smoke test"))
  .action(async (id: string, options: RuntimeCliOptions & { execute?: boolean }) => {
    if (!options.execute) {
      printJson({
        ok: true,
        id,
        scenario: "Run with --execute to create a context, write a pre-crash marker, checkpoint it, and leave the latest checkpoint as the recovery point.",
      });
      return;
    }
    await runCrashRecoveryScenario(id, options);
    printJson({ ok: true, id });
  });

interface RuntimeCliOptions {
  runtime?: string;
  sandboxId?: string;
  sandboxName?: string;
  sandboxTimeoutMs?: string;
  sshHost?: string;
  sshUser?: string;
  sshPort?: string;
  sshKey?: string;
  vercelSandboxName?: string;
  vercelRuntime?: string;
  vercelTimeoutMs?: string;
  vercelVcpus?: string;
  vercelPersistent?: boolean;
  vercelSnapshotExpiration?: string;
  vercelKeepLastSnapshots?: string;
  runtimeState?: string;
  modalSandboxId?: string;
  modalApp?: string;
  modalImage?: string;
  modalVolume?: string;
  modalVolumeSubpath?: string;
  modalTimeoutMs?: string;
  modalIdleTimeoutMs?: string;
}

function addRuntimeOptions(command: Command): Command {
  return command
    .option("--runtime <runtime>", "runtime adapter: e2b, vercel, modal, or ssh")
    .option("--sandbox-id <id>", "existing E2B sandbox id")
    .option("--sandbox-name <name>", "provider sandbox name")
    .option("--sandbox-timeout-ms <ms>", "new sandbox timeout in ms")
    .option("--ssh-host <host>", "SSH host")
    .option("--ssh-user <user>", "SSH user")
    .option("--ssh-port <port>", "SSH port")
    .option("--ssh-key <path>", "SSH identity file")
    .option("--vercel-sandbox-name <name>", "existing or named Vercel Sandbox")
    .option("--vercel-runtime <runtime>", "Vercel Sandbox runtime", "python3.13")
    .option("--vercel-timeout-ms <ms>", "Vercel Sandbox timeout in ms")
    .option("--vercel-vcpus <count>", "Vercel Sandbox vCPU count")
    .option("--vercel-persistent", "enable Vercel persistent named sandbox state")
    .option("--no-vercel-persistent", "disable Vercel persistent named sandbox state")
    .option("--vercel-snapshot-expiration <duration>", "Vercel snapshot expiration, for example 14d or 1209600000")
    .option("--vercel-keep-last-snapshots <count>", "number of Vercel snapshots to retain")
    .option("--runtime-state <mode>", "runtime state handling: auto or disabled", "auto")
    .option("--modal-sandbox-id <id>", "existing Modal sandbox id")
    .option("--modal-app <name>", "Modal app name")
    .option("--modal-image <image>", "Modal registry image", "python:3.13-slim")
    .option("--modal-volume <name>", "Modal volume name")
    .option("--modal-volume-subpath <path>", "Modal volume subpath")
    .option("--modal-timeout-ms <ms>", "Modal sandbox timeout in ms")
    .option("--modal-idle-timeout-ms <ms>", "terminate the Modal sandbox after this much exec inactivity");
}

/**
 * Storage resolution order: explicit S3 (env or config) wins for shared,
 * multi-machine use; otherwise contexts live in a local directory store so the
 * CLI works out of the box without any cloud bucket.
 */
function storageFromEnv(): StorageAdapter {
  const config = configFromFile();
  // An explicit storage.type "fs" is a hard selection of local storage; a stray
  // CONTEXTSDK_S3_BUCKET in the environment must not silently override it.
  const bucket = config.storage?.type === "fs"
    ? undefined
    : process.env.CONTEXTSDK_S3_BUCKET ?? config.storage?.bucket;
  if (bucket) {
    return new S3Storage({
      bucket,
      prefix: process.env.CONTEXTSDK_S3_PREFIX ?? config.storage?.prefix,
      clientConfig: {
        region: process.env.CONTEXTSDK_S3_REGION ?? process.env.AWS_REGION ?? config.storage?.region ?? "auto",
        endpoint: process.env.CONTEXTSDK_S3_ENDPOINT ?? config.storage?.endpoint,
        forcePathStyle: process.env.CONTEXTSDK_S3_FORCE_PATH_STYLE === "1" || config.storage?.forcePathStyle,
        credentials: process.env.CONTEXTSDK_S3_ACCESS_KEY_ID || process.env.CONTEXTSDK_S3_SECRET_ACCESS_KEY
          ? {
              accessKeyId: requiredEnv("CONTEXTSDK_S3_ACCESS_KEY_ID"),
              secretAccessKey: requiredEnv("CONTEXTSDK_S3_SECRET_ACCESS_KEY"),
            }
          : undefined,
      },
    });
  }
  return new FsStorage({ directory: fsStorageDirectory() });
}

function fsStorageDirectory(): string {
  const config = configFromFile();
  return process.env.CONTEXTSDK_STORAGE_DIR
    ?? config.storage?.directory
    ?? defaultFsStorageDirectory(homedir());
}

function storageDescription(): { mode: "s3" | "fs"; bucket?: string; directory?: string } {
  const config = configFromFile();
  // An explicit storage.type "fs" is a hard selection of local storage; a stray
  // CONTEXTSDK_S3_BUCKET in the environment must not silently override it.
  const bucket = config.storage?.type === "fs"
    ? undefined
    : process.env.CONTEXTSDK_S3_BUCKET ?? config.storage?.bucket;
  if (bucket) {
    return { mode: "s3", bucket };
  }
  return { mode: "fs", directory: fsStorageDirectory() };
}

function encryptionFromEnv(): EncryptionConfig {
  const config = configFromFile();
  const passphrase = process.env[config.encryption?.passphraseEnv ?? "CONTEXTSDK_PASSPHRASE"];
  const rawKeyHex = process.env[config.encryption?.rawKeyHexEnv ?? "CONTEXTSDK_KEY_HEX"];
  if (!passphrase && !rawKeyHex) {
    throw new Error("CONTEXTSDK_PASSPHRASE or CONTEXTSDK_KEY_HEX is required");
  }
  return { passphrase, rawKeyHex };
}

async function runtimeFromOptions(options: RuntimeCliOptions, contextId?: string): Promise<RuntimeAdapter> {
  const runtime = runtimeName(options);
  if (runtime === "e2b") {
    return E2BAdapter.create({
      sandboxId: options.sandboxId,
      apiKey: process.env.E2B_API_KEY,
      timeoutMs: firstNumber(options.sandboxTimeoutMs, providerValue("e2b", "timeoutMs")),
    });
  }
  if (runtime === "vercel") {
    return VercelSandboxAdapter.create({
      sandboxName: options.vercelSandboxName ?? options.sandboxName ?? stringProviderValue("vercel", "sandboxName"),
      contextId,
      runtime: options.vercelRuntime ?? stringProviderValue("vercel", "runtime"),
      timeoutMs: firstNumber(options.vercelTimeoutMs, options.sandboxTimeoutMs, providerValue("vercel", "timeoutMs")),
      vcpus: firstNumber(options.vercelVcpus, providerValue("vercel", "vcpus")),
      persistent: vercelPersistentFromOptions(options),
      snapshotExpirationMs: firstNumber(
        options.vercelSnapshotExpiration ? parseDurationMs(options.vercelSnapshotExpiration) : undefined,
        providerValue("vercel", "snapshotExpirationMs"),
      ),
      keepLastSnapshots: firstNumber(options.vercelKeepLastSnapshots, providerValue("vercel", "keepLastSnapshots")),
      ...vercelCredentialsFromEnv(),
    });
  }
  if (runtime === "modal") {
    return ModalSandboxAdapter.create({
      sandboxId: options.modalSandboxId ?? stringProviderValue("modal", "sandboxId"),
      appName: options.modalApp ?? stringProviderValue("modal", "appName"),
      imageTag: options.modalImage ?? stringProviderValue("modal", "imageTag"),
      volumeName: options.modalVolume ?? stringProviderValue("modal", "volumeName"),
      volumeSubPath: options.modalVolumeSubpath ?? stringProviderValue("modal", "volumeSubPath"),
      timeoutMs: firstNumber(options.modalTimeoutMs, options.sandboxTimeoutMs, providerValue("modal", "timeoutMs")),
      idleTimeoutMs: firstNumber(options.modalIdleTimeoutMs, providerValue("modal", "idleTimeoutMs")),
    });
  }
  if (runtime === "ssh") {
    const host = options.sshHost ?? stringProviderValue("ssh", "host");
    if (!host) {
      throw new Error("--ssh-host is required for --runtime ssh");
    }
    return new SSHAdapter({
      host,
      user: options.sshUser ?? stringProviderValue("ssh", "user"),
      port: firstNumber(options.sshPort, providerValue("ssh", "port")),
      identityFile: options.sshKey ?? stringProviderValue("ssh", "identityFile"),
    });
  }
  throw new Error(`unsupported runtime: ${runtime}`);
}

function provisionerFromOptions(options: RuntimeCliOptions): RuntimeProvisioner | undefined {
  const runtime = runtimeName(options);
  if (runtime === "e2b" && !options.sandboxId) {
    return new E2BProvisioner({
      apiKey: process.env.E2B_API_KEY,
      timeoutMs: firstNumber(options.sandboxTimeoutMs, providerValue("e2b", "timeoutMs")),
    });
  }
  if (runtime === "vercel" && !options.vercelSandboxName && !options.sandboxName) {
    return new VercelProvisioner({
      runtime: options.vercelRuntime ?? stringProviderValue("vercel", "runtime"),
      timeoutMs: firstNumber(options.vercelTimeoutMs, options.sandboxTimeoutMs, providerValue("vercel", "timeoutMs")),
      vcpus: firstNumber(options.vercelVcpus, providerValue("vercel", "vcpus")),
      persistent: vercelPersistentFromOptions(options),
      snapshotExpirationMs: firstNumber(
        options.vercelSnapshotExpiration ? parseDurationMs(options.vercelSnapshotExpiration) : undefined,
        providerValue("vercel", "snapshotExpirationMs"),
      ),
      keepLastSnapshots: firstNumber(options.vercelKeepLastSnapshots, providerValue("vercel", "keepLastSnapshots")),
      ...vercelCredentialsFromEnv(),
    });
  }
  if (runtime === "modal" && !options.modalSandboxId) {
    return new ModalProvisioner({
      appName: options.modalApp ?? stringProviderValue("modal", "appName"),
      imageTag: options.modalImage ?? stringProviderValue("modal", "imageTag"),
      volumeName: options.modalVolume ?? stringProviderValue("modal", "volumeName"),
      volumeSubPath: options.modalVolumeSubpath ?? stringProviderValue("modal", "volumeSubPath"),
      timeoutMs: firstNumber(options.modalTimeoutMs, options.sandboxTimeoutMs, providerValue("modal", "timeoutMs")),
      idleTimeoutMs: firstNumber(options.modalIdleTimeoutMs, providerValue("modal", "idleTimeoutMs")),
    });
  }
  return undefined;
}

async function runSyntheticBlindRetrieval(id: string, options: RuntimeCliOptions): Promise<void> {
  const storage = storageFromEnv();
  const encryption = encryptionFromEnv();
  if (!await storage.headObject(contextKeys(id).manifest)) {
    await createContext({ id, storage, encryption, format: "tree", persistencePolicy: configFromFile().persistence });
  }
  await runWithContext({
    id,
    storage,
    encryption,
    provisioner: provisionerFromOptions(options),
    runtime: provisionerFromOptions(options) ? undefined : await runtimeFromOptions(options, id),
    message: "seed blind retrieval synthetic context",
    persistencePolicy: configFromFile().persistence,
    runtimeState: runtimeStateMode(options),
  }, async active => {
    await active.files.write("memory/projects/meridian/decision-log.md", "# Meridian decisions\n\nThe Friday launch blocker is the missing Northwind Data Trust SOC 2 bridge letter.\n");
    await active.files.write("workspace/projects/meridian/launch-checklist.md", "# Launch checklist\n\n- Payments smoke: passed\n- Legal review: passed\n- Required evidence: Northwind Data Trust SOC 2 bridge letter is missing\n");
    await active.files.write("artifacts/reports/board-summary-2026-06-03.md", "# Board summary\n\nLaunch remains blocked until the Northwind Data Trust SOC 2 bridge letter is attached to the evidence packet.\n");
  });
}

async function runCrashRecoveryScenario(id: string, options: RuntimeCliOptions): Promise<void> {
  const storage = storageFromEnv();
  const encryption = encryptionFromEnv();
  if (!await storage.headObject(contextKeys(id).manifest)) {
    await createContext({ id, storage, encryption, format: "tree", persistencePolicy: configFromFile().persistence });
  }
  const provisioner = provisionerFromOptions(options);
  const runtime = provisioner ? await provisioner.createSessionRuntime({ contextId: id }) : await runtimeFromOptions(options, id);
  try {
    const active = await startContextSession({ id, storage, encryption, runtime });
    await active.files.write("workspace/recovery.txt", `checkpointed at ${new Date().toISOString()}\n`);
    await checkpointContextSession(active, { storage, encryption, reason: "crash-recovery-test" });
    await detachContext({ id, storage, runtime, owner: active.owner, mountPath: active.mountPath }).catch(() => undefined);
  } finally {
    if (provisioner) {
      await provisioner.destroyRuntime?.(runtime).catch(() => undefined);
    }
    await runtime.dispose?.().catch(() => undefined);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function mountedFromCli(id: string, runtime: RuntimeAdapter, options: { mountPath?: string; owner?: string }): Promise<Parameters<typeof buildSession>[1]> {
  // Mirror attach's mount-mode decision: tree contexts use the directory-bundle
  // path whenever the runtime supports it, regardless of loop-ext4 capability.
  // The manifest must be readable to mount correctly, so a read failure is fatal
  // here rather than a silent fall back to the loop-ext4 path (which would run
  // umount against a directory-bundle mount).
  const manifest = await readManifest(storageFromEnv(), id);
  const useDirectoryBundle = Boolean(runtime.capabilities?.directoryBundle)
    && (manifest.format === "tree" || !runtime.capabilities?.loopExt4);
  return {
    id,
    // An empty owner skips lock-ownership verification; pass --owner from
    // `session start` output to enforce the one-active-writer check on saves.
    owner: options.owner ?? "",
    runtimeId: runtime.id,
    mountPath: options.mountPath ?? runtime.defaultMountPath?.(id) ?? defaultMountPath(id),
    remoteImagePath: remoteImagePath(id),
    remoteBundlePath: remoteBundlePath(id),
    localTempDir: "",
    mode: useDirectoryBundle ? "directoryBundle" : "loopExt4",
  };
}

function summarizeSession(session: ContextSession): unknown {
  return {
    id: session.id,
    owner: session.owner,
    runtimeId: session.runtimeId,
    mountPath: session.mountPath,
    remoteImagePath: session.mounted.remoteImagePath,
    remoteBundlePath: session.mounted.remoteBundlePath,
    mode: session.mounted.mode,
  };
}

function parseDurationMs(value: string): number {
  const match = value.trim().match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!match) {
    throw new Error(`invalid duration: ${value}`);
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  if (unit === "ms") return amount;
  if (unit === "s") return amount * 1000;
  if (unit === "m") return amount * 60_000;
  if (unit === "h") return amount * 3_600_000;
  if (unit === "d") return amount * 86_400_000;
  return amount;
}

function firstNumber(...values: Array<string | number | undefined>): number | undefined {
  const value = values.find(item => item !== undefined && item !== "");
  return value === undefined ? undefined : Number(value);
}

let loadedConfig: ContextSDKConfig | undefined;

function configFromFile(): ContextSDKConfig {
  if (loadedConfig) {
    return loadedConfig;
  }
  const explicit = process.env.CONTEXTSDK_CONFIG;
  const candidates = explicit
    ? [resolve(explicit)]
    : [
        "contextsdk.config.ts",
        "contextsdk.config.mts",
        "contextsdk.config.mjs",
        "contextsdk.config.js",
        "contextsdk.config.cjs",
        "contextsdk.config.json",
      ].map(file => resolve(process.cwd(), file));
  const file = candidates.find(candidate => existsSync(candidate));
  if (!file) {
    loadedConfig = {};
    return loadedConfig;
  }
  const jiti = createJiti(import.meta.url);
  const value = jiti(file) as unknown;
  const config = value && typeof value === "object" && "default" in value
    ? (value as { default?: ContextSDKConfig }).default
    : value;
  loadedConfig = (config ?? {}) as ContextSDKConfig;
  return loadedConfig;
}

function runtimeName(options: RuntimeCliOptions): string {
  const runtime = options.runtime ?? configFromFile().defaultRuntime;
  if (!runtime) {
    throw new Error("--runtime is required unless defaultRuntime is set in contextsdk.config.ts");
  }
  return runtime;
}

function runtimeStateMode(options: RuntimeCliOptions): "auto" | "disabled" {
  const value = options.runtimeState ?? configFromFile().runtimeState ?? "auto";
  if (value !== "auto" && value !== "disabled") {
    throw new Error("--runtime-state must be auto or disabled");
  }
  return value;
}

/**
 * Headless Vercel auth: the SDK needs the full token/team/project triple. The
 * values come from env only — never argv — so they stay out of process listings.
 */
function vercelCredentialsFromEnv(): { token?: string; teamId?: string; projectId?: string } {
  return {
    token: process.env.VERCEL_TOKEN ?? stringProviderValue("vercel", "token"),
    teamId: process.env.VERCEL_TEAM_ID ?? stringProviderValue("vercel", "teamId"),
    projectId: process.env.VERCEL_PROJECT_ID ?? stringProviderValue("vercel", "projectId"),
  };
}

function vercelPersistentFromOptions(options: RuntimeCliOptions): boolean | undefined {
  if (options.vercelPersistent !== undefined) {
    return options.vercelPersistent;
  }
  const configured = booleanProviderValue("vercel", "persistent");
  if (configured !== undefined) {
    return configured;
  }
  return runtimeStateMode(options) === "disabled" ? false : undefined;
}

function stringProviderValue(provider: string, key: string): string | undefined {
  const value = providerValue(provider, key);
  return typeof value === "string" ? value : undefined;
}

function booleanProviderValue(provider: string, key: string): boolean | undefined {
  const providers = configFromFile().providers as Record<string, Record<string, unknown> | undefined> | undefined;
  const value = providers?.[provider]?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function providerValue(provider: string, key: string): string | number | undefined {
  const providers = configFromFile().providers as Record<string, Record<string, unknown> | undefined> | undefined;
  const value = providers?.[provider]?.[key];
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hasCommand(command: string): boolean {
  try {
    execFileSync("sh", ["-lc", `command -v ${shellQuote(command)}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function resolveWriteData(data: string | undefined, useStdin?: boolean): Promise<string | Buffer> {
  if (useStdin && data !== undefined) {
    throw new Error("provide either <data> or --stdin, not both");
  }
  if (useStdin || data === undefined) {
    if (data === undefined && !useStdin && process.stdin.isTTY) {
      throw new Error("provide <data> or pipe input with --stdin");
    }
    return readStdin();
  }
  return data;
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function isDirectInvocation(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    // realpath resolves the npm bin symlink so the guard holds for installed CLIs.
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  program.parseAsync(process.argv).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { firstNumber, parseDurationMs, program };
