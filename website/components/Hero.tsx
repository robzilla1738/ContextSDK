import { ArrowRight, Github, Lock, Sparkles } from "lucide-react";
import { CodeBlock, C } from "./CodeBlock";

export function Hero() {
  return (
    <section
      id="top"
      className="relative overflow-hidden pt-32 pb-20 sm:pt-40 sm:pb-28"
    >
      {/* background flourishes */}
      <div className="pointer-events-none absolute inset-0 bg-grid [mask-image:radial-gradient(ellipse_at_center,black,transparent_70%)]" />
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[820px] -translate-x-1/2 rounded-full bg-gradient-to-tr from-brand-200/50 via-violet-200/40 to-transparent blur-3xl" />

      <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-5 sm:px-6 lg:grid-cols-2">
        <div className="animate-fade-up">
          <a
            href="https://www.npmjs.com/org/contextsdk"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/70 px-3 py-1 text-xs font-medium text-slate-600 shadow-sm backdrop-blur transition-colors hover:border-brand-300 hover:text-brand-700"
          >
            <Sparkles size={13} className="text-brand-500" />
            v0.4.0 now on npm — crash recovery &amp; session resume
            <ArrowRight size={13} />
          </a>

          <h1 className="mt-6 text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl lg:text-[3.4rem] lg:leading-[1.05]">
            A filesystem for your agents that{" "}
            <span className="text-gradient">survives the sandbox</span>
          </h1>

          <p className="mt-6 max-w-xl text-lg leading-relaxed text-slate-600">
            Agent runtimes should be disposable. ContextSDK keeps the compute
            throwaway and stores your agent&apos;s working state as an{" "}
            <span className="font-medium text-slate-800">
              encrypted, portable bundle
            </span>{" "}
            that moves across E2B, Vercel Sandbox, Modal, and SSH hosts.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a
              href="#cli"
              className="group inline-flex items-center gap-2 rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-slate-900/10 transition-all hover:bg-slate-800"
            >
              Get started
              <ArrowRight
                size={16}
                className="transition-transform group-hover:translate-x-0.5"
              />
            </a>
            <a
              href="https://github.com/robzilla1738/ContextSDK"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 shadow-sm transition-all hover:border-slate-300 hover:bg-slate-50"
            >
              <Github size={16} />
              Star on GitHub
            </a>
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1.5">
              <Lock size={13} className="text-emerald-500" />
              AES-256-GCM encryption
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
              Zero-config local store
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />
              MIT licensed · Node &ge; 20
            </span>
          </div>
        </div>

        <div className="animate-fade-up [animation-delay:120ms]">
          <CodeBlock title="terminal">
            <code>
              {C.comment("# install the CLI + core + adapters")}
              {"\n"}
              {C.cmd("npm")} install -g @contextsdk/cli @contextsdk/core
              {"\n\n"}
              {C.comment("# run a command in an E2B sandbox with a context")}
              {"\n"}
              {C.cmd("contextsdk")} run my-agent {C.flag("--runtime")} e2b{" "}
              {C.flag("--create-if-missing")} \{"\n"}
              {"  "}-- sh -lc {C.str("'echo hello > /workspace/state.txt'")}
              {"\n\n"}
              {C.comment("# a different sandbox sees the same state")}
              {"\n"}
              {C.cmd("contextsdk")} run my-agent {C.flag("--runtime")} vercel \
              {"\n"}
              {"  "}-- cat /workspace/state.txt{"\n"}
              {C.comment("# → hello")}
            </code>
          </CodeBlock>
        </div>
      </div>
    </section>
  );
}
