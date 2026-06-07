import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://contextsdk.dev"),
  title: "ContextSDK — Portable encrypted context for AI agents",
  description:
    "ContextSDK gives your AI agents a real filesystem that survives disposable sandboxes and VMs. Encrypted, portable context that moves across E2B, Vercel Sandbox, Modal, and SSH.",
  keywords: [
    "ContextSDK",
    "AI agents",
    "sandbox",
    "filesystem",
    "persistence",
    "E2B",
    "Vercel Sandbox",
    "Modal",
    "encrypted context",
  ],
  openGraph: {
    title: "ContextSDK — Portable encrypted context for AI agents",
    description:
      "A real filesystem for your agents that survives disposable sandboxes and VMs. Encrypted and portable across E2B, Vercel, Modal, and SSH.",
    type: "website",
    url: "https://contextsdk.dev",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
