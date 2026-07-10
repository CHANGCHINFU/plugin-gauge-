/**
 * plugin-gauge — ElizaOS plugin for GAUGE verifiable environmental signals via x402.
 *
 * Lets an ElizaOS agent pull decision-grade, on-chain-verifiable flood-risk / river-anomaly
 * records (and air quality / precipitation) and pay per call in USDC on Base — no API key.
 * Pure description: official-source facts (USGS/NOAA/EPA/CAMS/ERA5) + back-testable statistics
 * + record_hash; the agent decides. Payment settles directly to the provider wallet.
 *
 * Config (agent settings / env):
 *   EVM_PRIVATE_KEY   0x-prefixed Base-mainnet wallet key (needs a little USDC; EIP-3009 gasless)
 *   GAUGE_BASE_URL    optional, default https://aeml-x402.zeabur.app
 *   GAUGE_MAX_USDC    optional atomic cap per call (default 60000 = $0.06)
 */
import type { Plugin, Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { wrapFetchWithPayment } from "x402-fetch";

const DEFAULT_BASE = "https://aeml-x402.zeabur.app";
const setting = (rt: IAgentRuntime, k: string) =>
  (rt?.getSetting?.(k) as string | undefined) ?? process.env[k];
const baseUrl = (rt: IAgentRuntime) => (setting(rt, "GAUGE_BASE_URL") || DEFAULT_BASE).replace(/\/$/, "");
const maxAtomic = (rt: IAgentRuntime) => BigInt(setting(rt, "GAUGE_MAX_USDC") || "120000"); // $0.12 hard cap (allows $0.10 region/agri-region; blocks $1 census)

function wallet(rt: IAgentRuntime) {
  let pk = setting(rt, "EVM_PRIVATE_KEY") || setting(rt, "GAUGE_PRIVATE_KEY");
  if (!pk) return null;
  if (!pk.startsWith("0x")) pk = "0x" + pk;
  const account = privateKeyToAccount(pk as `0x${string}`);
  return createWalletClient({ account, chain: base, transport: http() });
}

async function paidGet(rt: IAgentRuntime, path: string): Promise<any> {
  const w = wallet(rt);
  if (!w) throw new Error("EVM_PRIVATE_KEY not set — needs a Base wallet with a little USDC to pay via x402.");
  // cast: viem WalletClient works at runtime (EIP-3009 signing); x402-fetch's SignerWallet type is stricter across viem versions
  const payFetch = wrapFetchWithPayment(fetch, w as any, maxAtomic(rt));
  const res = await payFetch(baseUrl(rt) + path, { method: "GET" });
  if (!res.ok) throw new Error(`GAUGE ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
async function freeGet(rt: IAgentRuntime, path: string): Promise<any> {
  const res = await fetch(baseUrl(rt) + path, { method: "GET" });
  if (!res.ok) throw new Error(`GAUGE ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// 從訊息抽參數(scaffold:寬鬆解析,實際可換成 LLM slot-filling)
function text(m: Memory) { return (m?.content?.text || "") as string; }
function pickSignal(t: string): string {
  const s = t.toLowerCase();
  if (s.includes("streamflow") || s.includes("discharge")) return "hydrology.streamflow";
  if (s.includes("pm2") || s.includes("pm 2")) return "airquality.pm25";
  if (s.includes("aqi") || s.includes("air quality")) return "airquality.aqi";
  if (s.includes("drought") || s.includes("wet") || s.includes("30")) return "precipitation.wetness30d";
  if (s.includes("rain") || s.includes("precip")) return "precipitation.daily";
  return "hydrology.river-level"; // 預設:河川水位
}
function pickEntity(t: string): string | null {
  const usgs = t.match(/\b\d{8,15}\b/);            // USGS site id
  if (usgs) return usgs[0];
  const city = t.match(/us-[a-z]+/i);              // city id (air/precip/region)
  if (city) return city[0].toLowerCase();
  return null;
}

const NEUTRAL = "(GAUGE: pure description, no judgment/prediction; official source + record_hash verifiable — you decide.)";

const checkFloodRisk: Action = {
  name: "GAUGE_FLOOD_RISK",
  similes: ["FLOOD_RISK", "RIVER_ANOMALY", "CHECK_RIVER", "RIVER_LEVEL", "GAGE_HEIGHT", "STREAMFLOW", "IS_RIVER_ABNORMAL"],
  description: "Get a verifiable flood-risk / river-anomaly record for a US river gauge (or air/precip signal): current reading vs official USGS/NOAA flood thresholds (band, distance-to-action) + 5-year seasonal statistical anomaly (percentile/strata) + record_hash. Costs $0.05 USDC on Base via x402.",
  validate: async (rt: IAgentRuntime) => !!wallet(rt),
  handler: async (rt: IAgentRuntime, m: Memory, _s?: State, _o?: any, cb?: HandlerCallback) => {
    try {
      const t = text(m);
      const signal_id = pickSignal(t);
      const entity = pickEntity(t);
      if (!entity) {
        cb?.({ text: "Give me a station id — a USGS site id (e.g. 07010000 = Mississippi at St. Louis) for rivers, or a city id (e.g. us-chicago) for air/precip. Free station list: /gauge/catalog." });
        return false;
      }
      const d = await paidGet(rt, `/gauge?signal_id=${encodeURIComponent(signal_id)}&entity=${encodeURIComponent(entity)}`);
      const R = d.standard_ruler || {}, S = d.stat_ruler || {};
      const cur = JSON.stringify(d.current);
      const out = `${d.entity_name || entity} — ${d.signal_id}: ${cur} (age ${d.data_age_hours}h).`
        + (R.band ? ` Official band: ${R.band}${R.official_category ? ` (${R.official_category})` : ""}, distance-to-action ${R.distance_to_action ?? "—"} ${R.unit || ""}.` : "")
        + (S.frequency_label ? ` Seasonal (${S.window_years}yr): ${Math.round((S.current_percentile ?? 0) * 100)}th pct — ${S.frequency_label}.` : "")
        + ` record_hash ${d.record_hash?.slice(0, 18)}… ${NEUTRAL}`;
      cb?.({ text: out, content: d });
      return true;
    } catch (e: any) { cb?.({ text: `GAUGE flood-risk failed: ${e.message}` }); return false; }
  },
  examples: [[
    { user: "{{user1}}", content: { text: "Is the Mississippi at St. Louis abnormal right now? site 07010000" } },
    { user: "{{agent}}", content: { text: "Fetching a verifiable flood-risk record for USGS 07010000…", action: "GAUGE_FLOOD_RISK" } },
  ]],
};

const getRegion: Action = {
  name: "GAUGE_REGION",
  similes: ["REGION_SIGNALS", "CITY_ENVIRONMENT", "AIR_RAIN_RIVER", "LOCAL_CONDITIONS"],
  description: "Three-leg bundle for a location: air quality + precipitation + nearby river, with cross-line corroboration narrative. Costs $0.10 USDC on Base via x402. loc e.g. us-stlouis, us-chicago.",
  validate: async (rt: IAgentRuntime) => !!wallet(rt),
  handler: async (rt: IAgentRuntime, m: Memory, _s?: State, _o?: any, cb?: HandlerCallback) => {
    try {
      const loc = pickEntity(text(m)) || "";
      if (!loc.startsWith("us-")) { cb?.({ text: "Give me a city id like us-stlouis / us-chicago (see /gauge/preview regions)." }); return false; }
      const d = await paidGet(rt, `/gauge/region?loc=${encodeURIComponent(loc)}`);
      cb?.({ text: `${d.cross_line_narrative || d.name} ${NEUTRAL}`, content: d });
      return true;
    } catch (e: any) { cb?.({ text: `GAUGE region failed: ${e.message}` }); return false; }
  },
  examples: [[
    { user: "{{user1}}", content: { text: "Give me air, rain and river conditions for St. Louis (us-stlouis)" } },
    { user: "{{agent}}", content: { text: "Pulling the three-leg region bundle for us-stlouis…", action: "GAUGE_REGION" } },
  ]],
};

const getRiverFree: Action = {
  name: "GAUGE_RIVER_READING_FREE",
  similes: ["RIVER_READING", "FREE_RIVER", "GAGE_HEIGHT_FREE", "QUICK_RIVER"],
  description: "Free raw river reading (hydrology only): current/previous/change/trend + sources + record_hash. No payment. Use a USGS site id.",
  validate: async () => true,
  handler: async (rt: IAgentRuntime, m: Memory, _s?: State, _o?: any, cb?: HandlerCallback) => {
    try {
      const entity = pickEntity(text(m));
      if (!entity) { cb?.({ text: "Give me a USGS site id (e.g. 07010000). Free list: /gauge/catalog." }); return false; }
      const sid = text(m).toLowerCase().includes("streamflow") ? "hydrology.streamflow" : "hydrology.river-level";
      const d = await freeGet(rt, `/gauge/raw?signal_id=${sid}&entity=${encodeURIComponent(entity)}`);
      cb?.({ text: `${d.entity_name || entity}: ${JSON.stringify(d.current)} (${d.change?.[Object.keys(d.current)[0]]?.direction || "—"}, age ${d.data_age_hours}h). Free base reading; paid flood-risk = GAUGE_FLOOD_RISK. ${NEUTRAL}`, content: d });
      return true;
    } catch (e: any) { cb?.({ text: `GAUGE raw failed: ${e.message}` }); return false; }
  },
  examples: [[
    { user: "{{user1}}", content: { text: "Quick free river level for USGS 07010000" } },
    { user: "{{agent}}", content: { text: "Fetching the free raw reading…", action: "GAUGE_RIVER_READING_FREE" } },
  ]],
};

const GRAIN_LOCS = ["us-iowa", "us-illinois", "us-nebraska", "us-kansas", "ar-pampas", "br-matogrosso", "br-parana", "au-nsw", "in-punjab", "ua-ukraine", "ru-southrussia", "cn-northchina"];
function pickGrainLoc(t: string): string | null {
  const s = t.toLowerCase();
  for (const g of GRAIN_LOCS) if (s.includes(g)) return g;
  if (s.includes("iowa")) return "us-iowa";
  if (s.includes("illinois")) return "us-illinois";
  if (s.includes("nebraska")) return "us-nebraska";
  if (s.includes("kansas")) return "us-kansas";
  if (s.includes("pampas") || s.includes("argentin")) return "ar-pampas";
  if (s.includes("mato grosso") || s.includes("brazil")) return "br-matogrosso";
  if (s.includes("ukrain")) return "ua-ukraine";
  if (s.includes("russia") || s.includes("krasnodar")) return "ru-southrussia";
  if (s.includes("china") || s.includes("shandong")) return "cn-northchina";
  if (s.includes("australia") || s.includes("nsw")) return "au-nsw";
  if (s.includes("punjab") || s.includes("india")) return "in-punjab";
  return null;
}
const checkCropDrought: Action = {
  name: "GAUGE_CROP_DROUGHT",
  similes: ["CROP_DROUGHT", "AGRICULTURAL_DROUGHT", "CROP_CONDITION", "GRAIN_REGION", "SOIL_MOISTURE", "CROP_STRESS", "HARVEST_RISK", "CROP_YIELD_RISK"],
  description: "Crop drought & condition check for a grain region: agricultural drought (soil moisture vs official USDM D0–D4) + heat/GDD stress + crop vegetation health (NOAA satellite VHI) + cross-validation (has drought hit the crop canopy yet). For ag traders & crop insurers. Costs $0.10 USDC on Base. loc e.g. us-iowa, ar-pampas, ua-ukraine.",
  validate: async (rt: IAgentRuntime) => !!wallet(rt),
  handler: async (rt: IAgentRuntime, m: Memory, _s?: State, _o?: any, cb?: HandlerCallback) => {
    try {
      const loc = pickGrainLoc(text(m));
      if (!loc) { cb?.({ text: "Give me a grain region: us-iowa / us-illinois / us-nebraska / us-kansas, ar-pampas (Argentina), br-matogrosso (Brazil), ua-ukraine, ru-southrussia, cn-northchina, au-nsw (Australia), in-punjab (India)." }); return false; }
      const d = await paidGet(rt, `/gauge/agri-region?loc=${encodeURIComponent(loc)}`);
      cb?.({ text: `${d.cross_line_narrative || d.name} ${NEUTRAL}`, content: d });
      return true;
    } catch (e: any) { cb?.({ text: `GAUGE crop-drought failed: ${e.message}` }); return false; }
  },
  examples: [[
    { user: "{{user1}}", content: { text: "Is the US Corn Belt (Iowa) in drought and how are the crops? us-iowa" } },
    { user: "{{agent}}", content: { text: "Pulling the agriculture triangle (drought + heat + crop health) for us-iowa…", action: "GAUGE_CROP_DROUGHT" } },
  ]],
};

const GRID_LOCS = ["us-ercot", "us-caiso", "us-pjm", "us-miso", "us-nyiso", "eu-germany", "eu-france", "eu-uk", "eu-spain", "jp-japan", "au-nem", "in-india"];
function pickGridLoc(t: string): string | null {
  const s = t.toLowerCase();
  for (const g of GRID_LOCS) if (s.includes(g)) return g;
  if (s.includes("ercot") || s.includes("texas")) return "us-ercot";
  if (s.includes("caiso") || s.includes("california")) return "us-caiso";
  if (s.includes("pjm")) return "us-pjm";
  if (s.includes("miso") || s.includes("midwest")) return "us-miso";
  if (s.includes("nyiso") || s.includes("new york")) return "us-nyiso";
  if (s.includes("german")) return "eu-germany";
  if (s.includes("france") || s.includes("french")) return "eu-france";
  if (s.includes("uk") || s.includes("britain") || s.includes("england")) return "eu-uk";
  if (s.includes("spain") || s.includes("spanish")) return "eu-spain";
  if (s.includes("japan")) return "jp-japan";
  if (s.includes("australia") || s.includes("nem")) return "au-nem";
  if (s.includes("india")) return "in-india";
  return null;
}
const checkGridStress: Action = {
  name: "GAUGE_GRID_STRESS",
  similes: ["GRID_STRESS", "POWER_GRID", "ELECTRICITY_DEMAND", "GRID_LOAD", "POWER_PRICE", "ENERGY_INFLATION", "RENEWABLE_RESOURCE", "ENERGY_PRICE_RISK"],
  description: "Grid stress, power price & energy inflation check for a grid region: electricity demand pressure (temperature degree days HDD+CDD, load proxy) + renewable resource (solar/wind generation potential) + energy inflation (US CPI Energy YoY) / natural gas price (Henry Hub) + cross-validation (high demand × low renewables = grid squeeze → energy price/inflation up). For power/energy & macro/inflation traders, utilities, renewable investors. Weather-driven proxy, not actual MW. Costs $0.10 USDC on Base. loc e.g. us-ercot, us-caiso, eu-germany.",
  validate: async (rt: IAgentRuntime) => !!wallet(rt),
  handler: async (rt: IAgentRuntime, m: Memory, _s?: State, _o?: any, cb?: HandlerCallback) => {
    try {
      const loc = pickGridLoc(text(m));
      if (!loc) { cb?.({ text: "Give me a grid region: us-ercot (Texas) / us-caiso (California) / us-pjm / us-miso / us-nyiso, eu-germany / eu-france / eu-uk / eu-spain, jp-japan, au-nem (Australia), in-india. Energy inflation/gas price are US-national." }); return false; }
      const d = await paidGet(rt, `/gauge/grid-region?loc=${encodeURIComponent(loc)}`);
      cb?.({ text: `${d.cross_line_narrative || d.name} ${NEUTRAL}`, content: d });
      return true;
    } catch (e: any) { cb?.({ text: `GAUGE grid-stress failed: ${e.message}` }); return false; }
  },
  examples: [[
    { user: "{{user1}}", content: { text: "How stressed is the Texas grid and what's energy inflation doing? us-ercot" } },
    { user: "{{agent}}", content: { text: "Pulling the power grid triangle (demand + renewables + energy inflation) for us-ercot…", action: "GAUGE_GRID_STRESS" } },
  ]],
};

const SHIP_LOCS = ["suez-redsea", "panama-pacific", "malacca", "hormuz", "goodhope", "channel", "biscay", "northsea", "gulfmexico", "southchinasea", "bengal", "northpacific"];
function pickShipLoc(t: string): string | null {
  const s = t.toLowerCase();
  for (const g of SHIP_LOCS) if (s.includes(g)) return g;
  if (s.includes("suez") || s.includes("red sea")) return "suez-redsea";
  if (s.includes("panama")) return "panama-pacific";
  if (s.includes("malacca")) return "malacca";
  if (s.includes("hormuz")) return "hormuz";
  if (s.includes("good hope") || s.includes("goodhope") || s.includes("cape")) return "goodhope";
  if (s.includes("channel")) return "channel";
  if (s.includes("biscay")) return "biscay";
  if (s.includes("north sea")) return "northsea";
  if (s.includes("gulf of mexico") || s.includes("gulf")) return "gulfmexico";
  if (s.includes("south china")) return "southchinasea";
  if (s.includes("bengal")) return "bengal";
  if (s.includes("north pacific") || s.includes("pacific")) return "northpacific";
  return null;
}
const checkRouteDisruption: Action = {
  name: "GAUGE_ROUTE_DISRUPTION",
  similes: ["ROUTE_DISRUPTION", "SHIPPING_DISRUPTION", "PORT_CONGESTION", "SEA_STATE", "CHOKEPOINT", "VESSEL_THROUGHPUT", "SHIPPING_LANE", "LOGISTICS_FLOW", "WAVE_HEIGHT"],
  description: "Shipping route disruption, sea-state & vessel throughput check for a chokepoint/port: logistics-flow disruption (sea state WMO + wind vs operational thresholds) + sea-state cause (wave decomposition: local-storm vs distant-swell) + live AIS vessel throughput (waiting/anchored vs transiting + congestion) + cross-validation (has the disruption reduced actual flow). For shipping lines, commodity/freight traders, ports, marine insurers. Costs $0.10 USDC on Base. loc e.g. malacca, suez-redsea, channel.",
  validate: async (rt: IAgentRuntime) => !!wallet(rt),
  handler: async (rt: IAgentRuntime, m: Memory, _s?: State, _o?: any, cb?: HandlerCallback) => {
    try {
      const loc = pickShipLoc(text(m));
      if (!loc) { cb?.({ text: "Give me a chokepoint/port: suez-redsea / panama-pacific / malacca / hormuz / goodhope / channel / biscay / northsea / gulfmexico / southchinasea / bengal / northpacific." }); return false; }
      const d = await paidGet(rt, `/gauge/shipping-region?loc=${encodeURIComponent(loc)}`);
      cb?.({ text: `${d.cross_line_narrative || d.name} ${NEUTRAL}`, content: d });
      return true;
    } catch (e: any) { cb?.({ text: `GAUGE route-disruption failed: ${e.message}` }); return false; }
  },
  examples: [[
    { user: "{{user1}}", content: { text: "Is the Strait of Malacca disrupted and how's vessel throughput? malacca" } },
    { user: "{{agent}}", content: { text: "Pulling the shipping triangle (disruption + sea-state + AIS throughput) for malacca…", action: "GAUGE_ROUTE_DISRUPTION" } },
  ]],
};

const FILING_TICKERS = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "META", "GOOGL", "BA", "F", "INTC", "GME", "AMC", "CVNA", "PLTR", "NFLX", "DIS", "JPM", "BAC"];
function pickTicker(t: string): string | null {
  const up = t.toUpperCase();
  for (const tk of FILING_TICKERS) if (new RegExp(`\\b${tk}\\b`).test(up)) return tk;
  return null;
}
const checkFilingDistress: Action = {
  name: "GAUGE_FILING_CHECK",
  similes: ["FILING_CHECK", "SEC_FILING", "CORPORATE_DISTRESS", "INSIDER_TRADING", "MATERIAL_EVENT", "8K_CHECK", "DISTRESS_CHECK", "EDGAR", "IS_COMPANY_DISTRESSED"],
  description: "Corporate regulatory-filing distress & insider check for a company: 8-K material events (item severity — bankruptcy/default/restatement/delisting = critical) + NT late-filing delinquency (distress leading indicator) + Form 4 insider net open-market buy/sell + cross-validation (do insiders confirm the disclosed distress by selling, or contradict it by buying). All official SEC EDGAR. For event-driven/activist/short funds, quant funds, credit & distressed analysts. Costs $0.10 USDC on Base. entity = ticker e.g. AMC, CVNA, GME.",
  validate: async (rt: IAgentRuntime) => !!wallet(rt),
  handler: async (rt: IAgentRuntime, m: Memory, _s?: State, _o?: any, cb?: HandlerCallback) => {
    try {
      const tk = pickTicker(text(m));
      if (!tk) { cb?.({ text: "Give me a ticker from the watchlist: AAPL, MSFT, NVDA, TSLA, AMZN, META, GOOGL, BA, F, INTC, GME, AMC, CVNA, PLTR, NFLX, DIS, JPM, BAC." }); return false; }
      const d = await paidGet(rt, `/gauge/filing-company?entity=${encodeURIComponent(tk)}`);
      cb?.({ text: `${d.cross_line_narrative || d.name} ${NEUTRAL}`, content: d });
      return true;
    } catch (e: any) { cb?.({ text: `GAUGE filing-check failed: ${e.message}` }); return false; }
  },
  examples: [[
    { user: "{{user1}}", content: { text: "Is AMC in distress and what are insiders doing? AMC" } },
    { user: "{{agent}}", content: { text: "Pulling the regulatory-filing triangle (8-K + delinquency + insider Form 4) for AMC…", action: "GAUGE_FILING_CHECK" } },
  ]],
};

export const gaugePlugin: Plugin = {
  name: "gauge",
  description: "GAUGE — verifiable flood-risk, environmental (river / air quality / precipitation), agriculture (crop drought / heat / vegetation health), power-grid (electricity demand / renewable resource / energy inflation), shipping (route disruption / sea-state / vessel throughput) & regulatory-filing (8-K material events / late-filing delinquency / Form 4 insider) signals via x402 (USDC on Base, no API key). Free raw reading; paid decision-grade records with official USGS/NOAA/USDM/EPA/CAMS/ERA5/FRED/Marine/SEC-EDGAR thresholds + statistical anomaly + record_hash provenance. Cross-validation bundles per region/grain belt/grid/chokepoint/company.",
  actions: [checkFloodRisk, getRegion, checkCropDrought, checkGridStress, checkRouteDisruption, checkFilingDistress, getRiverFree],
  providers: [],
  evaluators: [],
};

export default gaugePlugin;
