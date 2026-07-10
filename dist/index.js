// src/index.ts
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { wrapFetchWithPayment } from "x402-fetch";
var DEFAULT_BASE = "https://aeml-x402.zeabur.app";
var setting = (rt, k) => rt?.getSetting?.(k) ?? process.env[k];
var baseUrl = (rt) => (setting(rt, "GAUGE_BASE_URL") || DEFAULT_BASE).replace(/\/$/, "");
var maxAtomic = (rt) => BigInt(setting(rt, "GAUGE_MAX_USDC") || "60000");
function wallet(rt) {
  let pk = setting(rt, "EVM_PRIVATE_KEY") || setting(rt, "GAUGE_PRIVATE_KEY");
  if (!pk) return null;
  if (!pk.startsWith("0x")) pk = "0x" + pk;
  const account = privateKeyToAccount(pk);
  return createWalletClient({ account, chain: base, transport: http() });
}
async function paidGet(rt, path) {
  const w = wallet(rt);
  if (!w) throw new Error("EVM_PRIVATE_KEY not set \u2014 needs a Base wallet with a little USDC to pay via x402.");
  const payFetch = wrapFetchWithPayment(fetch, w, maxAtomic(rt));
  const res = await payFetch(baseUrl(rt) + path, { method: "GET" });
  if (!res.ok) throw new Error(`GAUGE ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
async function freeGet(rt, path) {
  const res = await fetch(baseUrl(rt) + path, { method: "GET" });
  if (!res.ok) throw new Error(`GAUGE ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
function text(m) {
  return m?.content?.text || "";
}
function pickSignal(t) {
  const s = t.toLowerCase();
  if (s.includes("streamflow") || s.includes("discharge")) return "hydrology.streamflow";
  if (s.includes("pm2") || s.includes("pm 2")) return "airquality.pm25";
  if (s.includes("aqi") || s.includes("air quality")) return "airquality.aqi";
  if (s.includes("drought") || s.includes("wet") || s.includes("30")) return "precipitation.wetness30d";
  if (s.includes("rain") || s.includes("precip")) return "precipitation.daily";
  return "hydrology.river-level";
}
function pickEntity(t) {
  const usgs = t.match(/\b\d{8,15}\b/);
  if (usgs) return usgs[0];
  const city = t.match(/us-[a-z]+/i);
  if (city) return city[0].toLowerCase();
  return null;
}
var NEUTRAL = "(GAUGE: pure description, no judgment/prediction; official source + record_hash verifiable \u2014 you decide.)";
var checkFloodRisk = {
  name: "GAUGE_FLOOD_RISK",
  similes: ["FLOOD_RISK", "RIVER_ANOMALY", "CHECK_RIVER", "RIVER_LEVEL", "GAGE_HEIGHT", "STREAMFLOW", "IS_RIVER_ABNORMAL"],
  description: "Get a verifiable flood-risk / river-anomaly record for a US river gauge (or air/precip signal): current reading vs official USGS/NOAA flood thresholds (band, distance-to-action) + 5-year seasonal statistical anomaly (percentile/strata) + record_hash. Costs $0.05 USDC on Base via x402.",
  validate: async (rt) => !!wallet(rt),
  handler: async (rt, m, _s, _o, cb) => {
    try {
      const t = text(m);
      const signal_id = pickSignal(t);
      const entity = pickEntity(t);
      if (!entity) {
        cb?.({ text: "Give me a station id \u2014 a USGS site id (e.g. 07010000 = Mississippi at St. Louis) for rivers, or a city id (e.g. us-chicago) for air/precip. Free station list: /gauge/catalog." });
        return false;
      }
      const d = await paidGet(rt, `/gauge?signal_id=${encodeURIComponent(signal_id)}&entity=${encodeURIComponent(entity)}`);
      const R = d.standard_ruler || {}, S = d.stat_ruler || {};
      const cur = JSON.stringify(d.current);
      const out = `${d.entity_name || entity} \u2014 ${d.signal_id}: ${cur} (age ${d.data_age_hours}h).` + (R.band ? ` Official band: ${R.band}${R.official_category ? ` (${R.official_category})` : ""}, distance-to-action ${R.distance_to_action ?? "\u2014"} ${R.unit || ""}.` : "") + (S.frequency_label ? ` Seasonal (${S.window_years}yr): ${Math.round((S.current_percentile ?? 0) * 100)}th pct \u2014 ${S.frequency_label}.` : "") + ` record_hash ${d.record_hash?.slice(0, 18)}\u2026 ${NEUTRAL}`;
      cb?.({ text: out, content: d });
      return true;
    } catch (e) {
      cb?.({ text: `GAUGE flood-risk failed: ${e.message}` });
      return false;
    }
  },
  examples: [[
    { user: "{{user1}}", content: { text: "Is the Mississippi at St. Louis abnormal right now? site 07010000" } },
    { user: "{{agent}}", content: { text: "Fetching a verifiable flood-risk record for USGS 07010000\u2026", action: "GAUGE_FLOOD_RISK" } }
  ]]
};
var getRegion = {
  name: "GAUGE_REGION",
  similes: ["REGION_SIGNALS", "CITY_ENVIRONMENT", "AIR_RAIN_RIVER", "LOCAL_CONDITIONS"],
  description: "Three-leg bundle for a location: air quality + precipitation + nearby river, with cross-line corroboration narrative. Costs $0.10 USDC on Base via x402. loc e.g. us-stlouis, us-chicago.",
  validate: async (rt) => !!wallet(rt),
  handler: async (rt, m, _s, _o, cb) => {
    try {
      const loc = pickEntity(text(m)) || "";
      if (!loc.startsWith("us-")) {
        cb?.({ text: "Give me a city id like us-stlouis / us-chicago (see /gauge/preview regions)." });
        return false;
      }
      const d = await paidGet(rt, `/gauge/region?loc=${encodeURIComponent(loc)}`);
      cb?.({ text: `${d.cross_line_narrative || d.name} ${NEUTRAL}`, content: d });
      return true;
    } catch (e) {
      cb?.({ text: `GAUGE region failed: ${e.message}` });
      return false;
    }
  },
  examples: [[
    { user: "{{user1}}", content: { text: "Give me air, rain and river conditions for St. Louis (us-stlouis)" } },
    { user: "{{agent}}", content: { text: "Pulling the three-leg region bundle for us-stlouis\u2026", action: "GAUGE_REGION" } }
  ]]
};
var getRiverFree = {
  name: "GAUGE_RIVER_READING_FREE",
  similes: ["RIVER_READING", "FREE_RIVER", "GAGE_HEIGHT_FREE", "QUICK_RIVER"],
  description: "Free raw river reading (hydrology only): current/previous/change/trend + sources + record_hash. No payment. Use a USGS site id.",
  validate: async () => true,
  handler: async (rt, m, _s, _o, cb) => {
    try {
      const entity = pickEntity(text(m));
      if (!entity) {
        cb?.({ text: "Give me a USGS site id (e.g. 07010000). Free list: /gauge/catalog." });
        return false;
      }
      const sid = text(m).toLowerCase().includes("streamflow") ? "hydrology.streamflow" : "hydrology.river-level";
      const d = await freeGet(rt, `/gauge/raw?signal_id=${sid}&entity=${encodeURIComponent(entity)}`);
      cb?.({ text: `${d.entity_name || entity}: ${JSON.stringify(d.current)} (${d.change?.[Object.keys(d.current)[0]]?.direction || "\u2014"}, age ${d.data_age_hours}h). Free base reading; paid flood-risk = GAUGE_FLOOD_RISK. ${NEUTRAL}`, content: d });
      return true;
    } catch (e) {
      cb?.({ text: `GAUGE raw failed: ${e.message}` });
      return false;
    }
  },
  examples: [[
    { user: "{{user1}}", content: { text: "Quick free river level for USGS 07010000" } },
    { user: "{{agent}}", content: { text: "Fetching the free raw reading\u2026", action: "GAUGE_RIVER_READING_FREE" } }
  ]]
};
var gaugePlugin = {
  name: "gauge",
  description: "GAUGE \u2014 verifiable flood-risk & environmental signals (river / air quality / precipitation) via x402 (USDC on Base, no API key). Free raw reading; paid decision-grade records with official USGS/NOAA thresholds + seasonal statistical anomaly + record_hash provenance.",
  actions: [checkFloodRisk, getRegion, getRiverFree],
  providers: [],
  evaluators: []
};
var index_default = gaugePlugin;
export {
  index_default as default,
  gaugePlugin
};
