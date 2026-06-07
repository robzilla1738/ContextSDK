"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { SectionHeading } from "./SectionHeading";

type Tab = {
  id: string;
  label: string;
  lang: string;
  lines: { text: string; tone?: "comment" | "out" }[];
  copy: string;
};

const tabs: Tab[] = [
  {
    id: "cli",
    label: "CLI",
    lang: "bash",
    copy: `contextsdk doctor
contextsdk init employee-robert
contextsdk run employee-robert --runtime e2b --create-if-missing \\
  --checkpoint-interval 5m -- sh -lc 'echo ok > /workspace/result.txt'
contextsdk run employee-robert --runtime vercel -- cat /workspace/result.txt`,
    lines: [
      { text: "# check setup, credentials, and host tools", tone: "comment" },
      { text: "contextsdk doctor" },
      { text: "" },
      { text: "# create an encrypted context", tone: "comment" },
      { text: "contextsdk init employee-robert" },
      { text: "" },
      { text: "# run in E2B with periodic checkpoints", tone: "comment" },
      { text: "contextsdk run employee-robert --runtime e2b \\" },
      { text: "  --create-if-missing --checkpoint-interval 5m \\" },
      { text: "  -- sh -lc 'echo ok > /workspace/result.txt'" },
      { text: "" },
      { text: "# move the same context to Vercel Sandbox", tone: "comment" },
      { text: "contextsdk run employee-robert --runtime vercel \\" },
      { text: "  -- cat /workspace/result.txt" },
      { text: "→ ok", tone: "out" },
    ],
  },
  {
    id: "sdk",
    label: "SDK",
    lang: "typescript",
    copy: `import { FsStorage, runWithContext } from "@contextsdk/core";
import { E2BProvisioner } from "@contextsdk/adapter-e2b";

const storage = new FsStorage({ directory: \`\${process.env.HOME}/.contextsdk/storage\` });

await runWithContext({
  id: "agent-123",
  storage,
  encryption: { passphrase: process.env.CONTEXTSDK_PASSPHRASE! },
  provisioner: new E2BProvisioner({ apiKey: process.env.E2B_API_KEY }),
  createIfMissing: true,
  checkpoint: { intervalMs: 300_000 },
  recovery: { enabled: true, reinvoke: true },
}, async (session) => {
  await session.files.write("workspace/task.txt", "current task state\\n");
  await session.memory.append("User prefers concise answers.");
  await session.artifacts.write("result.txt", "final artifact\\n");
});`,
    lines: [
      { text: 'import { FsStorage, runWithContext } from "@contextsdk/core";' },
      { text: 'import { E2BProvisioner } from "@contextsdk/adapter-e2b";' },
      { text: "" },
      { text: "const storage = new FsStorage({" },
      { text: "  directory: `${process.env.HOME}/.contextsdk/storage`," },
      { text: "});" },
      { text: "" },
      { text: "await runWithContext({" },
      { text: '  id: "agent-123",' },
      { text: "  storage," },
      { text: "  encryption: { passphrase: process.env.CONTEXTSDK_PASSPHRASE! }," },
      { text: "  provisioner: new E2BProvisioner({ apiKey: process.env.E2B_API_KEY })," },
      { text: "  createIfMissing: true," },
      { text: "  checkpoint: { intervalMs: 300_000 }," },
      { text: "  recovery: { enabled: true, reinvoke: true }," },
      { text: "}, async (session) => {" },
      { text: '  await session.files.write("workspace/task.txt", "state\\n");' },
      { text: '  await session.memory.append("User prefers concise answers.");' },
      { text: '  await session.artifacts.write("result.txt", "artifact\\n");' },
      { text: "});" },
    ],
  },
  {
    id: "config",
    label: "Storage",
    lang: "bash",
    copy: `# Local store (default) — nothing to configure
export CONTEXTSDK_PASSPHRASE="choose-a-strong-passphrase"

# Or S3-compatible storage for multi-machine use
export CONTEXTSDK_S3_BUCKET="agent-contexts"
export CONTEXTSDK_S3_REGION="auto"
export CONTEXTSDK_S3_ENDPOINT="https://<account>.r2.cloudflarestorage.com"
export CONTEXTSDK_S3_ACCESS_KEY_ID="..."
export CONTEXTSDK_S3_SECRET_ACCESS_KEY="..."`,
    lines: [
      { text: "# Local store (default) — nothing to configure", tone: "comment" },
      { text: 'export CONTEXTSDK_PASSPHRASE="choose-a-strong-passphrase"' },
      { text: "" },
      { text: "# Or S3-compatible storage for multi-machine use", tone: "comment" },
      { text: 'export CONTEXTSDK_S3_BUCKET="agent-contexts"' },
      { text: 'export CONTEXTSDK_S3_REGION="auto"' },
      { text: 'export CONTEXTSDK_S3_ENDPOINT="https://<acct>.r2.cloudflarestorage.com"' },
      { text: 'export CONTEXTSDK_S3_ACCESS_KEY_ID="..."' },
      { text: 'export CONTEXTSDK_S3_SECRET_ACCESS_KEY="..."' },
      { text: "" },
      { text: "# Resolution: explicit S3 → local dir → ~/.contextsdk/storage", tone: "comment" },
    ],
  },
];

export function CodeShowcase() {
  const [active, setActive] = useState(tabs[0].id);
  const [copied, setCopied] = useState(false);
  const tab = tabs.find((t) => t.id === active)!;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(tab.copy);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <section id="cli" className="py-24 sm:py-28">
      <div className="mx-auto max-w-5xl px-5 sm:px-6">
        <SectionHeading
          eyebrow="Developer experience"
          title="A clean CLI and a typed SDK"
          subtitle="Drive contexts from the terminal, or wire them into your agent with the TypeScript SDK."
        />

        <div className="mt-12 overflow-hidden rounded-2xl border border-slate-200 bg-slate-900 shadow-2xl shadow-slate-900/10">
          <div className="flex items-center justify-between border-b border-white/10 bg-slate-800/80 px-3">
            <div className="flex">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setActive(t.id)}
                  className={`px-4 py-3 text-sm font-medium transition-colors ${
                    active === t.id
                      ? "border-b-2 border-brand-400 text-white"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <button
              onClick={onCopy}
              className="mr-1 flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-400 transition-colors hover:bg-white/5 hover:text-white"
              aria-label="Copy code"
            >
              {copied ? (
                <>
                  <Check size={14} className="text-emerald-400" /> Copied
                </>
              ) : (
                <>
                  <Copy size={14} /> Copy
                </>
              )}
            </button>
          </div>

          <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed">
            <code>
              {tab.lines.map((line, i) => (
                <div
                  key={i}
                  className={
                    line.tone === "comment"
                      ? "text-slate-500"
                      : line.tone === "out"
                        ? "text-emerald-300"
                        : "text-slate-200"
                  }
                >
                  {line.text || "\u00A0"}
                </div>
              ))}
            </code>
          </pre>
        </div>
      </div>
    </section>
  );
}
