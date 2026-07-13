/**
 * scripts/supabase-smoke.ts — prove the Supabase cache is actually reachable.
 *
 * Runs a real round-trip (upsert → select → delete) against blindspot.cache via the SAME
 * client the app uses (src/lib/supabase.ts, schema "blindspot", publishable key), plus a
 * blocklist read. On failure it prints the REAL PostgREST error (message/code/hint) — which
 * the app's cache modules swallow into a generic "unreachable" — and points at the fix.
 *
 *   npm run smoke:supabase
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// Load .env.local the same way run-arm.ts does (standalone scripts don't get Next's env).
const envPath = join(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

import { supabase } from "../src/lib/supabase";

interface PgError {
  message?: string;
  code?: string;
  hint?: string;
  details?: string;
}

function fail(step: string, error: PgError): never {
  console.error(`\n❌ ${step} failed:`);
  console.error("   message:", error.message);
  console.error("   code:   ", error.code);
  if (error.hint) console.error("   hint:   ", error.hint);
  if (error.details) console.error("   details:", error.details);

  const code = error.code ?? "";
  const msg = (error.message ?? "").toLowerCase();
  console.error("");
  if (code === "PGRST106" || msg.includes("schema must be one of")) {
    console.error("   → Diagnosis: the 'blindspot' schema isn't EXPOSED to the API.");
    console.error("     Dashboard → Project Settings → API → Exposed schemas → add 'blindspot'.");
  } else if (code === "42P01") {
    console.error("   → Diagnosis: table missing. Run supabase/schema.sql in the SQL editor.");
  } else if (code === "42501" || msg.includes("row-level security")) {
    console.error("   → Diagnosis: permission/RLS. Re-run the grants + policies in supabase/schema.sql.");
  } else if (msg.includes("invalid api key")) {
    console.error("   → Diagnosis: use the legacy 'anon public' JWT key (eyJ…), not a publishable key.");
  } else {
    console.error("   → Diagnosis: unrecognized — see message/code above.");
  }
  process.exit(1);
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error("❌ SUPABASE_URL / SUPABASE_ANON_KEY not set in .env.local");
    process.exit(1);
  }
  console.log(`Supabase: ${url}  (key ${key.slice(0, 12)}…, schema "blindspot")\n`);

  // Use a real, constraint-valid type ("search") with an obviously-namespaced key so the
  // row can't collide with a genuine cache entry — and delete it right after.
  const testType = "search";
  const testKey = `__smoke_test__:${Date.now()}`;
  const testValue = [{ url: "smoke", title: "smoke", snippet: "smoke" }];

  console.log("→ upsert test row into blindspot.cache …");
  const up = await supabase.from("cache").upsert({ type: testType, key: testKey, value: testValue });
  if (up.error) fail("upsert", up.error);

  console.log("→ select it back …");
  const sel = await supabase
    .from("cache")
    .select("value")
    .eq("type", testType)
    .eq("key", testKey)
    .maybeSingle();
  if (sel.error) fail("select", sel.error);
  if (!sel.data) {
    console.error("\n❌ row not found after a successful upsert — a read RLS policy is likely blocking SELECT.");
    process.exit(1);
  }
  console.log("   round-trip value:", JSON.stringify(sel.data.value));

  console.log("→ delete test row (cleanup) …");
  const del = await supabase.from("cache").delete().eq("type", testType).eq("key", testKey);
  if (del.error) fail("delete", del.error);

  console.log("→ read blindspot.blocklist …");
  const bl = await supabase.from("blocklist").select("domain").limit(1);
  if (bl.error) fail("blocklist select", bl.error);
  console.log(`   blocklist reachable (${bl.data?.length ?? 0} row sampled)`);

  console.log("\n✅ Supabase cache is LIVE — cache round-trip + blocklist both hit. Runs will now cache.");
}

main().catch((e) => {
  console.error("\n❌ unexpected error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
