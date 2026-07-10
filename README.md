# plugin-gauge — ElizaOS plugin for GAUGE (verifiable environmental signals via x402)

Let an [ElizaOS](https://github.com/elizaOS/eliza) agent pull **verifiable flood-risk / river-anomaly** records (and air quality / precipitation) and **pay per call in USDC on Base** — no API key, no signup.

Every record ships with `record_hash` + OpenTimestamps (Bitcoin-anchored) provenance. **Pure description** — official-source facts (USGS / NOAA / EPA / CAMS / ERA5) + back-testable statistics; the agent decides. Payment settles **directly to the provider wallet** via x402 (EIP-3009, gasless).

Backed by the GAUGE service at **https://aeml-x402.zeabur.app** (discovery: [`/.well-known/agent.json`](https://aeml-x402.zeabur.app/.well-known/agent.json) · [`/.well-known/x402`](https://aeml-x402.zeabur.app/.well-known/x402) · [`/llms.txt`](https://aeml-x402.zeabur.app/llms.txt)).

## Install

From GitHub (built `dist/` is committed — no build step needed):

```bash
npm install github:CHANGCHINFU/plugin-gauge-
```

(Or, once published to npm: `npm install plugin-gauge`.)

## Configure (agent settings / env)

| Key | Required | Description |
|---|---|---|
| `EVM_PRIVATE_KEY` | for **paid** actions | 0x Base-mainnet wallet key. Needs a little USDC (EIP-3009 gasless, no ETH). Pays per call. |
| `GAUGE_BASE_URL` | no | Default `https://aeml-x402.zeabur.app`. |
| `GAUGE_MAX_USDC` | no | Atomic per-call cap. Default `60000` ($0.06) — blocks accidental over-spend. |

> The free action (`GAUGE_RIVER_READING_FREE`) needs no wallet.

## Use

```ts
import { gaugePlugin } from "plugin-gauge";

const runtime = new AgentRuntime({
  // ...
  plugins: [gaugePlugin],
  settings: { secrets: { EVM_PRIVATE_KEY: process.env.EVM_PRIVATE_KEY } },
});
```

## Actions

| Action | Price | What it does |
|---|---|---|
| `GAUGE_FLOOD_RISK` | **$0.05** | Verifiable flood-risk / river-anomaly record: current vs official USGS/NOAA flood thresholds (band, distance-to-action) + 5-yr seasonal anomaly (percentile/strata) + `record_hash`. Works for any signal. |
| `GAUGE_REGION` | **$0.10** | Three-leg bundle for a location: air quality + precipitation + nearby river + cross-line corroboration. |
| `GAUGE_CROP_DROUGHT` | **$0.10** | Agriculture triangle for a grain region: agricultural drought (soil moisture vs official USDM D0–D4) + heat/GDD + crop vegetation health (NOAA VHI) + cross-validation (has drought hit the crop canopy). For ag traders & crop insurers. Global grain belts (`us-iowa`, `ar-pampas`, `ua-ukraine`, …). |
| `GAUGE_GRID_STRESS` | **$0.10** | Power grid triangle for a grid region: electricity demand pressure (temperature HDD/CDD load proxy) + renewable resource (solar/wind potential) + energy inflation (US CPI Energy YoY) / natural gas price (Henry Hub) + cross-validation (high demand × low renewables = grid squeeze → energy price/inflation up). For power/energy & macro/inflation traders, utilities, renewable investors. Global grids (`us-ercot`, `us-caiso`, `eu-germany`, …); energy inflation/gas are US-national. Weather-driven proxy, not actual MW. |
| `GAUGE_RIVER_READING_FREE` | **free** | Raw river reading (current/trend/sources/hash). No wallet needed. |

**Signals**: `hydrology.river-level`, `hydrology.streamflow`, `airquality.aqi`, `airquality.pm25`, `precipitation.daily`, `precipitation.wetness30d`, `agriculture.drought`, `agriculture.heat`, `agriculture.crop-vhi`, `electricity.demand`, `electricity.renewable`, `energy.inflation`, `energy.gas-price`.
**Entities**: USGS site id (e.g. `07010000` = Mississippi at St. Louis) for rivers; city id (e.g. `us-chicago`) for air/precip/region. Free station list: `/gauge/catalog`.

À-la-carte add-ons (`/gauge/ruler` $0.01, `/gauge/calibrated` $0.02, `/gauge/strata` $0.03, `/gauge/history` $0.03, `/gauge/air` $0.02, `/gauge/precip` $0.02) and cross-station `/gauge/census` ($1) are available on the API; add actions as needed.

## Verify (zero-trust)

Each record carries `record_hash` (canonical sha256) + Merkle root + OpenTimestamps (Bitcoin). Re-check with `POST /verify` or `/proof/:record_hash`.

## Build & publish (maintainers)

```bash
npm run build      # tsup → dist/
npm publish        # your npm account
```

## Notes

- **Pure description, not advice.** Thresholds are official facts; statistics are back-testable. Any flood/risk decision is the agent's.
- Spending is capped by `GAUGE_MAX_USDC` (default $0.06/call).
- ElizaOS compatibility: built against `@elizaos/core@^0.1.x` action interface. For ElizaOS 1.x the `Action` shape is nearly identical (name/similes/description/validate/handler/examples) — adjust imports if needed.

MIT · AEML-DS Vanished-Data Exchange
