# SEO RenderRank — Rendering-Aware SEO Analyzer

Chrome (MV3) extension that scores any page across six SEO perspectives, detects the
rendering strategy (SSG / SSR / CSR / ISR) — the thing generic SEO checkers can't see —
and compares **two or more URLs side by side** with a winner verdict and every contributing
factor shown transparently.

Built for two audiences at once: developers get an audit → AI-fix-prompt → re-audit loop
that closes the gap between "found an issue" and "fixed it"; SEO/marketing folks get a
score, a winner banner, and a SERP/social preview without touching a line of code.

## Install (load unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select this folder (`seo-compare-extension`)
4. Pin the icon; click it on any page

Works the same in Brave / Edge / any Chromium browser.

## Modes

### Full-screen dashboard
Click **⛶** in the popup header — opens the tool in a dedicated browser tab with a wide
layout: URL inputs in a row, comparison cards side by side in a grid, all check details
expanded. The current tab's URL is pre-filled as the first compare slot.

### Current Tab
Analyzes the page you're on. Combines three vantage points:
- **Raw server HTML** — re-fetched with `cache: no-store`, exactly what a crawler receives
- **Live tab data** — injected into the page's MAIN world: TTFB/FCP/LCP from the
  Performance API, live DOM size, framework globals (`__NEXT_DATA__`, `__NUXT__`, …)
- **Real document headers + XHR count** — captured by the service worker via `webRequest`
  (headers of the actual navigation, not the re-fetch, plus the number of API calls the
  page made after load)

### Compare URLs
Enter 2+ page URLs → each is fetched from the extension origin (host permissions bypass
CORS), parsed, and scored. You get:
- 🏆 winner banner with the point gap
- score table: overall + each perspective, best-in-row highlighted (◀)
- rendering strategy + framework row
- expandable per-site cards listing **every check** with its status (✓/△/✗), points
  earned vs max, and an explanation
- the signal chain that produced the rendering verdict

Compare mode sees the *pre-JavaScript* HTML only — which is deliberately the crawler's
view. A CSR site scoring low on Content/Rendering there is the correct SEO finding.

### Paid-tool-grade extras (per site card, under "Advanced")
Tucked behind a collapsed **Advanced** toggle on each card so the score/verdict/action-plan
isn't buried under a wall of checks on first open — expand it for:
- **SERP & social preview** — pixel-style Google snippet (title/crumb/description with real
  truncation) plus the Open Graph share card as it appears in chat/social apps
- **🔗 Internal link audit** — probes up to 15 internal links (HEAD, GET fallback) and lists
  broken ones with status codes
- **⚡ Lighthouse via PageSpeed Insights** — real lab scores (Performance/SEO/Best Practices/
  Accessibility) plus CrUX field data (LCP/INP/CLS from real Chrome users). Works keyless but
  rate-limited; paste a free API key in Settings for reliable use
- **Focus keyword** — enter one in the compare form and every page is scored on keyword
  targeting (Yoast/SurferSEO-style), letting you compare who targets the term better

### Develop → audit → AI-fix → re-audit loop
Built for fixing SEO *during* development, not just reporting it:
- Every failed/warned check carries a **💡 fix hint** — the concrete change to make
  (exact tag to add, header to send, or structural change), shown inline under the check
- **🎯 Action plan** at the top of every site card: all issues ranked by how many overall
  points fixing each one recovers, critical fails first, with the fix under each item
- **🤖 Copy AI fix prompt** — one click builds a complete prompt (URL, score, framework,
  every issue + finding + fix, framework-idiomatic instructions) ready to paste into
  Claude Code / any AI coding assistant. Apply the fixes, reload your page, re-run the
  audit, watch the score climb. Markdown export includes the action plan and fix hints too.
- **Prompt modules, staged** — issues are split into **Pre-production** (fix now in
  application code: meta, content, structured data…) and **Post-production**
  (server/CDN/deploy: HTTPS, security headers, caching, TTFB), then into one compact
  prompt per category. Modules are collapsed by default — the Copy button is on the
  header, expand only when you want to read the issues or preview the exact prompt text.
  Prompts are token-lean and lead with the score (page + category + recoverable points)
- **Progress tracking** — every audit of a URL is snapshotted (last 20 per URL, 50 URLs);
  the card shows your score trend across sessions: `Progress: 41 → 63 → 78 (+15 vs previous
  audit 2h ago)`. Identical back-to-back audits merge instead of stacking noise
- **⟳ Re-audit & diff** — re-runs the same page and replaces the card with the fresh
  result plus a diff panel: score delta, category deltas, and exactly which checks were
  Fixed / Improved / Regressed / newly introduced, and how many are still open. This is
  the verify step of the loop: paste prompt → AI fixes → Re-audit & diff

### Extras
- **⌖ Use current tab** — inserts the active tab's URL into the next empty compare slot
- **Export** — copy the full report as Markdown, or download it as JSON
- **History** — last 20 comparisons stored locally; click one to re-run it
- **robots.txt / sitemap audit** — per origin (cached): robots.txt presence, sitemap
  discovery (robots.txt declaration or `/sitemap.xml`), and a hard fail on `Disallow: /`
- **Theme toggle** — dark by default; click the sun/moon icon in the header to switch to
  light. Choice persists across popup opens.

## Scoring model

| Perspective | Weight | Checks |
|---|---|---|
| Meta Tags | 20% | title length, description length, canonical + self-reference, URL quality, hreflang, noindex, viewport, lang, charset, favicon, JSON-LD |
| Content Quality | 20% | single H1, heading hierarchy, word count, image alt coverage, image width/height (CLS), lazy loading, WebP/AVIF, internal/outbound links, text-to-HTML ratio |
| Keywords & Readability | 10% | Flesch readability, generic-anchor audit, top keywords/phrases + density, and — with a focus keyword set — keyword in title/H1/description/URL/opening copy + density 0.5–3% |
| Technical / Delivery | 20% | HTTPS, status, compression, Cache-Control, CDN fingerprint, TTFB, HTML size, robots.txt, sitemap, HSTS, security headers (CSP/XCTO/XFO/Referrer-Policy) (+FCP/LCP on current tab) |
| Social Sharing | 10% | og:title, og:description, og:image, twitter:card |
| Rendering & Indexability | 20% | content in initial HTML, crawlability (robots Disallow:/), noscript fallback, edge/cache delivery, API-call dependence |

Category score = points/max × 100; overall = weighted average. Grades: A ≥90, B ≥75, C ≥60, D ≥40, else F.

## Rendering detection (probabilistic, confidence-labelled)

1. **Framework internals first** — `__NEXT_DATA__.gssp` → SSR, `.gsp` → SSG,
   `.gsp` + `x-vercel-cache: STALE/REVALIDATED` or `stale-while-revalidate` → **ISR** (high confidence)
2. **App shell test** — near-empty body with `#root`/`#app` div → **CSR**
3. **Cache-behavior tie-break** for server-delivered HTML:
   `Set-Cookie` / `private` / `no-store` → **SSR**; CDN HIT / `Age > 0` → **SSG**;
   `stale-while-revalidate` + HIT → **ISR**
4. Hydration flagged when a serialized state blob ships with server HTML
   (`__NEXT_DATA__`, `self.__next_f`, `__NUXT__`, `__remixContext`, astro-islands, …)

Known ambiguity (inherent, not a bug): uncached SSG is indistinguishable from fast SSR
from the outside; the verdict is labelled low-confidence in that case.

## Files

```
manifest.json     MV3 manifest
sw.js             service worker — header capture + per-tab XHR counting
lib/analyzer.js   scoring engine + framework/rendering detection (pure, DOM-in → report-out)
popup.html/css/js UI: current-tab report + multi-URL comparison
icons/            generated icons + KudoMetrics logo variants (credit footer)
```

## Credits

Built by [KudoMetrics Technologies Private Limited](https://kudometrics.com/) —
"Empowering Innovation with Intelligent Digital Solutions." A theme-aware KudoMetrics
logo + link sits in the popup footer; both are also declared in `manifest.json`
(`author`, `homepage_url`).
