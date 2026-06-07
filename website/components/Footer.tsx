import { Github, Package } from "lucide-react";
import { Logo } from "./Logo";

const cols = [
  {
    heading: "Product",
    links: [
      { label: "Features", href: "#features" },
      { label: "Two-layer state", href: "#two-layer" },
      { label: "How it works", href: "#how" },
      { label: "Security", href: "#security" },
    ],
  },
  {
    heading: "Resources",
    links: [
      {
        label: "Documentation",
        href: "https://github.com/robzilla1738/ContextSDK#readme",
      },
      {
        label: "Changelog",
        href: "https://github.com/robzilla1738/ContextSDK/blob/main/CHANGELOG.md",
      },
      {
        label: "Examples",
        href: "https://github.com/robzilla1738/ContextSDK/tree/main/examples",
      },
      {
        label: "Enterprise rollout",
        href: "https://github.com/robzilla1738/ContextSDK/blob/main/docs/enterprise-rollout.md",
      },
    ],
  },
  {
    heading: "Open source",
    links: [
      { label: "GitHub", href: "https://github.com/robzilla1738/ContextSDK" },
      { label: "npm org", href: "https://www.npmjs.com/org/contextsdk" },
      {
        label: "Issues",
        href: "https://github.com/robzilla1738/ContextSDK/issues",
      },
      {
        label: "License (MIT)",
        href: "https://github.com/robzilla1738/ContextSDK/blob/main/LICENSE",
      },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto max-w-6xl px-5 py-14 sm:px-6">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <Logo />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-slate-500">
              Portable encrypted context state for AI sandboxes and VMs. Keep the
              compute disposable; keep the context.
            </p>
            <div className="mt-5 flex gap-2">
              <a
                href="https://github.com/robzilla1738/ContextSDK"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="GitHub"
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-600 transition-colors hover:border-slate-300 hover:text-slate-900"
              >
                <Github size={17} />
              </a>
              <a
                href="https://www.npmjs.com/org/contextsdk"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="npm"
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-600 transition-colors hover:border-slate-300 hover:text-slate-900"
              >
                <Package size={17} />
              </a>
            </div>
          </div>

          {cols.map((col) => (
            <div key={col.heading}>
              <h4 className="text-sm font-semibold text-slate-900">
                {col.heading}
              </h4>
              <ul className="mt-4 space-y-3">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <a
                      href={l.href}
                      target={l.href.startsWith("http") ? "_blank" : undefined}
                      rel={
                        l.href.startsWith("http")
                          ? "noopener noreferrer"
                          : undefined
                      }
                      className="text-sm text-slate-500 transition-colors hover:text-slate-900"
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-3 border-t border-slate-200 pt-6 text-sm text-slate-500 sm:flex-row">
          <p>© {new Date().getFullYear()} ContextSDK. MIT licensed.</p>
          <p className="font-mono text-xs">
            @contextsdk/core@0.4.0 · Node &ge; 20
          </p>
        </div>
      </div>
    </footer>
  );
}
