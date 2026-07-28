#!/usr/bin/env node
// Sync generated SDK reference docs into the plugin's references/ tree.
//
// Pulls the live docs bundles from the platform docs endpoint — the SAME
// transport the Diva DocsRenderer uses — so the plugin ships a version-pinned,
// English, per-programming-language API reference that tracks the SDK code.
// Run on each plugin release, then commit the refreshed references/.
//
//   node scripts/sync-docs.mjs
//   DIVA_DOCS_URL=https://api.diva-ai.ru/v1/docs node scripts/sync-docs.mjs
//
// Fails loud on any HTTP error, shape mismatch, empty bundle, or missing
// content — and never leaves a half-written tree: EVERYTHING is fetched,
// validated, and rendered in memory first, then each SDK is written to a tmp
// dir and swapped into place atomically.

import { mkdir, writeFile, rm, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DOCS_URL = process.env.DIVA_DOCS_URL ?? "https://api.diva-ai.ru/v1/docs";
const LANGUAGE = "en"; // plugin instructions are English-only
const SDKS = ["typescript", "python"];
// Lowercase, /-separated identifier segments only. NO `/i` flag on purpose:
// slugs follow the documented lowercase convention, and case-insensitive
// matching would let `API/Agent` collide with `api/agent` on a case-insensitive
// filesystem (macOS/Windows) — a silent last-writer-wins overwrite. `.` is in
// no character class, so `..` cannot match (the extra guard below is belt-and-braces).
const SLUG_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;
const FENCE = { typescript: "ts", python: "python" };
const FETCH_TIMEOUT_MS = 30_000;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REF_DIR = join(ROOT, "references");

async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`GET ${url} failed: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new Error(`GET ${url} returned invalid JSON: ${err.message}`);
  }
}

// A fenced code block whose fence is longer than any backtick run in `body`,
// so an untrusted signature containing ``` cannot break out of the block.
function codeBlock(lang, body) {
  let longest = 0;
  for (const run of String(body).matchAll(/`+/g)) {
    longest = Math.max(longest, run[0].length);
  }
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${body}\n${fence}`;
}

// Escape a table-cell value so a `|` in a param type can't break the column.
function cell(text) {
  return String(text).replace(/\|/g, "\\|");
}

// Render a structured API-reference page (griffe / TS-compiler output) to markdown.
function renderReference(ref, sdk) {
  const lang = FENCE[sdk] ?? "";
  const out = [`# ${ref.name ?? "Reference"}${ref.kind ? ` (${ref.kind})` : ""}`, ""];
  if (ref.description) out.push(String(ref.description), "");
  if (ref.signature) out.push(codeBlock(lang, ref.signature), "");
  const members = Array.isArray(ref.members) ? ref.members : [];
  for (const m of members) {
    if (typeof m !== "object" || m === null) continue;
    out.push(`## ${m.name ?? "(member)"}${m.kind ? ` — ${m.kind}` : ""}`, "");
    if (m.signature) out.push(codeBlock(lang, m.signature), "");
    if (m.description) out.push(String(m.description), "");
    if (Array.isArray(m.params) && m.params.length > 0) {
      out.push("| param | type | required |", "|---|---|---|");
      for (const p of m.params) {
        out.push(
          `| \`${cell(p?.name ?? "")}\` | \`${cell(p?.type ?? "")}\` | ${p?.required ? "yes" : "no"} |`,
        );
      }
      out.push("");
    }
    if (m.returns?.type) out.push(`Returns: \`${cell(m.returns.type)}\``, "");
  }
  return `${out.join("\n")}\n`;
}

function pageMarkdown(page, sdk, slug) {
  if (typeof page.markdown === "string") return page.markdown;
  if (page.reference && typeof page.reference === "object") {
    return renderReference(page.reference, sdk);
  }
  throw new Error(`page ${sdk}/${slug} has neither markdown nor a reference object`);
}

// Fetch + validate + render EVERYTHING for one SDK in memory. Throws BEFORE any
// filesystem mutation, so a bad/empty bundle never wipes a good references tree.
async function buildSdk(sdk) {
  const bundle = await fetchJson(`${DOCS_URL}/${sdk}/latest?language=${LANGUAGE}`);
  if (bundle.sdk !== sdk || bundle.language !== LANGUAGE) {
    throw new Error(
      `bundle mismatch for ${sdk}: got sdk=${bundle.sdk} language=${bundle.language}`,
    );
  }
  if (typeof bundle.version !== "string" || bundle.version.length === 0) {
    throw new Error(`bundle ${sdk} has no version`);
  }
  const pages = bundle.pages;
  if (typeof pages !== "object" || pages === null) {
    throw new Error(`bundle ${sdk} has no pages object`);
  }
  if (typeof bundle.nav !== "object" || bundle.nav === null) {
    throw new Error(`bundle ${sdk} has no nav`);
  }
  const slugs = Object.keys(pages).sort();
  if (slugs.length === 0) {
    throw new Error(`bundle ${sdk} has zero pages — refusing to wipe references/${sdk}`);
  }

  const files = [];
  for (const slug of slugs) {
    if (!SLUG_RE.test(slug) || slug.includes("..")) {
      throw new Error(`unexpected page slug ${JSON.stringify(slug)} in ${sdk}`);
    }
    const page = pages[slug];
    if (typeof page !== "object" || page === null) {
      throw new Error(`page ${sdk}/${slug} is not an object`);
    }
    files.push({ rel: `${slug}.md`, content: pageMarkdown(page, sdk, slug) });
  }
  files.push({ rel: "_nav.json", content: `${JSON.stringify(bundle.nav, null, 2)}\n` });

  return {
    sdk,
    files,
    version: bundle.version,
    generatedAt: bundle.generatedAt ?? null,
    pages: slugs.length,
  };
}

// Write one SDK's pre-rendered files atomically: fill a fresh tmp dir, then
// swap it into place (rename is atomic on the same filesystem).
async function writeSdk(built) {
  const finalDir = join(REF_DIR, built.sdk);
  const tmpDir = join(REF_DIR, `.tmp-${built.sdk}`);
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  for (const f of built.files) {
    const p = join(tmpDir, f.rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, f.content, "utf8");
  }
  await rm(finalDir, { recursive: true, force: true });
  await rename(tmpDir, finalDir);
}

async function main() {
  // Phase 1 — build ALL sdks in memory. Any failure aborts here, before we
  // touch the filesystem, so references/ is never left partial or wiped.
  const built = [];
  for (const sdk of SDKS) {
    process.stdout.write(`fetching ${sdk} … `);
    const b = await buildSdk(sdk);
    built.push(b);
    process.stdout.write(`${b.pages} pages @ ${b.version}\n`);
  }

  // Phase 2 — only now mutate the filesystem, atomically per SDK.
  await mkdir(REF_DIR, { recursive: true });
  for (const b of built) {
    await writeSdk(b);
  }
  const manifest = {
    source: DOCS_URL,
    language: LANGUAGE,
    syncedFrom: Object.fromEntries(
      built.map((b) => [
        b.sdk,
        { version: b.version, generatedAt: b.generatedAt, pages: b.pages },
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
