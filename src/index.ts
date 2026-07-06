#!/usr/bin/env node
/**
 * soldefi-mcp — an MCP (Model Context Protocol) stdio server that exposes the
 * Solana DeFi Intelligence tools (rug/honeypot scan, deep pool analysis, and a
 * wash-filtered "real best pools" ranking) to agent harnesses (Claude Code,
 * Claude Desktop, …). Paid tools automatically settle the x402 HTTP endpoints
 * using the wallet(s) configured via SOLANA_PRIVATE_KEY and/or EVM_PRIVATE_KEY.
 *
 * The service accepts payment on BOTH Solana and Base (USDC). This client
 * registers whichever rails you give it a key for; the x402 layer picks the one
 * the server's 402 challenge advertises.
 *
 * Environment:
 *   SOLDEFI_BASE_URL    base URL of a running Worker (default https://soldefi.thomenz.me)
 *   SOLANA_PRIVATE_KEY  base58 or JSON-array secret key of the paying Solana wallet (holds USDC)
 *   EVM_PRIVATE_KEY     0x-prefixed key of the paying Base wallet (holds USDC)
 *   X402_NETWORK        "base" (mainnet, default) or "base-sepolia" (testnet → Solana devnet)
 *   SOLANA_RPC_URL      optional RPC override used to build the Solana payment (e.g. a Helius URL)
 *
 * SECURITY: these keys control real funds. Use DEDICATED wallets with small
 * balances — never a personal/treasury key. Anything that can read this
 * process' environment can spend from them.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  getBase58Encoder,
} from "@solana/kit";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

const BASE = (process.env.SOLDEFI_BASE_URL ?? "https://soldefi.thomenz.me").replace(/\/+$/, "");
const TESTNET = process.env.X402_NETWORK === "base-sepolia";

// CAIP-2 network ids (first 32 chars of each chain's genesis hash for Solana).
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const BASE_MAINNET = "eip155:8453";
const BASE_SEPOLIA = "eip155:84532";

async function loadSolanaSigner(raw: string) {
  const pk = raw.trim();
  const bytes = pk.startsWith("[")
    ? Uint8Array.from(JSON.parse(pk) as number[])
    : new Uint8Array(getBase58Encoder().encode(pk));
  if (bytes.length === 64) return createKeyPairSignerFromBytes(bytes);
  if (bytes.length === 32) return createKeyPairSignerFromPrivateKeyBytes(bytes);
  throw new Error(`SOLANA_PRIVATE_KEY has unexpected length ${bytes.length} (want 32 or 64 bytes)`);
}

// Build a payment-aware fetch registering every rail we have a key for. Free
// tools still work with plain fetch; paid tools surface the 402 as a tool error
// when no matching wallet is configured.
let payFetch: typeof fetch = fetch;
const rails: string[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const schemes: Array<{ network: any; client: any }> = [];

const solPk = process.env.SOLANA_PRIVATE_KEY;
if (solPk) {
  try {
    const signer = await loadSolanaSigner(solPk);
    const config = process.env.SOLANA_RPC_URL ? { rpcUrl: process.env.SOLANA_RPC_URL } : undefined;
    const net = TESTNET ? SOLANA_DEVNET : SOLANA_MAINNET;
    schemes.push({ network: net, client: new ExactSvmScheme(signer, config) });
    rails.push(`solana(${signer.address})`);
  } catch (err) {
    console.error(`[soldefi-mcp] SOLANA_PRIVATE_KEY invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const evmPk = process.env.EVM_PRIVATE_KEY;
if (evmPk) {
  try {
    const account = privateKeyToAccount(evmPk as `0x${string}`);
    const net = TESTNET ? BASE_SEPOLIA : BASE_MAINNET;
    schemes.push({ network: net, client: new ExactEvmScheme(account) });
    rails.push(`base(${account.address})`);
  } catch (err) {
    console.error(`[soldefi-mcp] EVM_PRIVATE_KEY invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (schemes.length > 0) {
  payFetch = wrapFetchWithPaymentFromConfig(fetch, { schemes }) as typeof fetch;
} else {
  console.error(
    "[soldefi-mcp] No SOLANA_PRIVATE_KEY or EVM_PRIVATE_KEY set — paid tools will fail on HTTP 402. The free validate_mint tool still works.",
  );
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

async function call(method: string, path: string, body?: unknown): Promise<ToolResult> {
  try {
    const res = await payFetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* keep raw text */
    }
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      isError: !res.ok,
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Request failed: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

const server = new McpServer(
  { name: "soldefi-mcp", version: "0.2.0" },
  {
    instructions:
      "Solana DeFi Intelligence exposes paid tools that vet Solana tokens and liquidity " +
      "pools, settling x402 micropayments (USDC on Solana or Base) automatically per call — " +
      "a call is charged only on success; invalid input is rejected for free. Coverage:\n" +
      "1) `scan_honeypot` — rug/honeypot scan of any SPL token by mint: is the mint/freeze " +
      "authority renounced?, Token-2022 transfer tax, top-holder concentration, and a LIVE " +
      "Jupiter buy->sell round trip proving the token is actually sellable (not a honeypot). " +
      "Returns a 0-100 risk score, machine flags and an AVOID/CAUTION/SAFE verdict. Use before " +
      "buying/sniping a token.\n" +
      "2) `analyze_pools` — deep liquidity-pool analysis for a token across Raydium/Orca/" +
      "Meteora/pumpswap: real fee APR (volume x fee / TVL), wash-trade risk, age, TVL, plus a " +
      "token rug verdict and a real Jupiter slippage ladder ($100/$1k/$10k) for true executable " +
      "depth. Recommends the best risk-adjusted pool. Use for LP/yield/arbitrage decisions.\n" +
      "3) `top_pools` — the REAL best Solana DEX pools: the same feed a free API returns, but " +
      "wash-traded/fake-volume pools are filtered out and the rest ranked by risk-adjusted fee " +
      "yield, with an `excluded` list showing exactly what was dropped and why.\n" +
      "4) `check_lp_status` — liquidity durability / rug-pull exposure (pool depth+age, burned supply, " +
      "mint/freeze authority) → DURABLE/SHAKY/FRAGILE/RUG-PRONE.\n" +
      "5) `check_deployer` — deployer reputation: who launched the token, how much they still hold, wallet/token " +
      "age → fresh-wallet / insider-dump risk.\n" +
      "6) `can_i_sell` — live sellability at YOUR size: simulate exiting $X and report USDC recovered, sell impact " +
      "and tax/friction.\n" +
      "7) `scan_wallet_risk` — scan a wallet's holdings and flag the rug/honeypot positions to exit.\n" +
      "8) `scan_honeypot_batch` — one call to scan up to 10 mints (watchlist / launch candidates).\n" +
      "9) `validate_mint` — free base58 address-format check; use it to avoid paying on a malformed mint.\n" +
      "These are PRE-TRADE vetting calls (some run live Jupiter simulations, so expect a few hundred ms to ~2s; " +
      "cached calls are near-instant — see the X-Cache and Server-Timing headers). For trading, sniper, LP, yield " +
      "and MEV agents that can't trust raw on-chain volume numbers.",
  },
);

const MINT_ARG = {
  mint: z
    .string()
    .describe("Solana SPL token mint address (base58), e.g. EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v (USDC)."),
};

server.registerTool(
  "scan_honeypot",
  {
    title: "Solana token rug / honeypot scan",
    description:
      "Rug & honeypot scan of a Solana SPL token by mint. On-chain: mint/freeze authority renounced?, " +
      "Token-2022 transfer tax, top-holder concentration, plus a live Jupiter buy->sell round trip proving " +
      "the token is actually sellable (not a honeypot). Returns a 0-100 risk score, machine flags and an " +
      "agent-readable verdict (AVOID/CAUTION/SAFE). Paid ($0.02).",
    inputSchema: MINT_ARG,
  },
  ({ mint }) => call("GET", `/v1/solana/honeypot/${encodeURIComponent(mint)}`),
);

server.registerTool(
  "analyze_pools",
  {
    title: "Deep Solana liquidity-pool analysis for a token",
    description:
      "Deep liquidity-pool analysis for a Solana token across Raydium, Orca, Meteora and pumpswap. Per pool: " +
      "real fee APR (volume x fee / TVL), wash-trade risk (turnover + executable-depth cross-check), age and " +
      "TVL. Plus a token rug/honeypot verdict and a real Jupiter slippage ladder for true liquidity depth. " +
      "Recommends the best risk-adjusted pool. Paid ($0.04).",
    inputSchema: {
      ...MINT_ARG,
      tradeSizesUsd: z
        .array(z.number().min(1).max(10_000_000))
        .min(1)
        .max(5)
        .optional()
        .describe("Optional USD trade sizes for the slippage ladder (default [100, 1000, 10000])."),
    },
  },
  ({ mint, tradeSizesUsd }) =>
    call("POST", "/v1/solana/pool-intel", { mint, ...(tradeSizesUsd ? { tradeSizesUsd } : {}) }),
);

server.registerTool(
  "top_pools",
  {
    title: "Real best Solana DEX pools (wash-filtered)",
    description:
      "The real best Solana DEX pools: the same top-pools feed a free API returns, but wash-traded and " +
      "fake-volume pools are filtered out and the rest ranked by risk-adjusted fee yield (Raydium/Orca/" +
      "Meteora). Returns clean, decision-ready pools plus an `excluded` list showing exactly which pools were " +
      "dropped and why. Paid ($0.05).",
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional().describe("Max pools to return (default 15)."),
      minTvlUsd: z.number().min(0).optional().describe("Minimum pool TVL in USD (default 10000)."),
    },
  },
  ({ limit, minTvlUsd }) =>
    call("POST", "/v1/solana/pools/top", {
      ...(limit !== undefined ? { limit } : {}),
      ...(minTvlUsd !== undefined ? { minTvlUsd } : {}),
    }),
);

server.registerTool(
  "check_lp_status",
  {
    title: "Solana token liquidity durability / rug-pull exposure",
    description:
      "Assess how durable a Solana token's liquidity is and whether a dev could pull it: pools (TVL, age, DEX), " +
      "largest-pool depth, burned-supply share, and whether mint/freeze authority is still live. Returns a 0-100 " +
      "liquidity-risk score + verdict (DURABLE/SHAKY/FRAGILE/RUG-PRONE). A durability signal, not a cryptographic " +
      "LP time-lock proof. Paid ($0.02).",
    inputSchema: MINT_ARG,
  },
  ({ mint }) => call("GET", `/v1/solana/lp-status/${encodeURIComponent(mint)}`),
);

server.registerTool(
  "check_deployer",
  {
    title: "Solana token deployer reputation",
    description:
      "Trace who launched a Solana token: the mint's creator wallet, how much of the token the deployer still " +
      "holds, the deployer wallet's age and the token's age. Returns a 0-100 risk score + verdict flagging fresh " +
      "wallets, heavy insider self-holding and brand-new tokens. Paid ($0.03).",
    inputSchema: MINT_ARG,
  },
  ({ mint }) => call("GET", `/v1/solana/deployer/${encodeURIComponent(mint)}`),
);

server.registerTool(
  "can_i_sell",
  {
    title: "Real-time Solana sellability check at your size",
    description:
      "Simulate exiting a specific USD amount of a Solana token via a live Jupiter buy->sell round trip: whether " +
      "you can actually sell, USDC recovered, real sell price impact and tax/friction loss. Answers 'can I get $X " +
      "out right now, and at what cost?' — catches honeypots and thin books at your real trade size. Paid ($0.01).",
    inputSchema: {
      ...MINT_ARG,
      usd: z.number().min(10).max(1_000_000).optional().describe("Trade size in USD to simulate exiting (default 1000)."),
    },
  },
  ({ mint, usd }) =>
    call("GET", `/v1/solana/can-i-sell/${encodeURIComponent(mint)}${usd !== undefined ? `?usd=${usd}` : ""}`),
);

server.registerTool(
  "scan_wallet_risk",
  {
    title: "Portfolio rug scan for a Solana wallet",
    description:
      "Read a Solana wallet's SPL holdings and run the full honeypot/rug scan on each (up to 10 positions). Returns " +
      "per-token risk plus a summary of how many holdings are critical/high/medium/low and which mints to exit. " +
      "For portfolio-manager and risk agents auditing exposure. Paid ($0.05).",
    inputSchema: { address: z.string().describe("Solana wallet address (base58) to scan for risky holdings.") },
  },
  ({ address }) => call("POST", "/v1/solana/wallet-risk", { address }),
);

server.registerTool(
  "scan_honeypot_batch",
  {
    title: "Batch Solana rug/honeypot scan (up to 10 mints)",
    description:
      "Scan up to 10 Solana token mints in one paid call and get the full per-token honeypot verdict (0-100 risk " +
      "score, flags, sellability) for each — cheaper than scanning individually. For vetting a watchlist or a set " +
      "of launch candidates at once. Paid ($0.10).",
    inputSchema: {
      mints: z.array(z.string()).min(1).max(10).describe("1-10 Solana SPL token mints to scan."),
    },
  },
  ({ mints }) => call("POST", "/v1/solana/honeypot-batch", { mints }),
);

server.registerTool(
  "validate_mint",
  {
    title: "Validate a Solana mint address (free)",
    description:
      "Free local base58 address-format validation of a single Solana mint. No payment required. Use it to " +
      "avoid paying on a malformed mint.",
    inputSchema: MINT_ARG,
  },
  ({ mint }) => call("GET", `/v1/solana/validate/${encodeURIComponent(mint)}`),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[soldefi-mcp] ready. base=${BASE} network=${TESTNET ? "testnet" : "mainnet"} rails=[${rails.join(", ") || "none"}]`,
);
