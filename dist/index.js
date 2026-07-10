// src/index.ts
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { wrapFetchWithPayment } from "x402-fetch";
var DEFAULT_BASE = "https://aeml-x402.zeabur.app";
var setting = (rt, k) => rt?.getSetting?.(k) ?? process.env[k];
var baseUrl = (rt) => (setting(rt, "GAUGE_BASE_URL") || DEFAULT_BASE).replace(/\/$/, "");
var maxAtomic = (rt) => BigInt(setting(rt, "GAUGE_MAX_USDC") || "120000");
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
var GRAIN_LOCS = ["us-iowa", "us-illinois", "us-nebraska", "us-kansas", "ar-pampas", "br-matogrosso", "br-parana", "au-nsw", "in-punjab", "ua-ukraine", "ru-southrussia", "cn-northchina"];
function pickGrainLoc(t) {
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
var checkCropDrought = {
  name: "GAUGE_CROP_DROUGHT",
  similes: ["CROP_DROUGHT", "AGRICULTURAL_DROUGHT", "CROP_CONDITION", "GRAIN_REGION", "SOIL_MOISTURE", "CROP_STRESS", "HARVEST_RISK", "CROP_YIELD_RISK"],
  description: "Crop drought & condition check for a grain region: agricultural drought (soil moisture vs official USDM D0\u2013D4) + heat/GDD stress + crop vegetation health (NOAA satellite VHI) + cross-validation (has drought hit the crop canopy yet). For ag traders & crop insurers. Costs $0.10 USDC on Base. loc e.g. us-iowa, ar-pampas, ua-ukraine.",
  validate: async (rt) => !!wallet(rt),
  handler: async (rt, m, _s, _o, cb) => {
    try {
      const loc = pickGrainLoc(text(m));
      if (!loc) {
        cb?.({ text: "Give me a grain region: us-iowa / us-illinois / us-nebraska / us-kansas, ar-pampas (Argentina), br-matogrosso (Brazil), ua-ukraine, ru-southrussia, cn-northchina, au-nsw (Australia), in-punjab (India)." });
        return false;
      }
      const d = await paidGet(rt, `/gauge/agri-region?loc=${encodeURIComponent(loc)}`);
      cb?.({ text: `${d.cross_line_narrative || d.name} ${NEUTRAL}`, content: d });
      return true;
    } catch (e) {
      cb?.({ text: `GAUGE crop-drought failed: ${e.message}` });
      return false;
    }
  },
  examples: [[
    { user: "{{user1}}", content: { text: "Is the US Corn Belt (Iowa) in drought and how are the crops? us-iowa" } },
    { user: "{{agent}}", content: { text: "Pulling the agriculture triangle (drought + heat + crop health) for us-iowa\u2026", action: "GAUGE_CROP_DROUGHT" } }
  ]]
};
var GRID_LOCS = ["us-ercot", "us-caiso", "us-pjm", "us-miso", "us-nyiso", "eu-germany", "eu-france", "eu-uk", "eu-spain", "jp-japan", "au-nem", "in-india"];
function pickGridLoc(t) {
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
var checkGridStress = {
  name: "GAUGE_GRID_STRESS",
  similes: ["GRID_STRESS", "POWER_GRID", "ELECTRICITY_DEMAND", "GRID_LOAD", "POWER_PRICE", "ENERGY_INFLATION", "RENEWABLE_RESOURCE", "ENERGY_PRICE_RISK"],
  description: "Grid stress, power price & energy inflation check for a grid region: electricity demand pressure (temperature degree days HDD+CDD, load proxy) + renewable resource (solar/wind generation potential) + energy inflation (US CPI Energy YoY) / natural gas price (Henry Hub) + cross-validation (high demand \xD7 low renewables = grid squeeze \u2192 energy price/inflation up). For power/energy & macro/inflation traders, utilities, renewable investors. Weather-driven proxy, not actual MW. Costs $0.10 USDC on Base. loc e.g. us-ercot, us-caiso, eu-germany.",
  validate: async (rt) => !!wallet(rt),
  handler: async (rt, m, _s, _o, cb) => {
    try {
      const loc = pickGridLoc(text(m));
      if (!loc) {
        cb?.({ text: "Give me a grid region: us-ercot (Texas) / us-caiso (California) / us-pjm / us-miso / us-nyiso, eu-germany / eu-france / eu-uk / eu-spain, jp-japan, au-nem (Australia), in-india. Energy inflation/gas price are US-national." });
        return false;
      }
      const d = await paidGet(rt, `/gauge/grid-region?loc=${encodeURIComponent(loc)}`);
      cb?.({ text: `${d.cross_line_narrative || d.name} ${NEUTRAL}`, content: d });
      return true;
    } catch (e) {
      cb?.({ text: `GAUGE grid-stress failed: ${e.message}` });
      return false;
    }
  },
  examples: [[
    { user: "{{user1}}", content: { text: "How stressed is the Texas grid and what's energy inflation doing? us-ercot" } },
    { user: "{{agent}}", content: { text: "Pulling the power grid triangle (demand + renewables + energy inflation) for us-ercot\u2026", action: "GAUGE_GRID_STRESS" } }
  ]]
};
var SHIP_LOCS = ["suez-redsea", "panama-pacific", "malacca", "hormuz", "goodhope", "channel", "biscay", "northsea", "gulfmexico", "southchinasea", "bengal", "northpacific"];
function pickShipLoc(t) {
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
var checkRouteDisruption = {
  name: "GAUGE_ROUTE_DISRUPTION",
  similes: ["ROUTE_DISRUPTION", "SHIPPING_DISRUPTION", "PORT_CONGESTION", "SEA_STATE", "CHOKEPOINT", "VESSEL_THROUGHPUT", "SHIPPING_LANE", "LOGISTICS_FLOW", "WAVE_HEIGHT"],
  description: "Shipping route disruption, sea-state & vessel throughput check for a chokepoint/port: logistics-flow disruption (sea state WMO + wind vs operational thresholds) + sea-state cause (wave decomposition: local-storm vs distant-swell) + live AIS vessel throughput (waiting/anchored vs transiting + congestion) + cross-validation (has the disruption reduced actual flow). For shipping lines, commodity/freight traders, ports, marine insurers. Costs $0.10 USDC on Base. loc e.g. malacca, suez-redsea, channel.",
  validate: async (rt) => !!wallet(rt),
  handler: async (rt, m, _s, _o, cb) => {
    try {
      const loc = pickShipLoc(text(m));
      if (!loc) {
        cb?.({ text: "Give me a chokepoint/port: suez-redsea / panama-pacific / malacca / hormuz / goodhope / channel / biscay / northsea / gulfmexico / southchinasea / bengal / northpacific." });
        return false;
      }
      const d = await paidGet(rt, `/gauge/shipping-region?loc=${encodeURIComponent(loc)}`);
      cb?.({ text: `${d.cross_line_narrative || d.name} ${NEUTRAL}`, content: d });
      return true;
    } catch (e) {
      cb?.({ text: `GAUGE route-disruption failed: ${e.message}` });
      return false;
    }
  },
  examples: [[
    { user: "{{user1}}", content: { text: "Is the Strait of Malacca disrupted and how's vessel throughput? malacca" } },
    { user: "{{agent}}", content: { text: "Pulling the shipping triangle (disruption + sea-state + AIS throughput) for malacca\u2026", action: "GAUGE_ROUTE_DISRUPTION" } }
  ]]
};
var FILING_TICKERS = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "META", "GOOGL", "BA", "F", "INTC", "GME", "AMC", "CVNA", "PLTR", "NFLX", "DIS", "JPM", "BAC"];
function pickTicker(t) {
  const up = t.toUpperCase();
  for (const tk of FILING_TICKERS) if (new RegExp(`\\b${tk}\\b`).test(up)) return tk;
  return null;
}
var checkFilingDistress = {
  name: "GAUGE_FILING_CHECK",
  similes: ["FILING_CHECK", "SEC_FILING", "CORPORATE_DISTRESS", "INSIDER_TRADING", "MATERIAL_EVENT", "8K_CHECK", "DISTRESS_CHECK", "EDGAR", "IS_COMPANY_DISTRESSED"],
  description: "Corporate regulatory-filing distress & insider check for a company: 8-K material events (item severity \u2014 bankruptcy/default/restatement/delisting = critical) + NT late-filing delinquency (distress leading indicator) + Form 4 insider net open-market buy/sell + cross-validation (do insiders confirm the disclosed distress by selling, or contradict it by buying). All official SEC EDGAR. For event-driven/activist/short funds, quant funds, credit & distressed analysts. Costs $0.10 USDC on Base. entity = ticker e.g. AMC, CVNA, GME.",
  validate: async (rt) => !!wallet(rt),
  handler: async (rt, m, _s, _o, cb) => {
    try {
      const tk = pickTicker(text(m));
      if (!tk) {
        cb?.({ text: "Give me a ticker from the watchlist: AAPL, MSFT, NVDA, TSLA, AMZN, META, GOOGL, BA, F, INTC, GME, AMC, CVNA, PLTR, NFLX, DIS, JPM, BAC." });
        return false;
      }
      const d = await paidGet(rt, `/gauge/filing-company?entity=${encodeURIComponent(tk)}`);
      cb?.({ text: `${d.cross_line_narrative || d.name} ${NEUTRAL}`, content: d });
      return true;
    } catch (e) {
      cb?.({ text: `GAUGE filing-check failed: ${e.message}` });
      return false;
    }
  },
  examples: [[
    { user: "{{user1}}", content: { text: "Is AMC in distress and what are insiders doing? AMC" } },
    { user: "{{agent}}", content: { text: "Pulling the regulatory-filing triangle (8-K + delinquency + insider Form 4) for AMC\u2026", action: "GAUGE_FILING_CHECK" } }
  ]]
};
var gaugePlugin = {
  name: "gauge",
  description: "GAUGE \u2014 verifiable flood-risk, environmental (river / air quality / precipitation), agriculture (crop drought / heat / vegetation health), power-grid (electricity demand / renewable resource / energy inflation), shipping (route disruption / sea-state / vessel throughput) & regulatory-filing (8-K material events / late-filing delinquency / Form 4 insider) signals via x402 (USDC on Base, no API key). Free raw reading; paid decision-grade records with official USGS/NOAA/USDM/EPA/CAMS/ERA5/FRED/Marine/SEC-EDGAR thresholds + statistical anomaly + record_hash provenance. Cross-validation bundles per region/grain belt/grid/chokepoint/company.",
  actions: [checkFloodRisk, getRegion, checkCropDrought, checkGridStress, checkRouteDisruption, checkFilingDistress, getRiverFree],
  providers: [],
  evaluators: []
};
var index_default = gaugePlugin;
export {
  index_default as default,
  gaugePlugin
};
