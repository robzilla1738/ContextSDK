import { KeyRound, LockKeyhole, ShieldCheck, ShieldAlert } from "lucide-react";
import { SectionHeading } from "./SectionHeading";

const items = [
  {
    icon: LockKeyhole,
    title: "Encrypted everywhere",
    body: "Bundles are AES-256-GCM encrypted with 16-byte auth tags and 12-byte nonces. Decrypted temp files are private and deleted after use — even when decryption fails mid-stream.",
  },
  {
    icon: KeyRound,
    title: "Single-writer locks",
    body: "Storage-backed locks with conditional writes guarantee one active writer per context. Sessions renew the lock on a heartbeat and assert ownership at commit.",
  },
  {
    icon: ShieldAlert,
    title: "Hardened unpacking",
    body: "Archive entries that traverse paths, use absolute or .. link targets, or are special files are rejected on both host and runtime, with entry-count and size caps.",
  },
  {
    icon: ShieldCheck,
    title: "Atomic commit protocol",
    body: "Data is written under generation-scoped keys; the manifest write is the atomic commit via compare-and-swap. A crash can never strand a manifest pointing at unreadable ciphertext.",
  },
];

export function Security() {
  return (
    <section
      id="security"
      className="border-t border-slate-200/70 bg-slate-50/60 py-24 sm:py-28"
    >
      <div className="mx-auto max-w-6xl px-5 sm:px-6">
        <SectionHeading
          eyebrow="Security"
          title="Built to be safe by default"
          subtitle="Encryption, isolation, and integrity are core invariants — not add-ons."
        />

        <div className="mt-14 grid gap-6 sm:grid-cols-2">
          {items.map((it) => (
            <div
              key={it.title}
              className="flex gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
            >
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 ring-1 ring-inset ring-emerald-100">
                <it.icon size={20} />
              </div>
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  {it.title}
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
                  {it.body}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
