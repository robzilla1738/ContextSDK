import { Check, Cloud, HardDrive } from "lucide-react";
import { SectionHeading } from "./SectionHeading";

const folders = [
  "/workspace",
  "/memory",
  "/artifacts",
  "/logs",
  "/config",
  "/cache",
];

const portable = [
  "/workspace, /memory, /artifacts",
  "/logs and /config",
  "Encrypted at rest, moves across providers",
];

const runtime = [
  "node_modules & package caches",
  "virtualenvs, .next, dist, build output",
  "Served by provider persistence & snapshots",
];

export function TwoLayer() {
  return (
    <section
      id="two-layer"
      className="relative overflow-hidden border-y border-slate-200/70 bg-slate-50/60 py-24 sm:py-28"
    >
      <div className="pointer-events-none absolute inset-0 bg-grid-faint [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]" />
      <div className="relative mx-auto max-w-6xl px-5 sm:px-6">
        <SectionHeading
          eyebrow="Two-layer state"
          title="Portable where it matters, fast where it counts"
          subtitle="Don't collapse the layers. The portable context is your cross-provider source of truth; provider persistence is the accelerator."
        />

        <div className="mt-14 grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-brand-200 bg-white p-7 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-white">
                <Cloud size={18} />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-slate-900">
                  Portable context
                </h3>
                <p className="text-sm text-slate-500">
                  Encrypted · cross-provider
                </p>
              </div>
            </div>
            <ul className="mt-5 space-y-3">
              {portable.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-sm text-slate-600">
                  <Check size={16} className="mt-0.5 shrink-0 text-brand-600" />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-800 text-white">
                <HardDrive size={18} />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-slate-900">
                  Runtime state
                </h3>
                <p className="text-sm text-slate-500">
                  Provider-local · disposable
                </p>
              </div>
            </div>
            <ul className="mt-5 space-y-3">
              {runtime.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-sm text-slate-600">
                  <Check size={16} className="mt-0.5 shrink-0 text-slate-400" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-10 rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
          <p className="text-sm font-medium text-slate-500">
            Same folders inside every runtime
          </p>
          <div className="mt-4 flex flex-wrap gap-2.5">
            {folders.map((f) => (
              <span
                key={f}
                className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 font-mono text-sm text-slate-700"
              >
                {f}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
