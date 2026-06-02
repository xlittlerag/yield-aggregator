# **Technical Specification: Multi-Strategy Automated Yield Aggregator**

#### **1. System Overview**

The Automated Yield Aggregator is an on-chain asset management protocol designed
for the Solana blockchain. It allows users to deposit a single underlying asset
(e.g., USDC or SOL) into a centralized Vault. The protocol mints yield-bearing
LP shares representing the user's proportional ownership of the aggregate pool.

The core value proposition is automated, cross-protocol asset allocation. Rather
than holding idle capital or risking funds in a single protocol, the Vault
delegates capital across isolated modular Strategies representing distinct asset
classes and risk tiers (e.g., Low-risk lending, Medium-risk market making,
High-risk Liquid Staking Tokens).

To comply with Solana’s strict compute budget, rebalancing is executed
atomically across individual trading pairs rather than iterating through an
unbounded array of protocols.

#### **2. Architectural Design & Separation of Concerns**

The system follows a fully decoupled, multi-account architecture to leverage
Solana's parallel execution engine (Sealevel). Storage and business logic are
strictly isolated into distinct modules.

**Account Topology**

- **YieldVault (Global State PDA):** Tracks global metadata, the total Assets
  Under Management (AUM), total minted supply of LP shares, execution safety
  cooldowns, and emergency circuit breakers.
- **AssetStrategy (Strategy State PDA):** An isolated account generated for
  every unique external protocol integration. It stores target allocations,
  current deployment volumes, risk tiers, and protocol-specific execution keys.

#### **3. Data Models (`src/state/`)**

**YieldVault**

```rust
pub struct YieldVault {
    pub name: [u8; 32],                // Human-readable identifier
    pub asset_mint: Pubkey,            // Underlying token mint address (e.g., USDC)
    pub lp_mint: Pubkey,               // Mint address for vault shares issued to depositors
    pub total_managed_assets: u64,     // Total AUM (Requires syncing prior to vault actions)
    pub strategy_count: u8,            // Total number of authorized strategies
    pub last_rebalance_timestamp: i64, // Cooldown tracker to mitigate flash-loan arbitrage
    pub emergency_shutdown: bool,      // Circuit breaker to halt deposits/withdrawals
}
```

**AssetStrategy**

```rust
pub struct AssetStrategy {
    pub vault: Pubkey,                 // Parent vault authority
    pub protocol_id: Pubkey,           // Target program ID (e.g., Kamino, Marginfi)
    pub token_vault_account: Pubkey,   // Protocol-specific escrow holding the funds
    pub current_allocation: u64,       // Active capital deployed in this specific protocol
    pub target_bps: u16,               // Target allocation in basis points (e.g., 4000 = 40.00%)
    pub risk_tier: u8,                 // Asset Class: 1 (Low), 2 (Medium), 3 (High)
    pub is_active: bool,               // Status flag for deposit eligibility
}
```

#### **4. Operational Cycles & Mathematical Invariants**

**1. Deposit Mechanics (SPL Tokenized Vault Pattern)** When a user deposits
underlying assets, the system calculates the quantity of vault shares
($S_{mint}$) to issue using an invariant distribution ratio. This prevents share
dilution. To protect against the first-depositor inflation attack, the vault
burns a fixed number of base shares on the initial deposit.

_Initial Deposit ($S_{supply} = 0$):_

$$S_{mint} = \text{amount} - 1000$$

_(Note: The $1000$ shares are minted to a dead address to lock the exchange rate
floor)._

_Subsequent Deposits ($S_{supply} > 0$):_

$$S_{mint} = \frac{\text{amount} \times S_{supply}}{AUM_{total}}$$

**2. The Splitting & Compute Unit (CU) Constraint (Rebalancing Logic)**
Iterating through an open array of strategies to execute deposits or withdrawals
inside a single Solana transaction will fail due to the Compute Budget Limit
(transactions max out at 1.4M CUs).

**Solution:** The rebalance model uses an atomic, pair-wise design. A registered
Keeper bot monitors oracles for changes in yield spreads. When a deviation
occurs, the Keeper executes `process_rebalance`, passing exactly Strategy A (to
withdraw from) and Strategy B (to deposit into). This approach shifts complex
indexing off-chain while keeping on-chain execution lightweight, predictable,
and resilient.

#### **5. Core Business Logic (`src/instructions/`)**

**`deposit.rs`**

- **Pre-conditions:** `emergency_shutdown` must be false. User must possess
  sufficient balance of the underlying token. The vault's `total_managed_assets`
  **must be synced** in the same transaction prior to calculating shares to
  ensure accrued yield is captured.
- **Execution:**

1. Evaluates vault invariants using fixed-point math (`u128` scale) rounding
   down to determine share allocation.
2. Executes a Cross-Program Invocation (CPI) to the SPL Token Program to
   transfer assets from the user to the vault token account.
3. Triggers a CPI to mint the calculated $S_{mint}$ shares directly into the
   user’s LP token wallet.
4. Mutates `total_managed_assets` to accurately record AUM shifts.

**`rebalance.rs`**

- **Pre-conditions:** Verified signatures from authorized Keeper or Governance.
  Cooldown checks (`current_time - last_rebalance_timestamp > threshold`) must
  pass to guarantee state stabilization.
- **Execution:**

1. Interacts with the Oracle account (e.g., Pyth Network) to verify data
   freshness and current market volatility parameters.
2. Computes allocation displacement vector:
   $\Delta = | \text{Current Allocation} - \text{Target Allocation} |$.
3. Deploys inline CPIs executing asymmetric operations:

- `invoke_signed` to call the withdrawal endpoint of Strategy A.
- `invoke_signed` to call the deposit/mint endpoint of Strategy B.

4. Recalculates both `AssetStrategy` metrics safely using `.checked_add()` and
   `.checked_sub()` wrappers to eliminate overflow risks.

#### **6. System Safety & Security Vectors**

- **Flash Loan Arbitrage Mitigation:** Rebalancing enforces a non-zero time-lock
  interval (`last_rebalance_timestamp`). This stops attackers from using flash
  loans to skew pool assets, trigger artificial rebalances, and withdraw with
  immediate profits in a single slot.
- **First-Depositor & Truncation Defenses:** To avoid zero-share mint exploits
  (a common vulnerability where small deposits yield rounded-down shares to
  steal value), the initial liquidity mint burns $10^3$ dead shares.
  Furthermore, all calculation metrics explicitly scale into intermediate `u128`
  space prior to final truncation down to standard `u64` values.
- **Cryptographic Vault Authority (PDA Isolation):** Strategy accounts are
  strictly derived using programmatic seeds
  (`[b"strategy", vault_pubkey, protocol_pubkey]`). External protocols can only
  access vault assets if signed with valid Program Derived Address seeds,
  ensuring complete protection against malicious signature forging.
