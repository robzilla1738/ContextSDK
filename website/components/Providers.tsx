const providers = [
  { name: "E2B", note: "SDK v2 · 30 min default" },
  { name: "Vercel Sandbox", note: "persistent named sandboxes" },
  { name: "Modal", note: "Volume-backed dirs" },
  { name: "SSH", note: "attach any host" },
];

export function Providers() {
  return (
    <section className="border-y border-slate-200/70 bg-slate-50/60 py-10">
      <div className="mx-auto max-w-6xl px-5 sm:px-6">
        <p className="text-center text-xs font-medium uppercase tracking-widest text-slate-400">
          One encrypted context · runs everywhere
        </p>
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {providers.map((p) => (
            <div
              key={p.name}
              className="flex flex-col items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-5 text-center shadow-sm transition-colors hover:border-brand-200"
            >
              <span className="text-base font-semibold text-slate-800">
                {p.name}
              </span>
              <span className="mt-1 text-xs text-slate-500">{p.note}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
