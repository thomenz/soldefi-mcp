# soldefi-mcp

An **MCP (Model Context Protocol) server** that gives AI agents paid access to
**Solana DeFi risk intelligence** — rug/honeypot scans, deep liquidity-pool
analysis, and a wash-trade-filtered "real best pools" ranking. Each paid call
settles an **x402 micropayment in USDC** (on **Solana** or **Base**)
automatically, using a wallet you configure. A call is charged **only on
success** — malformed input is rejected for free.

It talks to the hosted **Solana DeFi Intelligence** API
(`https://soldefi.thomenz.me` by default). This package is a thin payment-client
bridge; the intelligence runs server-side.

## Tools

| Tool | Price | What it does |
|---|---|---|
| `scan_honeypot` | $0.02 | Rug/honeypot scan of an SPL token by mint: mint/freeze authority renounced?, Token-2022 transfer tax, top-holder concentration, and a **live Jupiter buy→sell round trip** as a strong signal the token is sellable at scan time (catches most honeypots). Returns a 0–100 risk score + `AVOID`/`CAUTION`/`LOW RISK` verdict. |
| `analyze_pools` | $0.04 | Deep liquidity-pool analysis across Raydium/Orca/Meteora/pumpswap: real fee APR, wash-trade risk, age, TVL, a token rug verdict, and a real Jupiter slippage ladder ($100/$1k/$10k). Recommends the best risk-adjusted pool. |
| `top_pools` | $0.05 | The **real** best Solana DEX pools — wash-traded/fake-volume pools filtered out, the rest ranked by risk-adjusted fee yield, with an `excluded` list of what was dropped and why. |
| `check_lp_status` | $0.02 | Liquidity durability / rug-pull exposure: pools (TVL, age, DEX), largest-pool depth, burned-supply share, and whether mint/freeze authority is still live. Returns a 0-100 liquidity-risk score + verdict (`DURABLE`/`SHAKY`/`FRAGILE`/`RUG-PRONE`). |
| `check_deployer` | $0.03 | Deployer reputation: creator wallet address, creator's remaining holding %, wallet age, and token age. Verdict flags fresh wallets, heavy insider holding, and brand-new tokens. |
| `can_i_sell` | $0.01 | Real-time sellability check at YOUR size: simulates exiting a specific USD amount of a Solana token via a live Jupiter buy→sell round trip and reports USDC recovered, real sell price impact, and tax/friction loss. |
| `check_exit_risk` | $0.04 | **Can I get out, and at what cost?** Crosses Birdeye smart-money flow (whale net buy/sell 24h, bundler/sniper manipulation tags, 1h sell-pressure, holder count) with a **live Jupiter exit-slippage ladder** ($1k/$10k) → `LOW`/`ELEVATED`/`HIGH` exit-risk. The sellability wedge: are whales dumping into a thin book that traps you? |
| `full_scan` | $0.08 | **One-call full workup**: bundles honeypot + LP durability + deployer + exit-risk into a single verdict with an aggregated `overall` {riskScore, riskLevel, verdict, topFlags} — cheaper than buying the four separately (~$0.11). |
| `scan_wallet_risk` | $0.08 | Portfolio rug scan: reads a wallet's SPL holdings and runs the full honeypot/rug scan on each (up to 10 positions), returning per-token risk and which mints to exit. |
| `scan_honeypot_batch` | $0.10 | Batch rug/honeypot scan: submit up to 10 Solana token mints and get the full per-token honeypot verdict for each in one paid call (cheaper than scanning individually). |
| `validate_mint` | free | Local base58 mint-address format check. No payment. |

## Install & configure

Add it to your MCP client (Claude Code, Claude Desktop, …). Only a paying
wallet is required — everything else defaults to production.

```json
{
  "mcpServers": {
    "soldefi": {
      "command": "npx",
      "args": ["-y", "soldefi-mcp"],
      "env": {
        "SOLANA_PRIVATE_KEY": "<base58-or-JSON-array secret key of a DEDICATED Solana wallet holding USDC>"
      }
    }
  }
}
```

You can pay on **Base** instead of (or in addition to) Solana by setting
`EVM_PRIVATE_KEY` (`0x…`). If both are set, the x402 layer uses whichever rail
the server's payment challenge advertises.

### Environment

| Var | Default | Notes |
|---|---|---|
| `SOLANA_PRIVATE_KEY` | — | base58 or JSON-array secret key (32 or 64 bytes) of the paying Solana wallet. |
| `EVM_PRIVATE_KEY` | — | `0x`-prefixed key of the paying Base wallet. |
| `SOLDEFI_BASE_URL` | `https://soldefi.thomenz.me` | Point at your own Worker if self-hosting. |
| `X402_NETWORK` | `base` | `base` (mainnet → Solana mainnet) or `base-sepolia` (testnet → Solana devnet). |
| `SOLANA_RPC_URL` | — | Optional RPC used to build the Solana payment (e.g. a Helius URL). Public default otherwise. |

> 🔐 **Security:** these keys control real funds. Use a **dedicated wallet with a
> small balance**, never a personal/treasury key. Anything that can read this
> process' environment can spend from it.

## The wallet needs

- A little **USDC** on the chosen chain to pay per call.
- On **Solana**, a tiny bit of **SOL** is *not* required for the payment itself
  (the facilitator sponsors the transaction fee), but the receiving side must
  have a USDC token account — which it does on the hosted service.

## Develop

```bash
pnpm install
pnpm --filter soldefi-mcp build      # tsc → dist/
SOLANA_PRIVATE_KEY=… pnpm --filter soldefi-mcp dev   # run from source
```

## License

MIT
