import {
  Boxes,
  FileLock2,
  GitBranch,
  Layers,
  LifeBuoy,
  TerminalSquare,
} from "lucide-react";
import { SectionHeading } from "./SectionHeading";

const features = [
  {
    icon: FileLock2,
    title: "Encrypted portable context",
    body: "User and agent state lives in an AES-256-GCM encrypted bundle. Decryption follows the parameters recorded per-bundle, so old contexts never break.",
  },
  {
    icon: Layers,
    title: "Two-layer state model",
    body: "A portable context is the cross-provider source of truth; runtime state (node_modules, caches, build output) stays provider-local for speed.",
  },
  {
    icon: Boxes,
    title: "Multi-provider by design",
    body: "The same context attaches to E2B, Vercel Sandbox, Modal, or any SSH host. Move a workload between providers without losing your working state.",
  },
  {
    icon: GitBranch,
    title: "Safe commit protocol",
    body: "Generation-scoped writes plus a manifest compare-and-swap mean an interrupted save can never corrupt the previous generation of your context.",
  },
  {
    icon: LifeBuoy,
    title: "Crash detection & recovery",
    body: "A heartbeat watches lock renewals; a dead sandbox is re-provisioned and re-attached under the same lock owner, with optional callback reinvoke.",
  },
  {
    icon: TerminalSquare,
    title: "Zero-config CLI",
    body: "Works with no cloud bucket — contexts live encrypted in a local store. Add S3, R2, or MinIO when you need multi-machine access.",
  },
];

export function Features() {
  return (
    <section id="features" className="py-24 sm:py-28">
      <div className="mx-auto max-w-6xl px-5 sm:px-6">
        <SectionHeading
          eyebrow="Why ContextSDK"
          title="Continuity for disposable compute"
          subtitle="Keep your sandboxes throwaway without losing what your agents have learned and built."
        />

        <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div
              key={f.title}
              className="group relative rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-lg hover:shadow-brand-500/5"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-100 transition-colors group-hover:bg-brand-600 group-hover:text-white">
                <f.icon size={20} />
              </div>
              <h3 className="mt-5 text-base font-semibold text-slate-900">
                {f.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">
                {f.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
