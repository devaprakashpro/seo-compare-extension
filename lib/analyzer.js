// SEO analysis engine. Pure functions over (rawHtml, parsed Document,
// response headers, timing, optional live-tab data). Runs in the popup,
// which is a trusted extension page with DOMParser available.
//
// Output shape:
// {
//   url, overall, verdictText,
//   rendering: { verdict, confidence, framework, hydration, signals[] },
//   categories: [ { id, name, weight, score, checks: [ {label, status, points, max, detail} ] } ]
// }
// status: 'pass' | 'warn' | 'fail' | 'info'  (info checks carry no points)

"use strict";

const SEO_WEIGHTS = {
  meta: 0.2,
  content: 0.2,
  keywords: 0.1,
  technical: 0.2,
  social: 0.1,
  rendering: 0.2,
};

const CATEGORY_NAMES = {
  meta: "Meta Tags",
  content: "Content Quality",
  keywords: "Keywords & Readability",
  technical: "Technical / Delivery",
  social: "Social Sharing",
  rendering: "Rendering & Indexability",
};

// ---------- framework API reference for AI prompts ----------

const FRAMEWORK_APIS = {
  "Next.js": {
    metadata: "generateMetadata() / Metadata export in layout.tsx or page.tsx",
    image: "next/image <Image> component with width/height",
    head: "metadata export or generateMetadata() async function (App Router)",
    jsonLd: "<script type='application/ld+json'> in a Server Component",
    sitemap: "app/sitemap.ts export or next-sitemap package",
    robots: "app/robots.ts export",
    config: "next.config.js headers() for security/cache headers",
  },
  "Nuxt": {
    metadata: "useHead() / useSeoMeta() composables",
    image: "<NuxtImg> or <NuxtPicture> component",
    head: "useHead() in setup or definePageMeta()",
    jsonLd: "useSchemaOrg() via nuxt-schema-org or useHead({ script: [...] })",
    sitemap: "@nuxtjs/sitemap module",
    robots: "@nuxtjs/robots module",
    config: "nuxt.config.ts routeRules for headers",
  },
  "Gatsby": {
    metadata: "Head API export in page component",
    image: "gatsby-plugin-image <StaticImage> / <GatsbyImage>",
    head: "Head API export in page component",
    jsonLd: "react-schemaorg or inline <script> in Head",
    sitemap: "gatsby-plugin-sitemap",
    robots: "gatsby-plugin-robots-txt",
    config: "gatsby-plugin-netlify or custom headers in hosting config",
  },
  "Astro": {
    metadata: "<head> in layout component, use Astro.props for dynamic values",
    image: "<Image> from astro:assets",
    head: "<head> slot in layout component",
    jsonLd: "Inline <script type='application/ld+json'> in layout <head>",
    sitemap: "@astrojs/sitemap integration",
    robots: "public/robots.txt or custom endpoint",
    config: "astro.config.mjs headers via adapter config",
  },
  "Remix": {
    metadata: "meta() export / MetaFunction in route module",
    image: "standard <img> with explicit width/height (no built-in image component)",
    head: "meta() function export in route module",
    jsonLd: "Return script tag from meta() with 'script:ld+json'",
    sitemap: "Resource route at /sitemap[.]xml",
    robots: "Resource route at /robots[.]txt",
    config: "entry.server.tsx headers or hosting config",
  },
  "SvelteKit": {
    metadata: "<svelte:head> in +page.svelte or +layout.svelte",
    image: "@sveltejs/enhanced-img or standard <img>",
    head: "<svelte:head> block",
    jsonLd: "<svelte:head><script type='application/ld+json'></svelte:head>",
    sitemap: "Custom /sitemap.xml/+server.ts endpoint",
    robots: "static/robots.txt or custom endpoint",
    config: "hooks.server.ts handle() for headers",
  },
  "WordPress": {
    metadata: "wp_head action hook, Yoast SEO / Rank Math plugin",
    image: "wp_get_attachment_image() with srcset",
    head: "wp_head action hook in header.php / functions.php",
    jsonLd: "Yoast/Rank Math auto-generates, or wp_head hook",
    sitemap: "Built-in wp-sitemap.xml or Yoast/Rank Math",
    robots: "Settings → Reading or robots.txt in root",
    config: ".htaccess or nginx config for headers",
  },
  "Shopify": {
    metadata: "{% assign page_title %} / Liquid meta tags in theme.liquid",
    image: "{{ image | image_url }} with width/height params",
    head: "content_for_header in layout/theme.liquid",
    jsonLd: "Liquid template in theme.liquid <script type='application/ld+json'>",
    sitemap: "Auto-generated at /sitemap.xml",
    robots: "Settings → Preferences or theme robots.txt.liquid",
    config: "Shopify admin or app proxies (limited server control)",
  },
};

function lookupFrameworkApis(fw) {
  if (!fw || fw === "Not detected") return null;
  const key = Object.keys(FRAMEWORK_APIS).find((k) => fw.includes(k));
  return key ? FRAMEWORK_APIS[key] : null;
}

// ---------- helpers ----------

function visibleText(doc) {
  const strip = (root) => {
    const clone = root.cloneNode(true);
    clone
      .querySelectorAll("script,style,noscript,template,svg,head,title,meta,link")
      .forEach((n) => n.remove());
    return (clone.textContent || "").replace(/\s+/g, " ").trim();
  };
  let text = doc.body ? strip(doc.body) : "";
  // Some parsers misplace content relative to <body>; fall back to the whole tree.
  if (!text && doc.documentElement) text = strip(doc.documentElement);
  return text;
}

const STOPWORDS = new Set(
  "a,an,the,and,or,but,if,then,else,when,while,of,to,in,on,at,by,for,with,about,as,into,like,through,after,over,between,out,against,during,without,before,under,around,among,is,are,was,were,be,been,being,have,has,had,do,does,did,will,would,should,could,can,may,might,must,shall,this,that,these,those,i,you,he,she,it,we,they,them,his,her,its,our,your,their,my,me,him,us,from,up,down,so,than,too,very,just,not,no,nor,only,own,same,also,more,most,other,some,such,what,which,who,whom,how,why,where,all,any,both,each,few,get,got,make,made,one,two,new,use,using,used".split(",")
);

function tokenize(text) {
  return (text || "").toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || [];
}

function topKeywords(text, toks) {
  toks = toks || tokenize(text);
  const words = toks.filter((w) => !STOPWORDS.has(w) && w.length > 2 && !/^\d+$/.test(w));
  const total = words.length || 1;
  const uni = {};
  for (const w of words) uni[w] = (uni[w] || 0) + 1;
  const bi = {};
  for (let i = 0; i < toks.length - 1; i++) {
    const a = toks[i], b = toks[i + 1];
    if (STOPWORDS.has(a) || STOPWORDS.has(b) || a.length < 3 || b.length < 3) continue;
    const k = a + " " + b;
    bi[k] = (bi[k] || 0) + 1;
  }
  return {
    top: Object.entries(uni).sort((x, y) => y[1] - x[1]).slice(0, 8)
      .map(([term, count]) => ({ term, count, density: +((count / total) * 100).toFixed(1) })),
    phrases: Object.entries(bi).filter(([, c]) => c >= 2).sort((x, y) => y[1] - x[1]).slice(0, 4)
      .map(([term, count]) => ({ term, count })),
    totalWords: total,
  };
}

function fleschScore(text, toks) {
  const words = toks || tokenize(text);
  if (words.length < 40) return null; // too little text for a meaningful score
  const sentences = (text.match(/[.!?]+(\s|$)/g) || []).length || Math.max(1, Math.round(words.length / 20));
  const syllables = words.reduce((s, w) => s + Math.max(1, (w.match(/[aeiouy]+/g) || []).length), 0);
  return Math.round(206.835 - 1.015 * (words.length / sentences) - 84.6 * (syllables / words.length));
}

// ---------- fix hints: concrete solution for every failable check ----------

const FIX_HINTS = {
  "Title tag": 'Write a unique <title> of 30–60 chars: primary keyword first, brand last — e.g. <title>Primary Keyword — What the Page Offers | Brand</title>.',
  "Meta description": 'Add <meta name="description" content="…"> with 70–160 chars of compelling copy including the main keyword — this is your SERP ad text.',
  "Canonical URL": 'Add <link rel="canonical" href="https://your-domain.com/this-page"> in <head> pointing at the preferred version of this URL.',
  "Canonical matches URL": "Make the canonical self-referencing unless this page is intentionally a duplicate — pointing elsewhere hands this page's ranking signals to that URL.",
  "URL quality": "Use short, lowercase, hyphen-separated slugs (≤5 path segments, ≤2 query params); 301-redirect old URLs if you rename.",
  "Indexable (no noindex)": "Remove noindex from the robots meta tag / X-Robots-Tag header if this page should rank.",
  "Mobile viewport": 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> in <head>.',
  "html lang attribute": 'Add lang to the root element, e.g. <html lang="en">.',
  "Charset declared": 'Add <meta charset="utf-8"> as the first element inside <head>.',
  "Favicon": 'Add <link rel="icon" href="/favicon.ico" sizes="any"> (plus an SVG icon and a 180px apple-touch-icon).',
  "Structured data (JSON-LD)": 'Add a <script type="application/ld+json"> block with the schema.org type matching this page (Article, Product, FAQPage, Organization…) to unlock rich results.',
  "Single H1": "Use exactly one <h1> containing the page's primary topic/keyword; demote extra H1s to <h2>.",
  "Heading hierarchy": "Never skip levels (H1 → H2 → H3). Restructure headings so each level nests under the previous one.",
  "Word count": "Add substantive server-rendered copy — aim for 300+ words of unique, useful text in the initial HTML (not injected by JS).",
  "Image alt coverage": 'Give every content <img> a descriptive alt="…"; purely decorative images get alt="".',
  "Internal links": "Add 5+ contextual internal links with descriptive anchor text to related pages — they distribute authority and speed up crawl discovery.",
  "Outbound links": "Link to 1–2 authoritative external sources — a content-quality/trust signal.",
  "Image dimensions set": 'Add explicit width and height attributes (or CSS aspect-ratio) to every <img> so the browser reserves space — prevents layout shift (CLS).',
  "Lazy loading": 'Add loading="lazy" to below-the-fold images (keep the hero/LCP image eager).',
  "Modern image formats": 'Serve WebP/AVIF via <picture><source type="image/avif"> or an image CDN — cuts image weight 25–50%.',
  "Text-to-HTML ratio": "Reduce markup bloat (inlined JSON state, deep wrapper divs, inline SVG/CSS) or add more real text content.",
  "HTTPS": "Serve over HTTPS with a valid certificate and 301-redirect all http:// URLs to https://.",
  "HTTP status": "Make the page respond 200; collapse redirect chains to one hop and never serve content on 4xx/5xx.",
  "Compression": "Enable Brotli (preferred) or gzip for text responses at the server/CDN — e.g. nginx: brotli on; gzip on;",
  "Cache-Control policy": 'Set an explicit Cache-Control on the document, e.g. "public, s-maxage=3600, stale-while-revalidate=86400" for CDN-cached pages.',
  "TTFB": "Cut server think-time: cache/pre-render HTML at a CDN edge, cache DB queries, or move the route to SSG/ISR.",
  "HTML document size": "Slim the document: remove inlined data blobs, defer non-critical markup, paginate very long pages (target <100 KB HTML).",
  "robots.txt": "Add robots.txt at the site root — at minimum: User-agent: * / Allow: / plus a Sitemap: line.",
  "XML sitemap": "Generate an XML sitemap (your framework likely has a plugin), serve it at /sitemap.xml, and declare it in robots.txt (Sitemap: https://your-domain.com/sitemap.xml).",
  "HSTS": "Send Strict-Transport-Security: max-age=31536000; includeSubDomains on HTTPS responses.",
  "Security headers": "Add Content-Security-Policy, X-Content-Type-Options: nosniff, X-Frame-Options: SAMEORIGIN, and Referrer-Policy: strict-origin-when-cross-origin at the server/CDN.",
  "First Contentful Paint": "Inline critical CSS, preload key fonts (font-display: swap), defer non-critical JS, and reduce TTFB.",
  "Largest Contentful Paint": 'Preload the hero image (<link rel="preload" as="image">), serve it in AVIF/WebP at the rendered size, never lazy-load it, and cut render-blocking resources.',
  "og:title": 'Add <meta property="og:title" content="Page title for sharing">.',
  "og:description": 'Add <meta property="og:description" content="1–2 sentence share description">.',
  "og:image": 'Add <meta property="og:image" content="https://…/share-card.png"> at 1200×630px — without it, shared links get no preview card.',
  "twitter:card": 'Add <meta name="twitter:card" content="summary_large_image">.',
  "Content in initial HTML": "Server-render the main content (switch the route to SSG/SSR/ISR or pre-render at build time) so crawlers and link-preview bots get real HTML without executing JS.",
  "noscript fallback": "Best fix is server-rendering the content; as a stopgap add a <noscript> block carrying the core content and links.",
  "Crawlable (robots.txt)": "Remove `Disallow: /` from robots.txt (or scope it to private paths only) — right now the whole site is blocked from crawling.",
  "API calls after load": "Fetch data during server rendering / at build time instead of in the browser; batch the remaining client calls.",
  "Edge/cache delivery": "Put a CDN in front and make the HTML cacheable (s-maxage / stale-while-revalidate) so pages are served from edge cache.",
  "Readability (Flesch)": "Shorten sentences (≤20 words average), prefer common words, and break dense paragraphs with subheadings and lists.",
  "Descriptive anchor text": 'Replace "click here"/"read more" with anchors describing the target page, e.g. "compare SSG vs SSR rendering".',
  "Keyword density": "Use the focus keyword naturally at ~0.5–3% of the text: intro, one H2, a few body mentions; add synonyms instead of repeating it.",
};

const KW_FIX_PATTERNS = [
  [/" in title$/, "Put the focus keyword near the start of the <title> tag."],
  [/" in H1$/, "Include the focus keyword in the single <h1>."],
  [/" in meta description$/, "Work the focus keyword into the meta description — Google bolds it in the snippet."],
  [/" in URL$/, "Use the hyphenated keyword as (or in) the URL slug; 301-redirect the old URL if it already ranks."],
  [/" in opening copy$/, "Mention the focus keyword within the first ~100 words of the body copy."],
];

function fixFor(label) {
  if (FIX_HINTS[label]) return FIX_HINTS[label];
  for (const [re, fix] of KW_FIX_PATTERNS) if (re.test(label)) return fix;
  return null;
}

function meta(doc, name) {
  const el =
    doc.querySelector(`meta[name="${name}" i]`) ||
    doc.querySelector(`meta[property="${name}" i]`);
  return el ? (el.getAttribute("content") || "").trim() : null;
}

function looksLikeShell(doc, textLen) {
  if (textLen >= 250) return false;
  const body = doc.body;
  if (!body) return true;
  const realChildren = [...body.children].filter(
    (el) => !/^(SCRIPT|NOSCRIPT|STYLE|LINK|TEMPLATE)$/.test(el.tagName)
  );
  if (realChildren.length > 4) return false;
  const shellIds = /^(root|app|__next|__nuxt|app-root|main|q-app)$/i;
  return (
    realChildren.length === 0 ||
    realChildren.some(
      (el) => shellIds.test(el.id) && el.textContent.trim().length < 250
    ) ||
    textLen < 100
  );
}

// ---------- framework detection ----------

function detectFramework(rawHtml, doc) {
  const h = rawHtml;
  const gen = (meta(doc, "generator") || "").toLowerCase();
  const found = [];
  const add = (name, signal) => found.push({ name, signal });

  if (/__NEXT_DATA__|\/_next\//.test(h)) add("Next.js", "__NEXT_DATA__ / /_next/ assets");
  if (/__NUXT__|\/_nuxt\//.test(h)) add("Nuxt", "__NUXT__ / /_nuxt/ assets");
  if (/___gatsby|gatsby-/.test(h)) add("Gatsby", "___gatsby root / gatsby- classes");
  if (/<astro-island|astro-route/.test(h) || gen.includes("astro")) add("Astro", "astro-island elements");
  if (/__remixContext/.test(h)) add("Remix", "__remixContext state blob");
  if (/__sveltekit|data-sveltekit/.test(h)) add("SvelteKit", "__sveltekit globals");
  if (doc.querySelector("[ng-version]")) add("Angular", "ng-version attribute");
  if (/wp-content\/|wp-includes\//.test(h) || gen.includes("wordpress")) add("WordPress", "wp-content asset paths");
  if (gen.includes("hugo")) add("Hugo", "meta generator");
  if (gen.includes("jekyll")) add("Jekyll", "meta generator");
  if (gen.includes("drupal")) add("Drupal", "meta generator");
  if (/cdn\.shopify\.com|Shopify\.theme/.test(h)) add("Shopify", "Shopify assets");
  if (/static\.wixstatic\.com|wix-code/.test(h)) add("Wix", "Wix assets");
  if (/squarespace\.com\/universal|Static\.SQUARESPACE/.test(h)) add("Squarespace", "Squarespace assets");
  if (
    found.length === 0 &&
    (/data-reactroot|react-dom|react\.production/.test(h))
  )
    add("React (custom setup)", "React runtime references");
  if (found.length === 0 && /data-v-[0-9a-f]{6,}|vue\.runtime|__VUE__/.test(h))
    add("Vue (custom setup)", "Vue scoped attrs / runtime");
  if (found.length === 0 && gen) add(gen, "meta generator");

  return found;
}

// ---------- rendering strategy detection ----------

function detectRendering({ rawHtml, doc, headers, live, text }) {
  const hd = headers || {};
  const signals = [];
  const textLen = (text != null ? text : visibleText(doc)).length;
  const shell = looksLikeShell(doc, textLen);
  const frameworks = detectFramework(rawHtml, doc);
  const fwNames = frameworks.map((f) => f.name);

  const cc = (hd["cache-control"] || "").toLowerCase();
  const age = parseInt(hd["age"] || "", 10);
  const cfStatus = (hd["cf-cache-status"] || "").toUpperCase();
  const vercelCache = (hd["x-vercel-cache"] || hd["x-nextjs-cache"] || "").toUpperCase();
  const xCache = (hd["x-cache"] || "").toUpperCase();
  const server = (hd["server"] || "").toLowerCase();
  const swr = /stale-while-revalidate/.test(cc);
  const cdnHit =
    cfStatus === "HIT" ||
    vercelCache === "HIT" ||
    /\bHIT\b/.test(xCache) ||
    (Number.isFinite(age) && age > 0);

  let verdict = null;
  let confidence = "low";

  // Highest-confidence path: Next.js tells us directly.
  const nextDataMatch = rawHtml.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (nextDataMatch) {
    try {
      const nd = JSON.parse(nextDataMatch[1]);
      if (nd.gssp) {
        verdict = "SSR";
        confidence = "high";
        signals.push("__NEXT_DATA__.gssp = true → getServerSideProps (SSR)");
      } else if (nd.gip) {
        verdict = "SSR";
        confidence = "high";
        signals.push("__NEXT_DATA__.gip = true → getInitialProps (SSR)");
      } else if (nd.gsp) {
        if (vercelCache === "STALE" || vercelCache === "REVALIDATED" || swr) {
          verdict = "ISR";
          confidence = "high";
          signals.push(
            "__NEXT_DATA__.gsp = true + " +
              (swr ? "stale-while-revalidate" : "x-vercel-cache: " + vercelCache) +
              " → Incremental Static Regeneration"
          );
        } else {
          verdict = "SSG";
          confidence = "high";
          signals.push("__NEXT_DATA__.gsp = true → getStaticProps (SSG, possibly ISR)");
        }
      } else if (!shell) {
        verdict = "SSG";
        confidence = "medium";
        signals.push("Next.js page pre-rendered with no data-fetching flags → static");
      }
    } catch (e) {
      signals.push("__NEXT_DATA__ present but unparseable");
    }
  }

  if (!verdict && shell) {
    verdict = "CSR";
    confidence = textLen < 100 ? "high" : "medium";
    signals.push(
      `Initial HTML is a shell (${textLen} chars of visible text) — content is built by JavaScript in the browser`
    );
  }

  if (!verdict) {
    // Server-delivered content: static vs dynamic via cache behavior.
    signals.push(`Initial HTML already contains content (${textLen} chars visible text)`);
    if (vercelCache === "STALE" || vercelCache === "REVALIDATED") {
      verdict = "ISR";
      confidence = "high";
      signals.push("x-vercel-cache: " + vercelCache + " — page revalidates in the background (ISR)");
    } else if (swr && cdnHit) {
      verdict = "ISR";
      confidence = "medium";
      signals.push("stale-while-revalidate + CDN cache hit — ISR-style regeneration");
    } else if (/no-store|no-cache|private/.test(cc) || hd["set-cookie"]) {
      verdict = "SSR";
      confidence = "medium";
      signals.push(`Cache-Control "${cc || "absent"}"${hd["set-cookie"] ? " + Set-Cookie" : ""} — generated per request`);
    } else if (cdnHit) {
      verdict = "SSG";
      confidence = "medium";
      signals.push(
        "Served from CDN cache (" +
          (cfStatus ? "cf-cache-status: " + cfStatus : Number.isFinite(age) && age > 0 ? "Age: " + age : "cache HIT") +
          ") — static or edge-cached delivery"
      );
    } else if (/netlify|github\.com|amazons3|vercel|cloudflare/.test(server) && !hd["x-powered-by"]) {
      verdict = "SSG";
      confidence = "low";
      signals.push(`Static-host server header ("${server}") with no app-server fingerprint`);
    } else {
      verdict = "SSR";
      confidence = "low";
      signals.push("Full HTML with no cache-hit evidence — most likely rendered per request (SSR); could be uncached SSG");
    }
  }

  // Hydration: server HTML + client framework runtime / state blob
  let hydration = false;
  if (verdict !== "CSR") {
    hydration =
      /__NEXT_DATA__|self\.__next_f|__NUXT__|__remixContext|__sveltekit|window\.__INITIAL_STATE__|astro-island/.test(rawHtml) ||
      !!(live && live.globals && Object.values(live.globals).some(Boolean));
    if (hydration)
      signals.push("Serialized state blob shipped with the HTML — page hydrates into an interactive app");
  }

  if (fwNames.length)
    signals.push("Framework: " + frameworks.map((f) => `${f.name} (${f.signal})`).join("; "));

  if (live && typeof live.domTextLength === "number") {
    const grew = live.domTextLength - textLen;
    if (verdict === "CSR" && grew > 500)
      signals.push(`Live DOM has ${live.domTextLength} chars vs ${textLen} in source — content injected client-side (confirms CSR)`);
    if (verdict !== "CSR" && grew > textLen * 2 && grew > 2000)
      signals.push("Live DOM is much larger than the server HTML — significant client-side augmentation");
  }

  return {
    verdict,
    confidence,
    framework: fwNames.join(", ") || "Not detected",
    hydration,
    signals,
    textLen,
    shell,
  };
}

// ---------- category checks ----------

function analyzePage(input) {
  const { url, rawHtml, doc, headers, timing, live, apiCount, status, robots, focusKeyword } = input;
  const hd = {};
  for (const k of Object.keys(headers || {})) hd[k.toLowerCase()] = headers[k];

  const cats = {};
  for (const id of Object.keys(SEO_WEIGHTS))
    cats[id] = { id, name: CATEGORY_NAMES[id], weight: SEO_WEIGHTS[id], checks: [] };

  const add = (cat, label, statusV, points, max, detail) => {
    const check = { label, status: statusV, points, max, detail };
    if (statusV === "fail" || statusV === "warn") {
      const fix = fixFor(label);
      if (fix) check.fix = fix;
    }
    cats[cat].checks.push(check);
  };

  const text = visibleText(doc);
  const toks = tokenize(text);
  const words = text ? text.split(/\s+/).length : 0;
  const rendering = detectRendering({ rawHtml, doc, headers: hd, live, text });

  // ----- META -----
  const title = (doc.querySelector("title") || {}).textContent?.trim() || "";
  if (!title) add("meta", "Title tag", "fail", 0, 15, "No <title> — the single most important on-page signal is missing.");
  else if (title.length >= 30 && title.length <= 60)
    add("meta", "Title tag", "pass", 15, 15, `"${title.slice(0, 70)}" (${title.length} chars — ideal 30–60)`);
  else
    add("meta", "Title tag", "warn", 8, 15, `${title.length} chars — outside the 30–60 range; may be truncated or too thin in SERPs.`);

  const desc = meta(doc, "description");
  if (!desc) add("meta", "Meta description", "fail", 0, 15, "Missing — search engines will improvise a snippet.");
  else if (desc.length >= 70 && desc.length <= 160)
    add("meta", "Meta description", "pass", 15, 15, `${desc.length} chars (ideal 70–160).`);
  else add("meta", "Meta description", "warn", 8, 15, `${desc.length} chars — outside the 70–160 range.`);

  const canonical = doc.querySelector('link[rel="canonical" i]');
  add("meta", "Canonical URL", canonical ? "pass" : "warn", canonical ? 10 : 0, 10,
    canonical ? canonical.getAttribute("href") : "No rel=canonical — duplicate-content risk on parameterized URLs.");

  if (canonical) {
    let same = true, canonHref = canonical.getAttribute("href") || "";
    try {
      const c = new URL(canonHref, url), u = new URL(url);
      same = c.hostname.replace(/^www\./, "") === u.hostname.replace(/^www\./, "") &&
             c.pathname.replace(/\/$/, "") === u.pathname.replace(/\/$/, "");
    } catch (e) {}
    add("meta", "Canonical matches URL", same ? "pass" : "warn", same ? 4 : 0, 4,
      same ? "Canonical is self-referencing." : `Points elsewhere (${canonHref}) — this page defers its ranking signals to that URL.`);
  }

  try {
    const u = new URL(url);
    const issues = [];
    if (url.length > 115) issues.push("longer than 115 chars");
    if (/[A-Z]/.test(u.pathname)) issues.push("uppercase in path");
    if (/_/.test(u.pathname)) issues.push("underscores (use hyphens)");
    if ([...u.searchParams.keys()].length > 2) issues.push("many query parameters");
    if (u.pathname.split("/").filter(Boolean).length > 5) issues.push("deeply nested");
    add("meta", "URL quality", issues.length === 0 ? "pass" : issues.length === 1 ? "warn" : "fail",
      issues.length === 0 ? 6 : issues.length === 1 ? 3 : 0, 6,
      issues.length ? issues.join("; ") + "." : "Short, lowercase, hyphenated, shallow — clean URL.");
  } catch (e) {}

  const hreflangs = doc.querySelectorAll('link[rel="alternate" i][hreflang]');
  if (hreflangs.length)
    add("meta", "Hreflang", "pass", 4, 4, `${hreflangs.length} language/region alternates declared.`);
  else
    add("meta", "Hreflang", "info", 0, 0, "None — only relevant for multi-language sites.");

  const robotsMeta = (meta(doc, "robots") || "").toLowerCase();
  const xRobots = (hd["x-robots-tag"] || "").toLowerCase();
  const noindex = robotsMeta.includes("noindex") || xRobots.includes("noindex");
  add("meta", "Indexable (no noindex)", noindex ? "fail" : "pass", noindex ? 0 : 10, 10,
    noindex ? `Blocked from indexing (${robotsMeta || xRobots}).` : "Page is allowed to be indexed.");

  const viewport = meta(doc, "viewport");
  add("meta", "Mobile viewport", viewport ? "pass" : "fail", viewport ? 10 : 0, 10,
    viewport || "No viewport meta — fails mobile-friendliness checks.");

  const lang = doc.documentElement.getAttribute("lang");
  add("meta", "html lang attribute", lang ? "pass" : "warn", lang ? 8 : 0, 8,
    lang ? `lang="${lang}"` : "Missing — hurts international targeting and accessibility.");

  const charset =
    doc.querySelector("meta[charset], meta[http-equiv='Content-Type' i]") ||
    /<meta[^>]+charset/i.test(rawHtml);
  add("meta", "Charset declared", charset ? "pass" : "warn", charset ? 4 : 0, 4,
    charset ? "Explicit charset present." : "No charset meta.");

  const favicon = doc.querySelector('link[rel~="icon" i]');
  add("meta", "Favicon", favicon ? "pass" : "warn", favicon ? 4 : 0, 4,
    favicon ? "Declared." : "No favicon link (Google shows favicons in mobile SERPs).");

  const jsonLd = doc.querySelectorAll('script[type="application/ld+json"]');
  let ldTypes = [];
  jsonLd.forEach((s) => {
    try {
      const j = JSON.parse(s.textContent);
      const collect = (o) => o && (Array.isArray(o) ? o.forEach(collect) : o["@type"] && ldTypes.push(o["@type"]));
      collect(j);
      collect(j["@graph"]);
    } catch (e) {}
  });
  add("meta", "Structured data (JSON-LD)", jsonLd.length ? "pass" : "warn", jsonLd.length ? 10 : 0, 10,
    jsonLd.length ? `${jsonLd.length} block(s): ${[...new Set(ldTypes.flat())].slice(0, 5).join(", ") || "types unparsed"}` : "None — missing rich-result eligibility (Article, Product, FAQ…).");

  // ----- CONTENT -----
  const h1s = doc.querySelectorAll("h1");
  if (h1s.length === 1)
    add("content", "Single H1", "pass", 15, 15, `"${h1s[0].textContent.trim().slice(0, 80)}"`);
  else if (h1s.length === 0)
    add("content", "Single H1", "fail", 0, 15, "No H1 in the initial HTML.");
  else add("content", "Single H1", "warn", 8, 15, `${h1s.length} H1s — dilutes the primary topic signal.`);

  const hs = [...doc.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => +h.tagName[1]);
  let skipped = false;
  for (let i = 1; i < hs.length; i++) if (hs[i] - hs[i - 1] > 1) skipped = true;
  add("content", "Heading hierarchy", hs.length === 0 ? "warn" : skipped ? "warn" : "pass",
    hs.length && !skipped ? 10 : 4, 10,
    hs.length === 0 ? "No headings at all." : skipped ? "Levels are skipped (e.g. H1 → H3)." : `${hs.length} headings, properly nested.`);

  if (words >= 300) add("content", "Word count", "pass", 15, 15, `${words} words of visible text in the initial HTML.`);
  else if (words >= 120) add("content", "Word count", "warn", 8, 15, `${words} words — thin for a content page (aim ≥300).`);
  else add("content", "Word count", "fail", 0, 15, `${words} words in the initial HTML — crawlers that don't execute JS see almost nothing.`);

  const imgs = [...doc.querySelectorAll("img")];
  const withAlt = imgs.filter((i) => (i.getAttribute("alt") || "").trim().length > 0).length;
  if (imgs.length === 0) add("content", "Image alt coverage", "pass", 12, 12, "No <img> elements to check.");
  else {
    const pct = Math.round((withAlt / imgs.length) * 100);
    add("content", "Image alt coverage", pct >= 90 ? "pass" : pct >= 60 ? "warn" : "fail",
      pct >= 90 ? 12 : pct >= 60 ? 6 : 0, 12, `${withAlt}/${imgs.length} images have alt text (${pct}%).`);
  }

  let host = "";
  try { host = new URL(url).hostname; } catch (e) {}
  const links = [...doc.querySelectorAll("a[href]")];
  const internalHrefs = [];
  for (const a of links) {
    const href = a.getAttribute("href") || "";
    if (href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) continue;
    try {
      const abs = new URL(href, url);
      if (abs.hostname === host) internalHrefs.push(abs.href.split("#")[0]);
    } catch (e) {}
  }
  const internal = internalHrefs.length;
  const external = links.filter((a) => {
    try { return new URL(a.getAttribute("href") || "", url).hostname !== host; } catch (e) { return false; }
  }).length;
  const linkSample = [...new Set(internalHrefs)].filter((h) => h !== url).slice(0, 15);
  add("content", "Internal links", internal >= 5 ? "pass" : internal >= 1 ? "warn" : "fail",
    internal >= 5 ? 10 : internal >= 1 ? 5 : 0, 10, `${internal} internal links in the initial HTML.`);
  add("content", "Outbound links", external >= 1 ? "pass" : "warn", external >= 1 ? 4 : 0, 4,
    `${external} external links.`);

  if (imgs.length) {
    const withDims = imgs.filter((i) => i.getAttribute("width") && i.getAttribute("height")).length;
    const dimsPct = Math.round((withDims / imgs.length) * 100);
    add("content", "Image dimensions set", dimsPct >= 80 ? "pass" : dimsPct >= 40 ? "warn" : "fail",
      dimsPct >= 80 ? 6 : dimsPct >= 40 ? 3 : 0, 6,
      `${withDims}/${imgs.length} images declare width/height (${dimsPct}%) — missing ones cause layout shift (CLS).`);

    if (imgs.length > 5) {
      const lazy = imgs.filter((i) => (i.getAttribute("loading") || "").toLowerCase() === "lazy").length;
      add("content", "Lazy loading", lazy ? "pass" : "warn", lazy ? 4 : 0, 4,
        lazy ? `${lazy} images use loading="lazy".` : `${imgs.length} images, none lazy-loaded — offscreen images delay LCP.`);
    }

    const modern =
      /\.(webp|avif)(["'?\s])/i.test(rawHtml) || /<source[^>]+type=["']image\/(webp|avif)/i.test(rawHtml);
    add("content", "Modern image formats", modern ? "pass" : "warn", modern ? 4 : 0, 4,
      modern ? "WebP/AVIF in use." : "No WebP/AVIF detected — modern formats cut image weight 25–50%.");
  }

  const htmlBytes = new Blob([rawHtml]).size;
  const ratio = htmlBytes ? Math.round((text.length / htmlBytes) * 100) : 0;
  add("content", "Text-to-HTML ratio", ratio >= 10 ? "pass" : ratio >= 4 ? "warn" : "fail",
    ratio >= 10 ? 8 : ratio >= 4 ? 4 : 0, 8, `${ratio}% (${text.length} chars of text in ${Math.round(htmlBytes / 1024)} KB of HTML).`);

  // ----- TECHNICAL -----
  const https = url.startsWith("https:");
  add("technical", "HTTPS", https ? "pass" : "fail", https ? 12 : 0, 12,
    https ? "Secure." : "Served over plain HTTP — ranking and trust penalty.");

  if (status != null)
    add("technical", "HTTP status", status === 200 ? "pass" : "warn", status === 200 ? 8 : 0, 8, `Responded ${status}.`);
  else add("technical", "HTTP status", "info", 0, 0, "Not observable for this request.");

  const enc = (hd["content-encoding"] || "").toLowerCase();
  if (enc.includes("br") || enc.includes("gzip") || enc.includes("zstd"))
    add("technical", "Compression", "pass", 10, 10, `content-encoding: ${enc}`);
  else if (hd["content-encoding"] !== undefined)
    add("technical", "Compression", "fail", 0, 10, "HTML served uncompressed.");
  else add("technical", "Compression", "info", 0, 0, "Header not exposed to the extension (browser may have decoded it transparently).");

  const cc2 = hd["cache-control"];
  add("technical", "Cache-Control policy", cc2 ? "pass" : "warn", cc2 ? 8 : 0, 8,
    cc2 ? `"${cc2}"` : "No Cache-Control on the document.");

  const cdnSignals = [];
  if (hd["cf-ray"] || hd["cf-cache-status"]) cdnSignals.push("Cloudflare");
  if (hd["x-vercel-id"] || hd["x-vercel-cache"]) cdnSignals.push("Vercel Edge");
  if (/fastly/.test(hd["x-served-by"] || "") || hd["fastly-debug-digest"]) cdnSignals.push("Fastly");
  if (/akamai/i.test(hd["server"] || "") || hd["x-akamai-transformed"]) cdnSignals.push("Akamai");
  if (/cloudfront/i.test(hd["via"] || "") || /cloudfront/i.test(hd["x-cache"] || "")) cdnSignals.push("CloudFront");
  if (/netlify/i.test(hd["server"] || "")) cdnSignals.push("Netlify");
  add("technical", "CDN in front", cdnSignals.length ? "pass" : "info", cdnSignals.length ? 6 : 0, cdnSignals.length ? 6 : 0,
    cdnSignals.length ? cdnSignals.join(", ") : "No CDN fingerprint in headers.");

  const ttfb = timing && timing.ttfb != null ? Math.round(timing.ttfb) : null;
  if (ttfb != null)
    add("technical", "TTFB", ttfb < 300 ? "pass" : ttfb < 800 ? "warn" : "fail",
      ttfb < 300 ? 12 : ttfb < 800 ? 6 : 0, 12,
      `${ttfb} ms to first byte${ttfb < 300 ? " — fast (static/edge-grade)" : ttfb < 800 ? " — acceptable" : " — slow; origin doing heavy work per request"}.`);
  else add("technical", "TTFB", "info", 0, 0, "No timing captured.");

  const kb = Math.round(htmlBytes / 1024);
  add("technical", "HTML document size", kb < 100 ? "pass" : kb < 300 ? "warn" : "fail",
    kb < 100 ? 8 : kb < 300 ? 4 : 0, 8, `${kb} KB of HTML.`);

  if (robots) {
    add("technical", "robots.txt", robots.exists ? "pass" : "warn", robots.exists ? 4 : 0, 4,
      robots.exists ? "Present at the site root." : "No robots.txt — crawlers get no crawl guidance.");
    add("technical", "XML sitemap", robots.sitemap ? "pass" : "warn", robots.sitemap ? 6 : 0, 6,
      robots.sitemap
        ? robots.sitemapVia === "robots" ? "Declared in robots.txt." : "Found at /sitemap.xml."
        : "Not declared in robots.txt and no /sitemap.xml — slower discovery of your pages.");
  }

  add("technical", "HSTS", hd["strict-transport-security"] ? "pass" : "info",
    hd["strict-transport-security"] ? 4 : 0, hd["strict-transport-security"] ? 4 : 0,
    hd["strict-transport-security"] ? hd["strict-transport-security"] : "No Strict-Transport-Security header.");

  const secHeaders = ["content-security-policy", "x-content-type-options", "x-frame-options", "referrer-policy"];
  const secPresent = secHeaders.filter((h) => hd[h]);
  add("technical", "Security headers", secPresent.length >= 3 ? "pass" : secPresent.length >= 1 ? "warn" : "fail",
    secPresent.length >= 3 ? 6 : secPresent.length >= 1 ? 3 : 0, 6,
    secPresent.length
      ? `${secPresent.length}/4 present: ${secPresent.join(", ")}.`
      : "None of CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy — a trust/best-practices signal.");

  if (live) {
    if (live.fcp != null)
      add("technical", "First Contentful Paint", live.fcp < 1800 ? "pass" : live.fcp < 3000 ? "warn" : "fail",
        live.fcp < 1800 ? 6 : live.fcp < 3000 ? 3 : 0, 6, `${Math.round(live.fcp)} ms (good < 1800).`);
    if (live.lcp != null)
      add("technical", "Largest Contentful Paint", live.lcp < 2500 ? "pass" : live.lcp < 4000 ? "warn" : "fail",
        live.lcp < 2500 ? 6 : live.lcp < 4000 ? 3 : 0, 6, `${Math.round(live.lcp)} ms (good < 2500).`);
  }

  // ----- SOCIAL -----
  const og = (p) => meta(doc, "og:" + p);
  add("social", "og:title", og("title") ? "pass" : "warn", og("title") ? 5 : 0, 5, og("title") || "Missing.");
  add("social", "og:description", og("description") ? "pass" : "warn", og("description") ? 5 : 0, 5, og("description") ? "Present." : "Missing.");
  add("social", "og:image", og("image") ? "pass" : "fail", og("image") ? 10 : 0, 10,
    og("image") || "Missing — links shared to social/chat apps get no preview card.");
  const tw = meta(doc, "twitter:card");
  add("social", "twitter:card", tw ? "pass" : "warn", tw ? 5 : 0, 5, tw || "Missing.");

  // ----- RENDERING & INDEXABILITY -----
  if (!rendering.shell && words >= 120)
    add("rendering", "Content in initial HTML", "pass", 25, 25,
      "Main content is server-delivered — visible to every crawler without JS execution.");
  else if (!rendering.shell)
    add("rendering", "Content in initial HTML", "warn", 12, 25,
      "Some content is server-delivered but the page is thin before JavaScript runs.");
  else
    add("rendering", "Content in initial HTML", "fail", 0, 25,
      "Initial HTML is an empty app shell — non-Google crawlers and link-preview bots see a blank page.");

  add("rendering", "Rendering strategy", "info", 0, 0,
    `${rendering.verdict} (${rendering.confidence} confidence) — ${rendering.signals[0] || ""}`);

  if (rendering.verdict !== "CSR")
    add("rendering", "Hydration", "info", 0, 0,
      rendering.hydration ? "Server HTML hydrates into a client app (best of both)." : "Plain server HTML, no client-side app state detected.");

  if (rendering.shell) {
    const noscript = doc.querySelector("noscript");
    add("rendering", "noscript fallback", noscript ? "warn" : "fail", noscript ? 3 : 0, 6,
      noscript ? "Has a <noscript> fallback, but real content should be server-rendered." : "No fallback for non-JS agents.");
  }

  const cacheStat = hd["cf-cache-status"] || hd["x-vercel-cache"] || hd["x-cache"] || (hd["age"] ? "Age: " + hd["age"] : null);
  if (cacheStat)
    add("rendering", "Edge/cache delivery", /hit|stale|revalidated|\d/i.test(cacheStat) ? "pass" : "warn",
      /hit|stale|revalidated/i.test(cacheStat) || parseInt(hd["age"] || "0", 10) > 0 ? 9 : 4, 9,
      `${cacheStat} — ${/hit|stale/i.test(cacheStat) ? "served from cache; fast and crawl-budget friendly" : "generated at origin for this request"}.`);
  else add("rendering", "Edge/cache delivery", "info", 0, 0, "No cache-status headers exposed.");

  if (robots && robots.disallowAll)
    add("rendering", "Crawlable (robots.txt)", "fail", 0, 15,
      "robots.txt has `Disallow: /` for all user-agents — the entire site is blocked from crawling.");

  if (apiCount != null)
    add("rendering", "API calls after load", apiCount <= 3 ? "pass" : apiCount <= 10 ? "warn" : "fail",
      apiCount <= 3 ? 6 : apiCount <= 10 ? 3 : 0, 6,
      `${apiCount} XHR/fetch requests observed — ${apiCount <= 3 ? "content doesn't depend on client data-fetching" : "page leans on client-side data fetching"}.`);

  // ----- KEYWORDS & READABILITY -----
  const kwData = topKeywords(text, toks);
  const flesch = fleschScore(text, toks);

  if (flesch != null)
    add("keywords", "Readability (Flesch)", flesch >= 50 ? "pass" : flesch >= 30 ? "warn" : "fail",
      flesch >= 50 ? 10 : flesch >= 30 ? 5 : 0, 10,
      `${flesch} — ${flesch >= 70 ? "easy to read" : flesch >= 50 ? "fairly readable" : flesch >= 30 ? "difficult (college-level)" : "very difficult"} (English-calibrated).`);
  else
    add("keywords", "Readability (Flesch)", "info", 0, 0, "Not enough text in the initial HTML to score.");

  const anchorTexts = links.map((a) => (a.textContent || "").trim().toLowerCase()).filter(Boolean);
  const generic = anchorTexts.filter((t) => /^(click here|here|read more|learn more|more|link|this)$/.test(t)).length;
  if (anchorTexts.length)
    add("keywords", "Descriptive anchor text", generic === 0 ? "pass" : generic <= 2 ? "warn" : "fail",
      generic === 0 ? 6 : generic <= 2 ? 3 : 0, 6,
      generic ? `${generic} generic anchors ("click here"/"read more") — they pass no topical signal.` : "No generic anchors.");

  add("keywords", "Top keywords", "info", 0, 0,
    kwData.top.length
      ? kwData.top.map((k) => `${k.term} (${k.count}×, ${k.density}%)`).join(", ") +
        (kwData.phrases.length ? " · phrases: " + kwData.phrases.map((p) => `"${p.term}" (${p.count}×)`).join(", ") : "")
      : "No extractable text.");

  if (focusKeyword) {
    const kw = focusKeyword.trim().toLowerCase();
    const kwSlug = kw.replace(/\s+/g, "-");
    const lcText = text.toLowerCase();
    const inStr = (s) => (s || "").toLowerCase().includes(kw);

    add("keywords", `"${kw}" in title`, inStr(title) ? "pass" : "fail", inStr(title) ? 8 : 0, 8,
      inStr(title) ? "Present." : "Missing — the strongest keyword placement.");
    add("keywords", `"${kw}" in H1`, [...h1s].some((h) => inStr(h.textContent)) ? "pass" : "warn",
      [...h1s].some((h) => inStr(h.textContent)) ? 6 : 0, 6,
      [...h1s].some((h) => inStr(h.textContent)) ? "Present." : "Missing from the main heading.");
    add("keywords", `"${kw}" in meta description`, inStr(desc) ? "pass" : "warn", inStr(desc) ? 4 : 0, 4,
      inStr(desc) ? "Present (bolded in SERPs)." : "Missing.");
    let inUrl = false;
    try { inUrl = new URL(url).pathname.toLowerCase().includes(kwSlug) || new URL(url).pathname.toLowerCase().includes(kw.replace(/\s+/g, "")); } catch (e) {}
    add("keywords", `"${kw}" in URL`, inUrl ? "pass" : "warn", inUrl ? 4 : 0, 4,
      inUrl ? "Present in the path." : "Not in the URL slug.");
    const first100 = toks.slice(0, 100).join(" ");
    add("keywords", `"${kw}" in opening copy`, first100.includes(kw) ? "pass" : "warn",
      first100.includes(kw) ? 4 : 0, 4,
      first100.includes(kw) ? "Appears in the first ~100 words." : "Not in the first ~100 words.");
    const occurrences = kw ? lcText.split(kw).length - 1 : 0;
    const kwWords = kw.split(/\s+/).length;
    const density = kwData.totalWords ? +((occurrences * kwWords / kwData.totalWords) * 100).toFixed(2) : 0;
    add("keywords", "Keyword density", density >= 0.5 && density <= 3 ? "pass" : density > 3 ? "fail" : occurrences > 0 ? "warn" : "fail",
      density >= 0.5 && density <= 3 ? 6 : occurrences > 0 ? 3 : 0, 6,
      `${occurrences}× = ${density}% (target 0.5–3%${density > 3 ? " — over-optimization risk" : ""}).`);
  } else {
    add("keywords", "Focus keyword", "info", 0, 0,
      "Set a focus keyword in the compare form to score keyword targeting (title/H1/URL/density).");
  }

  // ----- scoring -----
  const categories = Object.values(cats).map((c) => {
    const max = c.checks.reduce((s, ch) => s + ch.max, 0);
    const pts = c.checks.reduce((s, ch) => s + ch.points, 0);
    return { ...c, score: max ? Math.round((pts / max) * 100) : 100 };
  });
  const overall = Math.round(
    categories.reduce((s, c) => s + c.score * c.weight, 0) /
      categories.reduce((s, c) => s + c.weight, 0)
  );

  return {
    url,
    overall,
    categories,
    rendering,
    linkSample,
    focusKeyword: focusKeyword || null,
    snippet: {
      title: title || (h1s[0] ? h1s[0].textContent.trim() : ""),
      desc: desc || text.slice(0, 180),
      ogTitle: og("title"),
      ogDesc: og("description"),
      ogImage: og("image"),
      siteName: meta(doc, "og:site_name"),
    },
  };
}

function gradeFor(score) {
  return score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";
}

// ---------- action plan: every fixable issue, ranked by score impact ----------

// Checks whose fix lives in server/CDN/deploy config rather than application
// code — surfaced as a separate "post-production" stage in plans and prompts.
const POST_PRODUCTION_LABELS = new Set([
  "HTTPS",
  "HTTP status",
  "Compression",
  "Cache-Control policy",
  "CDN in front",
  "TTFB",
  "HSTS",
  "Security headers",
  "Edge/cache delivery",
]);

// Classify each issue into a severity tier for prompt prioritization.
function classifySeverity(item) {
  if (item.status === "fail" && item.gain >= 5)
    return { level: "critical", emoji: "🔴", label: "CRITICAL" };
  if (item.status === "fail")
    return { level: "high", emoji: "🟠", label: "HIGH" };
  if (item.status === "warn" && item.gain >= 3)
    return { level: "medium", emoji: "🟡", label: "MEDIUM" };
  return { level: "low", emoji: "🔵", label: "LOW" };
}

// gain = how many overall points a full fix of this check recovers.
function actionPlan(result) {
  const items = [];
  for (const cat of result.categories) {
    const catMax = cat.checks.reduce((s, c) => s + c.max, 0) || 1;
    for (const ch of cat.checks) {
      if (ch.status !== "fail" && ch.status !== "warn") continue;
      const gain = +(((ch.max - ch.points) / catMax) * 100 * cat.weight).toFixed(1);
      items.push({
        category: cat.name,
        label: ch.label,
        status: ch.status,
        detail: ch.detail,
        fix: ch.fix || null,
        gain,
        stage: POST_PRODUCTION_LABELS.has(ch.label) ? "post" : "pre",
      });
    }
  }
  items.sort((a, b) =>
    a.status === b.status ? b.gain - a.gain : a.status === "fail" ? -1 : 1
  );
  return items;
}

// Same issues split into one compact standalone prompt per stage+category, so
// the user can hand an AI assistant one focused module at a time. Uses structured
// XML tags, framework-specific API hints, severity tiers, and a verification block.
function buildAiPromptModules(result) {
  const plan = actionPlan(result);
  const catScore = {};
  for (const c of result.categories) catScore[c.name] = c.score;
  const r = result.rendering;
  const fw = r.framework && r.framework !== "Not detected" ? r.framework : null;
  const apis = lookupFrameworkApis(fw);

  const groups = new Map();
  for (const it of plan) {
    const key = it.stage + "|" + it.category;
    if (!groups.has(key)) groups.set(key, { stage: it.stage, name: it.category, items: [] });
    groups.get(key).items.push(it);
  }

  return [...groups.values()]
    .map((g) => {
      const gain = +g.items.reduce((s, i) => s + i.gain, 0).toFixed(1);
      const stageLabel =
        g.stage === "pre" ? "pre-production (application code)" : "post-production (server/CDN/deploy config)";
      const lines = [
        `<role>Senior technical-SEO engineer${fw ? ` · ${fw} specialist` : ""}.</role>`,
        "",
        `<environment>`,
        `Score: page ${result.overall}/100, ${g.name} ${catScore[g.name]}/100. Fixing this module recovers up to +${gain} pts.`,
        `URL: ${result.url}`,
        `Stage: ${stageLabel}.` + (fw ? ` Framework: ${fw}.` : ""),
      ];
      if (apis) {
        lines.push(`Framework APIs: Metadata=${apis.metadata} | Images=${apis.image} | Head=${apis.head} | JSON-LD=${apis.jsonLd} | Config=${apis.config}`);
      }
      lines.push(`</environment>`, "");

      lines.push(`<constraints>`);
      lines.push(`Preserve the visible design and copy meaning — change only what each fix needs.`);
      if (apis) lines.push(`Use ${fw}'s idiomatic APIs (listed above), not raw HTML tags.`);
      lines.push(`Locate real files first — don't guess paths. If an item doesn't apply, say so.`);
      lines.push(`</constraints>`, "");

      lines.push(`<issues>`);
      g.items.forEach((it, i) => {
        const sev = classifySeverity(it);
        lines.push(`${i + 1}. ${sev.emoji} ${sev.label} ${it.label} (+${it.gain}pts) — ${it.detail}`);
        if (it.fix) lines.push(`   Fix: ${it.fix}`);
      });
      lines.push(`</issues>`, "");

      lines.push(`<verification>`);
      lines.push(
        (g.stage === "post"
          ? "If config lives outside this repo, output the exact snippets and say where they go. "
          : "") + "List every change made (or skipped, and why). Confirm each fix satisfies the issue's detail line above."
      );
      lines.push(`</verification>`);

      return { name: g.name, stage: g.stage, count: g.items.length, gain, items: g.items, prompt: lines.join("\n") };
    })
    .sort((a, b) => (a.stage === b.stage ? b.gain - a.gain : a.stage === "pre" ? -1 : 1));
}

// Full prompt for an AI coding assistant: structured with XML tags for clean
// parsing, framework-specific API references, severity tiers, chain-of-thought
// reasoning instructions, and a verification checklist.
function buildAiPrompt(result) {
  const plan = actionPlan(result);
  const r = result.rendering;
  const fw = r.framework && r.framework !== "Not detected" ? r.framework : null;
  const apis = lookupFrameworkApis(fw);

  const lines = [];

  // --- Role & Persona ---
  lines.push(`<role>`);
  lines.push(`You are a senior technical-SEO engineer${fw ? ` specializing in ${fw}` : ""}. You write production-grade, minimal, targeted fixes — no unnecessary refactors or new dependencies.`);
  lines.push(`</role>`);
  lines.push("");

  // --- Environment Context ---
  lines.push(`<environment>`);
  lines.push(`URL: ${result.url}`);
  lines.push(`Score: ${result.overall}/100 (${gradeFor(result.overall)})`);
  lines.push(`Categories: ${result.categories.map((c) => `${c.name} ${c.score}/100`).join(", ")}`);
  lines.push(`Rendering: ${r.verdict} (${r.confidence})${fw ? ` · ${fw}` : ""}${r.hydration ? " · hydrates" : ""}`);
  if (result.focusKeyword) lines.push(`Focus keyword: "${result.focusKeyword}"`);
  if (apis) {
    lines.push("");
    lines.push(`Framework API reference (use these, not generic HTML):`);
    lines.push(`  Metadata: ${apis.metadata}`);
    lines.push(`  Images: ${apis.image}`);
    lines.push(`  Head management: ${apis.head}`);
    lines.push(`  JSON-LD: ${apis.jsonLd}`);
    lines.push(`  Sitemap: ${apis.sitemap}`);
    lines.push(`  Server config: ${apis.config}`);
  }
  lines.push(`</environment>`);
  lines.push("");

  // --- Task ---
  lines.push(`<task>`);
  lines.push(`Fix every issue listed in <issues> directly in the source code. Target: 90+/100.`);
  lines.push(`</task>`);
  lines.push("");

  // --- Constraints ---
  lines.push(`<constraints>`);
  lines.push(`- Preserve the visible design and existing copy meaning`);
  lines.push(`- Change only what each fix requires — no unrelated refactors or new dependencies`);
  lines.push(`- Locate the real template/component before editing — never guess a file path`);
  lines.push(`- If a check doesn't apply or the codebase already handles it differently, say so`);
  if (apis) lines.push(`- Use ${fw}'s idiomatic APIs (listed above), not raw HTML tags`);
  lines.push(`</constraints>`);
  lines.push("");

  if (!plan.length) {
    lines.push("No failing or warning checks — nothing to fix.");
    return lines.join("\n");
  }

  // --- Reasoning Protocol ---
  lines.push(`<reasoning>`);
  lines.push(`For each fix, follow this chain:`);
  lines.push(`1. ANALYZE — what exactly is wrong and why it hurts the score`);
  lines.push(`2. LOCATE — find the real source file/component that controls this element`);
  lines.push(`3. PLAN — describe the minimal change needed`);
  lines.push(`4. IMPLEMENT — write the code change`);
  lines.push(`5. VERIFY — confirm the change satisfies the check's specific requirement`);
  lines.push(`</reasoning>`);
  lines.push("");

  // --- Issues ---
  lines.push(`<issues>`);
  lines.push("");

  const section = (stage, title, note) => {
    const items = plan.filter((p) => p.stage === stage);
    if (!items.length) return;
    lines.push(`## ${title}`, "");
    items.forEach((it, i) => {
      const sev = classifySeverity(it);
      lines.push(`${i + 1}. ${sev.emoji} ${sev.label} ${it.label} — ${it.category} (+${it.gain}pts)`);
      lines.push(`   Issue: ${it.detail}`);
      if (it.fix) lines.push(`   Fix: ${it.fix}`);
    });
    if (note) lines.push("", note);
    lines.push("");
  };
  section("pre", "Pre-production — fix in application code");
  section(
    "post",
    "Post-production — server / CDN / deploy config",
    "If config lives outside this repo, output the exact snippets and say where they go."
  );

  lines.push(`</issues>`);
  lines.push("");

  // --- Verification ---
  lines.push(`<verification>`);
  lines.push(`After all fixes, provide:`);
  lines.push(`1. A numbered list of every change made (file, what changed, which issue it fixes)`);
  lines.push(`2. Any issue you skipped and why`);
  lines.push(`3. Expected new score estimate per category`);
  lines.push(`4. Confirm each fix satisfies the detail line in <issues> — don't just claim "done"`);
  lines.push(`</verification>`);

  return lines.join("\n");
}

// ---------- competitive compare prompt ----------

function shortUrlForPrompt(url) {
  try { return new URL(url).hostname; } catch (e) { return url; }
}

// Generates a competitive-analysis prompt that shows what the winning URL(s)
// do differently, giving the AI concrete patterns to emulate.
function buildComparePrompt(results, targetUrl) {
  const target = results.find((r) => r.url === targetUrl);
  const others = results.filter((r) => r.url !== targetUrl);
  if (!target || !others.length) return buildAiPrompt(target || results[0]);

  const winner = [...results].sort((a, b) => b.overall - a.overall)[0];
  const r = target.rendering;
  const fw = r.framework && r.framework !== "Not detected" ? r.framework : null;
  const apis = lookupFrameworkApis(fw);

  const lines = [];

  lines.push(`<role>`);
  lines.push(`You are a senior technical-SEO engineer performing a competitive audit${fw ? ` on a ${fw} project` : ""}.`);
  lines.push(`</role>`);
  lines.push("");

  lines.push(`<environment>`);
  lines.push(`Target URL: ${target.url} — Score: ${target.overall}/100 (${gradeFor(target.overall)})`);
  lines.push(`Rendering: ${r.verdict} (${r.confidence})${fw ? ` · ${fw}` : ""}`);
  if (target.focusKeyword) lines.push(`Focus keyword: "${target.focusKeyword}"`);
  lines.push("");
  lines.push(`Competitor scores:`);
  for (const o of others) {
    lines.push(`  ${shortUrlForPrompt(o.url)}: ${o.overall}/100 (${o.rendering.verdict} · ${o.rendering.framework})`);
  }
  if (apis) {
    lines.push("");
    lines.push(`Framework APIs: Metadata=${apis.metadata} | Head=${apis.head} | Images=${apis.image} | JSON-LD=${apis.jsonLd} | Config=${apis.config}`);
  }
  lines.push(`</environment>`);
  lines.push("");

  // Build competitive insights — what competitors pass that the target fails.
  const gapLines = [];
  for (const cat of target.categories) {
    for (const o of others) {
      const oCat = o.categories.find((c) => c.id === cat.id);
      if (oCat && oCat.score > cat.score) {
        const targetChecks = new Map(cat.checks.map((ch) => [ch.label, ch]));
        const wins = oCat.checks
          .filter((ch) => ch.status === "pass" && targetChecks.has(ch.label) && targetChecks.get(ch.label).status !== "pass")
          .map((ch) => ch.label);
        if (wins.length) {
          gapLines.push(`${shortUrlForPrompt(o.url)} beats you on ${cat.name} (${oCat.score} vs ${cat.score}): passes ${wins.join(", ")}`);
        }
      }
    }
  }
  if (gapLines.length) {
    lines.push(`<competitive_gaps>`);
    gapLines.forEach((g) => lines.push(g));
    lines.push(`</competitive_gaps>`);
    lines.push("");
  }

  const plan = actionPlan(target);

  lines.push(`<task>`);
  lines.push(`Fix all issues below for ${target.url} to close the gap with competitors. Target: beat the highest competitor score (${winner.overall}/100).`);
  lines.push(`</task>`);
  lines.push("");

  lines.push(`<constraints>`);
  lines.push(`- Preserve the visible design and existing copy meaning`);
  lines.push(`- Change only what each fix requires — no unrelated refactors`);
  lines.push(`- Locate real source files before editing`);
  if (apis) lines.push(`- Use ${fw}'s idiomatic APIs`);
  lines.push(`</constraints>`);
  lines.push("");

  if (plan.length) {
    lines.push(`<issues>`);
    plan.forEach((it, i) => {
      const sev = classifySeverity(it);
      lines.push(`${i + 1}. ${sev.emoji} ${sev.label} [${it.stage}] ${it.label} — ${it.category} (+${it.gain}pts)`);
      lines.push(`   Issue: ${it.detail}`);
      if (it.fix) lines.push(`   Fix: ${it.fix}`);
    });
    lines.push(`</issues>`);
    lines.push("");
  }

  lines.push(`<verification>`);
  lines.push(`1. List every change made and which issue it fixes`);
  lines.push(`2. Any skipped items and why`);
  lines.push(`3. Predicted new score per category and whether it beats competitors`);
  lines.push(`</verification>`);

  return lines.join("\n");
}

// ---------- quick-fix list: condensed fix-only format ----------

// Minimal checklist — just the fix line for each issue, no XML or reasoning.
// Useful for pasting into a TODO or a quick AI chat.
function buildQuickFixList(result) {
  const plan = actionPlan(result);
  if (!plan.length) return "All checks pass — nothing to fix.";

  const fw = result.rendering.framework;
  const apis = lookupFrameworkApis(fw);

  const lines = [
    `Quick-fix checklist for ${result.url} (${result.overall}/100)${fw && fw !== "Not detected" ? ` · ${fw}` : ""}:`,
    "",
  ];

  plan.forEach((it) => {
    const sev = classifySeverity(it);
    lines.push(`${sev.emoji} ${it.label} (+${it.gain}pts): ${it.fix || it.detail}`);
  });

  if (apis) {
    lines.push("", `Use ${fw} APIs: ${apis.metadata} for meta, ${apis.image} for images, ${apis.jsonLd} for structured data.`);
  }

  return lines.join("\n");
}

// ---------- before/after diff between two audits of the same page ----------

function diffResults(prev, next) {
  const flat = (r) => {
    const m = {};
    for (const c of r.categories)
      for (const ch of c.checks)
        m[ch.label] = { status: ch.status, points: ch.points, max: ch.max, category: c.name };
    return m;
  };
  const a = flat(prev);
  const b = flat(next);
  const rank = { fail: 0, warn: 1, pass: 2 };

  const fixed = [], improved = [], regressed = [], added = [];
  let stillOpen = 0;
  for (const label of Object.keys(b)) {
    const nb = b[label];
    if (nb.status === "info") continue;
    const na = a[label];
    if (!na || na.status === "info") {
      if (nb.status !== "pass") added.push({ label, ...nb });
      continue;
    }
    const ra = rank[na.status], rb = rank[nb.status];
    if (rb > ra) (nb.status === "pass" ? fixed : improved).push({ label, ...nb, from: na.status });
    else if (rb < ra) regressed.push({ label, ...nb, from: na.status });
    else if (nb.status !== "pass") stillOpen++;
  }

  const categories = next.categories
    .map((c) => {
      const p = prev.categories.find((x) => x.id === c.id);
      return { name: c.name, before: p ? p.score : null, after: c.score, delta: p ? c.score - p.score : 0 };
    })
    .filter((c) => c.delta !== 0);

  return {
    before: prev.overall,
    after: next.overall,
    delta: next.overall - prev.overall,
    categories,
    fixed,
    improved,
    regressed,
    added,
    stillOpen,
  };
}
