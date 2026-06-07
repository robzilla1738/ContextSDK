import { type ReactNode } from "react";

export function CodeBlock({
  title = "bash",
  children,
  className = "",
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`overflow-hidden rounded-xl border border-slate-200 bg-slate-900 shadow-xl shadow-slate-900/5 ${className}`}
    >
      <div className="flex items-center gap-2 border-b border-white/10 bg-slate-800/80 px-4 py-2.5">
        <span className="h-3 w-3 rounded-full bg-red-400/80" />
        <span className="h-3 w-3 rounded-full bg-amber-400/80" />
        <span className="h-3 w-3 rounded-full bg-emerald-400/80" />
        <span className="ml-2 font-mono text-xs text-slate-400">{title}</span>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed text-slate-200">
        {children}
      </pre>
    </div>
  );
}

/** Inline helpers for lightweight syntax coloring inside CodeBlock. */
export const C = {
  comment: (t: string) => <span className="text-slate-500">{t}</span>,
  cmd: (t: string) => <span className="text-emerald-300">{t}</span>,
  flag: (t: string) => <span className="text-brand-300">{t}</span>,
  str: (t: string) => <span className="text-amber-200">{t}</span>,
  kw: (t: string) => <span className="text-violet-300">{t}</span>,
};
