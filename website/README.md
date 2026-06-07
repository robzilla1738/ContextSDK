# ContextSDK website

Marketing site for [ContextSDK](https://github.com/robzilla1738/ContextSDK) — built with Next.js (App Router) and Tailwind CSS. Modern, light, and clean.

## Develop

```bash
cd website
npm install
npm run dev      # http://localhost:3000
```

## Build

The site is a fully static export (`output: "export"`), so it can be hosted on any static host (Vercel, Netlify, Cloudflare Pages, S3, GitHub Pages):

```bash
npm run build    # generates ./out
```

## Lint

```bash
npm run lint
```

## Structure

- `app/` — App Router entry (`layout.tsx`, `page.tsx`, `globals.css`).
- `components/` — section components (`Hero`, `Features`, `TwoLayer`, `HowItWorks`, `CodeShowcase`, `Security`, `CTA`, `Footer`, `Nav`).
- `tailwind.config.ts` — theme (brand palette, fonts, animations).

This package is intentionally **not** part of the root npm workspaces, so it is independent of the SDK build and CI.
