import { Plugin } from '@elizaos/core';

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

declare const gaugePlugin: Plugin;

export { gaugePlugin as default, gaugePlugin };
