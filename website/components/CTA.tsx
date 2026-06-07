import { ArrowRight, Github, Package } from "lucide-react";

export function CTA() {
  return (
    <section className="py-24 sm:py-28">
      <div className="mx-auto max-w-6xl px-5 sm:px-6">
        <div className="relative overflow-hidden rounded-3xl bg-slate-900 px-8 py-16 text-center shadow-2xl shadow-slate-900/20 sm:px-16">
          <div className="pointer-events-none absolute inset-0 bg-grid [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)] opacity-40" />
          <div className="pointer-events-none absolute -bottom-32 left-1/2 h-72 w-[40rem] -translate-x-1/2 rounded-full bg-gradient-to-tr from-brand-600/40 to-violet-500/30 blur-3xl" />

          <div className="relative">
            <h2 className="mx-auto max-w-2xl text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Give your agents memory that outlives the machine
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-lg text-slate-300">
              Install the CLI, point it at any provider, and keep your agent
              state portable and encrypted.
            </p>

            <div className="mx-auto mt-8 max-w-xl overflow-x-auto rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-left font-mono text-sm text-emerald-300">
              npm install -g @contextsdk/cli @contextsdk/core
            </div>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <a
                href="https://github.com/robzilla1738/ContextSDK"
                target="_blank"
                rel="noopener noreferrer"
                className="group inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow-lg transition-all hover:bg-slate-100"
              >
                <Github size={16} />
                View on GitHub
                <ArrowRight
                  size={16}
                  className="transition-transform group-hover:translate-x-0.5"
                />
              </a>
              <a
                href="https://www.npmjs.com/org/contextsdk"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-5 py-3 text-sm font-semibold text-white transition-all hover:bg-white/10"
              >
                <Package size={16} />
                npm packages
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
