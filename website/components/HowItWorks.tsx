import { SectionHeading } from "./SectionHeading";

const steps = [
  {
    n: "01",
    title: "Create a context",
    body: "Spin up an encrypted context with one command. No cloud bucket required — it lives in a local store until you point it at S3, R2, or MinIO.",
    code: "contextsdk init my-agent",
  },
  {
    n: "02",
    title: "Run in any sandbox",
    body: "Attach the context to E2B, Vercel, Modal, or SSH. Your agent gets /workspace, /memory, /artifacts and friends — the same every time.",
    code: "contextsdk run my-agent --runtime e2b -- sh -lc '…'",
  },
  {
    n: "03",
    title: "State moves with you",
    body: "Checkpoints and a single-writer lock keep the context consistent. Switch providers or recover from a crash — your working state follows.",
    code: "contextsdk run my-agent --runtime modal -- cat /workspace/state.txt",
  },
];

export function HowItWorks() {
  return (
    <section id="how" className="py-24 sm:py-28">
      <div className="mx-auto max-w-6xl px-5 sm:px-6">
        <SectionHeading
          eyebrow="How it works"
          title="From zero to portable context in three steps"
        />

        <div className="mt-14 grid gap-6 md:grid-cols-3">
          {steps.map((s, i) => (
            <div key={s.n} className="relative">
              {i < steps.length - 1 && (
                <div className="absolute left-[3.25rem] top-7 hidden h-px w-[calc(100%-2rem)] bg-gradient-to-r from-brand-200 to-transparent md:block" />
              )}
              <div className="h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-900 font-mono text-sm font-semibold text-white">
                  {s.n}
                </div>
                <h3 className="mt-5 text-base font-semibold text-slate-900">
                  {s.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">
                  {s.body}
                </p>
                <div className="mt-4 overflow-x-auto rounded-lg bg-slate-900 px-3 py-2.5 font-mono text-xs text-emerald-300">
                  {s.code}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
