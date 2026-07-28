#!/usr/bin/env node
// Sync generated SDK reference docs into the plugin's references/ tree.
//
// Pulls the live docs bundles from the platform docs endpoint — the SAME
// transport the Diva DocsRenderer uses — so the plugin ships a version-pinned,
// English, per-programming-language API reference that tracks the SDK code.
// The generators run in the SDK repos' CI on each release and ingest bundles;
// this script materializes the latest of those into references/ for the plugin.
//
// Run on each plugin release, then commit the refreshed references/.
//
//   node scripts/sync-docs.mjs
//   DIVA_DOCS_URL=https://api.diva-ai.ru/v1/docs node scripts/sync-docs.mjs
//
// Fails loud on any HTTP error, shape mismatch, or missing markdown — never a
// silent partial sync.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DOCS_URL = process.env.DIVA_DOCS_URL ?? "https://api.diva-ai.ru/v1/docs";
const LANGUAGE = "en"; // plugin instructions are English-only
const SDKS = ["typescript", "python"];
// Slugs may be nested paths (e.g. "api/agent"); allow /-separated identifier
// segments only, never "..", never absolute — guards against path traversal.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/i;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REF_DIR = join(ROOT, "references");

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  return res.json();
}

const FENCE = { typescript: "ts", python: "python" };

// Render a structured API-reference page (griffe / TS-compiler output) to markdown.
function renderReference(ref, sdk) {
  const fence = FENCE[sdk] ?? "";
  const out = [`# ${ref.name ?? "Reference"}${ref.kind ? ` (${ref.kind})` : ""}`, ""];
  if (ref.description) out.push(ref.description, "");
  if (ref.signature) out.push("```" + fence, ref.signature, "```", "");
  for (const m of ref.members ?? []) {
    out.push(`## ${m.name}${m.kind ? ` — ${m.kind}` : ""}`, "");
    if (m.signature) out.push("```" + fence, m.signature, "```", "");
    if (m.description) out.push(m.description, "");
    if (Array.isArray(m.params) && m.params.length > 0) {
      out.push("| param | type | required |", "|---|---|---|");
      for (const p of m.params) {
        out.push(`| \`${p.name}\` | \`${p.type ?? ""}\` | ${p.required ? "yes" : "no"} |`);
      }
      out.push("");
    }
    if (m.returns?.type) out.push(`Returns: \`${m.returns.type}\``, "");
  }
  return `${out.join("\n")}\n`;
}

function pageMarkdown(page, sdk, ref) {
  if (typeof page.markdown === "string") return page.markdown;
  if (page.reference && typeof page.reference === "object") {
    return renderReference(page.reference, sdk);
  }
  throw new Error(`page ${sdk}/${ref} has neither markdown nor a reference object`);
}

async function syncSdk(sdk) {
  const bundle = await fetchJson(`${DOCS_URL}/${sdk}/latest?language=${LANGUAGE}`);
  if (bundle.sdk !== sdk || bundle.language !== LANGUAGE) {
    throw new Error(
      `bundle mismatch for ${sdk}: got sdk=${bundle.sdk} language=${bundle.language}`,
    );
  }
  const pages = bundle.pages;
  if (typeof pages !== "object" || pages === null) {
    throw new Error(`bundle ${sdk} has no pages object`);
  }
  const outDir = join(REF_DIR, sdk);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const slugs = Object.keys(pages).sort();
  for (const slug of slugs) {
    if (!SLUG_RE.test(slug) || slug.includes("..")) {
      throw new Error(`unexpected page slug ${JSON.stringify(slug)} in ${sdk}`);
    }
    const page = pages[slug];
    if (typeof page !== "object" || page === null) {
      throw new Error(`page ${sdk}/${slug} is not an object`);
    }
    const md = pageMarkdown(page, sdk, slug);
    const filePath = join(outDir, `${slug}.md`);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, md, "utf8");
  }
  await writeFile(
    join(outDir, "_nav.json"),
    `${JSON.stringify(bundle.nav, null, 2)}\n`,
    "utf8",
  );
  return {
    sdk,
    version: bundle.version,
    generatedAt: bundle.generatedAt,
    pages: slugs.length,
  };
}

async function main() {
  await mkdir(REF_DIR, { recursive: true });
  const results = [];
  for (const sdk of SDKS) {
    process.stdout.write(`syncing ${sdk} … `);
    const r = await syncSdk(sdk);
    results.push(r);
    process.stdout.write(`${r.pages} pages @ ${r.version}\n`);
  }
  const manifest = {
    source: DOCS_URL,
    language: LANGUAGE,
    syncedFrom: Object.fromEntries(
      results.map((r) => [
        r.sdk,
        { version: r.version, generatedAt: r.generatedAt, pages: r.pages },
      ]),
    ),
  };
  await writeFile(
    join(REF_DIR, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  console.log("\nreferences/ updated from:", DOCS_URL);
  console.log(JSON.stringify(manifest.syncedFrom, null, 2));
  console.log(
    "\nNext: bump the plugin version to track these SDK versions, then commit references/.",
  );
}

main().catch((err) => {
  console.error(`sync-docs failed: ${err.message}`);
  process.exit(1);
});
