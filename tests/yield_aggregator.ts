import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import type { YieldAggregator } from "../target/types/yield_aggregator";
import { expect } from "chai";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAccount,
  createMint,
  getAccount,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

const INITIAL_DEAD_SHARES = 1_000;

describe("yield_aggregator", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.YieldAggregator as Program<YieldAggregator>;
  const client = program as any;
  const admin = provider.wallet.publicKey;

  function bn(value: number | bigint): anchor.BN {
    return new anchor.BN(value.toString());
  }

  function vaultName(name: string): number[] {
    const bytes = Buffer.alloc(32);
    bytes.write(name);
    return Array.from(bytes);
  }

  function expectPubkey(actual: PublicKey, expected: PublicKey): void {
    expect(actual.toBase58()).to.equal(expected.toBase58());
  }

  async function expectAnchorError(action: () => Promise<unknown>, errorName: string): Promise<void> {
    try {
      await action();
    } catch (err) {
      expect((err as Error).message).to.contain(errorName);
      return;
    }
    expect.fail(`Expected ${errorName}`);
  }

  async function latestBlockTime(): Promise<number> {
    const slot = await provider.connection.getSlot();
    const blockTime = await provider.connection.getBlockTime(slot);
    if (blockTime === null) {
      throw new Error("Local validator did not return a block time");
    }
    return blockTime;
  }

  async function setupVault(options: { emergencyShutdown?: boolean } = {}) {
    const vault = Keypair.generate();
    const [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), vault.publicKey.toBuffer()],
      program.programId,
    );

    const assetMint = await createMint(
      provider.connection,
      provider.wallet.payer,
      admin,
      null,
      6,
    );
    const lpMint = await createMint(
      provider.connection,
      provider.wallet.payer,
      vaultAuthority,
      null,
      6,
    );

    const vaultAssetAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        provider.wallet.payer,
        assetMint,
        vaultAuthority,
        true,
      )
    ).address;
    const lockedLpTokenAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        provider.wallet.payer,
        lpMint,
        vaultAuthority,
        true,
      )
    ).address;

    await client.methods
      .initializeVault(vaultName("USDC Vault"))
      .accounts({
        admin,
        vault: vault.publicKey,
        vaultAuthority,
        assetMint,
        lpMint,
        vaultAssetAccount,
        lockedLpTokenAccount,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([vault])
      .rpc();

    if (options.emergencyShutdown) {
      await client.methods
        .setEmergencyShutdown(true)
        .accounts({
          admin,
          vault: vault.publicKey,
        })
        .rpc();
    }

    return {
      vault,
      vaultAuthority,
      assetMint,
      lpMint,
      vaultAssetAccount,
      lockedLpTokenAccount,
    };
  }

  async function setupUser(assetMint: PublicKey, lpMint: PublicKey, assetBalance: number) {
    const user = Keypair.generate();

    const signature = await provider.connection.requestAirdrop(user.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(signature, "confirmed");

    const userAssetAccount = await createAccount(
      provider.connection,
      provider.wallet.payer,
      assetMint,
      user.publicKey,
    );
    const userLpAccount = await createAccount(
      provider.connection,
      provider.wallet.payer,
      lpMint,
      user.publicKey,
    );

    if (assetBalance > 0) {
      await mintTo(
        provider.connection,
        provider.wallet.payer,
        assetMint,
        userAssetAccount,
        provider.wallet.payer,
        assetBalance,
      );
    }

    return { user, userAssetAccount, userLpAccount };
  }

  async function deposit(
    amount: number,
    accounts: Awaited<ReturnType<typeof setupVault>> & Awaited<ReturnType<typeof setupUser>>,
  ) {
    return client.methods
      .deposit(bn(amount))
      .accounts({
        user: accounts.user.publicKey,
        vault: accounts.vault.publicKey,
        vaultAuthority: accounts.vaultAuthority,
        assetMint: accounts.assetMint,
        lpMint: accounts.lpMint,
        userAssetAccount: accounts.userAssetAccount,
        vaultAssetAccount: accounts.vaultAssetAccount,
        userLpAccount: accounts.userLpAccount,
        lockedLpTokenAccount: accounts.lockedLpTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([accounts.user])
      .rpc();
  }

  describe("initializeVault", () => {
    it("initializes vault metadata with the vault PDA as LP mint authority", async () => {
      const fixture = await setupVault();
      const vaultAccount = await client.account.yieldVault.fetch(fixture.vault.publicKey);
      const lpMint = await getMint(provider.connection, fixture.lpMint);

      expectPubkey(vaultAccount.admin, admin);
      expectPubkey(vaultAccount.assetMint, fixture.assetMint);
      expectPubkey(vaultAccount.lpMint, fixture.lpMint);
      expect(vaultAccount.totalManagedAssets.toNumber()).to.equal(0);
      expect(vaultAccount.strategyCount).to.equal(0);
      expect(vaultAccount.emergencyShutdown).to.equal(false);
      expectPubkey(lpMint.mintAuthority!, fixture.vaultAuthority);
    });

    it("rejects an LP mint not controlled by the vault PDA", async () => {
      const vault = Keypair.generate();
      const [vaultAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault_authority"), vault.publicKey.toBuffer()],
        program.programId,
      );
      const assetMint = await createMint(
        provider.connection,
        provider.wallet.payer,
        admin,
        null,
        6,
      );
      const lpMint = await createMint(
        provider.connection,
        provider.wallet.payer,
        admin,
        null,
        6,
      );
      const vaultAssetAccount = (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          provider.wallet.payer,
          assetMint,
          vaultAuthority,
          true,
        )
      ).address;
      const lockedLpTokenAccount = (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          provider.wallet.payer,
          lpMint,
          vaultAuthority,
          true,
        )
      ).address;

      await expectAnchorError(
        () => client.methods
          .initializeVault(vaultName("Bad LP Authority"))
          .accounts({
            admin,
            vault: vault.publicKey,
            vaultAuthority,
            assetMint,
            lpMint,
            vaultAssetAccount,
            lockedLpTokenAccount,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([vault])
          .rpc(),
        "InvalidMintAuthority",
      );
    });
  });

  describe("deposit", () => {
    it("transfers underlying assets, mints initial LP shares, and locks dead shares", async () => {
      const vaultFixture = await setupVault();
      const userFixture = await setupUser(vaultFixture.assetMint, vaultFixture.lpMint, 1_000_000);
      const accounts = { ...vaultFixture, ...userFixture };

      await deposit(1_000_000, accounts);

      const userAsset = await getAccount(provider.connection, accounts.userAssetAccount);
      const vaultAsset = await getAccount(provider.connection, accounts.vaultAssetAccount);
      const userLp = await getAccount(provider.connection, accounts.userLpAccount);
      const lockedLp = await getAccount(provider.connection, accounts.lockedLpTokenAccount);
      const lpMint = await getMint(provider.connection, accounts.lpMint);
      const vault = await client.account.yieldVault.fetch(accounts.vault.publicKey);

      expect(Number(userAsset.amount)).to.equal(0);
      expect(Number(vaultAsset.amount)).to.equal(1_000_000);
      expect(Number(userLp.amount)).to.equal(1_000_000 - INITIAL_DEAD_SHARES);
      expect(Number(lockedLp.amount)).to.equal(INITIAL_DEAD_SHARES);
      expect(Number(lpMint.supply)).to.equal(1_000_000);
      expect(vault.totalManagedAssets.toNumber()).to.equal(1_000_000);
    });

    it("mints subsequent LP shares pro rata using synced AUM and rounds down", async () => {
      const vaultFixture = await setupVault();
      const firstUser = await setupUser(vaultFixture.assetMint, vaultFixture.lpMint, 1_000_000);
      const secondUser = await setupUser(vaultFixture.assetMint, vaultFixture.lpMint, 333_333);

      await deposit(1_000_000, { ...vaultFixture, ...firstUser });
      await deposit(333_333, { ...vaultFixture, ...secondUser });

      const secondUserLp = await getAccount(provider.connection, secondUser.userLpAccount);
      const vaultAsset = await getAccount(provider.connection, vaultFixture.vaultAssetAccount);
      const lpMint = await getMint(provider.connection, vaultFixture.lpMint);
      const vault = await client.account.yieldVault.fetch(vaultFixture.vault.publicKey);

      expect(Number(secondUserLp.amount)).to.equal(333_333);
      expect(Number(vaultAsset.amount)).to.equal(1_333_333);
      expect(Number(lpMint.supply)).to.equal(1_333_333);
      expect(vault.totalManagedAssets.toNumber()).to.equal(1_333_333);
    });

    it("syncs accrued yield before share math and rejects zero-share deposits", async () => {
      const vaultFixture = await setupVault();
      const firstUser = await setupUser(vaultFixture.assetMint, vaultFixture.lpMint, 1_000_000);
      const tinyUser = await setupUser(vaultFixture.assetMint, vaultFixture.lpMint, 1);

      await deposit(1_000_000, { ...vaultFixture, ...firstUser });
      await mintTo(
        provider.connection,
        provider.wallet.payer,
        vaultFixture.assetMint,
        vaultFixture.vaultAssetAccount,
        provider.wallet.payer,
        1_000_000,
      );

      await expectAnchorError(
        () => deposit(1, { ...vaultFixture, ...tinyUser }),
        "ZeroShares",
      );

      const tinyUserAsset = await getAccount(provider.connection, tinyUser.userAssetAccount);
      const tinyUserLp = await getAccount(provider.connection, tinyUser.userLpAccount);
      const vault = await client.account.yieldVault.fetch(vaultFixture.vault.publicKey);

      expect(Number(tinyUserAsset.amount)).to.equal(1);
      expect(Number(tinyUserLp.amount)).to.equal(0);
      expect(vault.totalManagedAssets.toNumber()).to.equal(1_000_000);
    });

    it("rejects deposits while emergency shutdown is active without moving funds", async () => {
      const vaultFixture = await setupVault({ emergencyShutdown: true });
      const userFixture = await setupUser(vaultFixture.assetMint, vaultFixture.lpMint, 500_000);

      await expectAnchorError(
        () => deposit(500_000, { ...vaultFixture, ...userFixture }),
        "EmergencyShutdown",
      );

      const userAsset = await getAccount(provider.connection, userFixture.userAssetAccount);
      const vaultAsset = await getAccount(provider.connection, vaultFixture.vaultAssetAccount);
      expect(Number(userAsset.amount)).to.equal(500_000);
      expect(Number(vaultAsset.amount)).to.equal(0);
    });

    it("rejects initial deposits that cannot cover the locked dead shares", async () => {
      const vaultFixture = await setupVault();
      const userFixture = await setupUser(vaultFixture.assetMint, vaultFixture.lpMint, INITIAL_DEAD_SHARES);

      await expectAnchorError(
        () => deposit(INITIAL_DEAD_SHARES, { ...vaultFixture, ...userFixture }),
        "DepositTooSmall",
      );
    });

    it("rejects deposits when the user has insufficient underlying balance", async () => {
      const vaultFixture = await setupVault();
      const userFixture = await setupUser(vaultFixture.assetMint, vaultFixture.lpMint, 100_000);

      await expectAnchorError(
        () => deposit(1_000_000, { ...vaultFixture, ...userFixture }),
        "InsufficientFunds",
      );
    });
  });

  describe("rebalance", () => {
    async function setupStrategy(vaultFixture: Awaited<ReturnType<typeof setupVault>>, args: {
      protocolId?: PublicKey;
      currentAllocation: number;
      targetBps: number;
      riskTier: number;
    }) {
      const protocolId = args.protocolId ?? Keypair.generate().publicKey;
      const [strategy] = PublicKey.findProgramAddressSync(
        [Buffer.from("strategy"), vaultFixture.vault.publicKey.toBuffer(), protocolId.toBuffer()],
        program.programId,
      );
      const tokenVaultAccount = Keypair.generate().publicKey;

      await client.methods
        .initializeStrategy(bn(args.currentAllocation), args.targetBps, args.riskTier)
        .accounts({
          admin,
          vault: vaultFixture.vault.publicKey,
          strategy,
          protocolId,
          tokenVaultAccount,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      return { strategy, protocolId, tokenVaultAccount };
    }

    async function setupRebalanceFixture() {
      const vaultFixture = await setupVault();
      const userFixture = await setupUser(vaultFixture.assetMint, vaultFixture.lpMint, 1_000_000);
      await deposit(1_000_000, { ...vaultFixture, ...userFixture });

      const from = await setupStrategy(vaultFixture, {
        currentAllocation: 800_000,
        targetBps: 4_000,
        riskTier: 1,
      });
      const to = await setupStrategy(vaultFixture, {
        currentAllocation: 200_000,
        targetBps: 6_000,
        riskTier: 2,
      });

      return { vaultFixture, from, to };
    }

    it("moves allocation from an overweight strategy to an underweight strategy", async () => {
      const { vaultFixture, from, to } = await setupRebalanceFixture();
      const before = await latestBlockTime();

      await client.methods
        .rebalance()
        .accounts({
          admin,
          vault: vaultFixture.vault.publicKey,
          fromStrategy: from.strategy,
          toStrategy: to.strategy,
        })
        .rpc();

      const fromAfter = await client.account.assetStrategy.fetch(from.strategy);
      const toAfter = await client.account.assetStrategy.fetch(to.strategy);
      const vaultAfter = await client.account.yieldVault.fetch(vaultFixture.vault.publicKey);

      expect(fromAfter.currentAllocation.toNumber()).to.equal(400_000);
      expect(toAfter.currentAllocation.toNumber()).to.equal(600_000);
      expect(vaultAfter.totalManagedAssets.toNumber()).to.equal(1_000_000);
      expect(vaultAfter.lastRebalanceTimestamp.toNumber()).to.be.greaterThanOrEqual(before);
    });

    it("rejects strategy targets above 100 percent", async () => {
      const vaultFixture = await setupVault();

      await expectAnchorError(
        () => setupStrategy(vaultFixture, {
          currentAllocation: 0,
          targetBps: 10_001,
          riskTier: 1,
        }),
        "InvalidTargetBps",
      );

      const vault = await client.account.yieldVault.fetch(vaultFixture.vault.publicKey);
      expect(vault.strategyCount).to.equal(0);
    });

    it("rejects rebalances when both strategies are already at target", async () => {
      const vaultFixture = await setupVault();
      const userFixture = await setupUser(vaultFixture.assetMint, vaultFixture.lpMint, 1_000_000);
      await deposit(1_000_000, { ...vaultFixture, ...userFixture });
      const from = await setupStrategy(vaultFixture, {
        currentAllocation: 400_000,
        targetBps: 4_000,
        riskTier: 1,
      });
      const to = await setupStrategy(vaultFixture, {
        currentAllocation: 600_000,
        targetBps: 6_000,
        riskTier: 2,
      });

      await expectAnchorError(
        () => client.methods
          .rebalance()
          .accounts({
            admin,
            vault: vaultFixture.vault.publicKey,
            fromStrategy: from.strategy,
            toStrategy: to.strategy,
          })
          .rpc(),
        "NoRebalanceNeeded",
      );
    });

    it("rejects a second rebalance inside the cooldown window", async () => {
      const { vaultFixture, from, to } = await setupRebalanceFixture();

      await client.methods
        .rebalance()
        .accounts({
          admin,
          vault: vaultFixture.vault.publicKey,
          fromStrategy: from.strategy,
          toStrategy: to.strategy,
        })
        .rpc();

      await expectAnchorError(
        () => client.methods
          .rebalance()
          .accounts({
            admin,
            vault: vaultFixture.vault.publicKey,
            fromStrategy: from.strategy,
            toStrategy: to.strategy,
          })
          .rpc(),
        "RebalanceCooldown",
      );
    });

    it("rejects unauthorized callers", async () => {
      const { vaultFixture, from, to } = await setupRebalanceFixture();
      const unauthorized = Keypair.generate();
      const signature = await provider.connection.requestAirdrop(
        unauthorized.publicKey,
        anchor.web3.LAMPORTS_PER_SOL,
      );
      await provider.connection.confirmTransaction(signature, "confirmed");

      await expectAnchorError(
        () => client.methods
          .rebalance()
          .accounts({
            admin: unauthorized.publicKey,
            vault: vaultFixture.vault.publicKey,
            fromStrategy: from.strategy,
            toStrategy: to.strategy,
          })
          .signers([unauthorized])
          .rpc(),
        "Unauthorized",
      );
    });

    it("rejects inactive strategies", async () => {
      const { vaultFixture, from, to } = await setupRebalanceFixture();

      await client.methods
        .setStrategyActive(false)
        .accounts({
          admin,
          vault: vaultFixture.vault.publicKey,
          strategy: to.strategy,
        })
        .rpc();

      await expectAnchorError(
        () => client.methods
          .rebalance()
          .accounts({
            admin,
            vault: vaultFixture.vault.publicKey,
            fromStrategy: from.strategy,
            toStrategy: to.strategy,
          })
          .rpc(),
        "InactiveStrategy",
      );
    });

    it("rejects strategy pairs that do not belong to the vault", async () => {
      const { vaultFixture, from } = await setupRebalanceFixture();
      const otherVaultFixture = await setupVault();
      const otherStrategy = await setupStrategy(otherVaultFixture, {
        currentAllocation: 0,
        targetBps: 10_000,
        riskTier: 1,
      });

      await expectAnchorError(
        () => client.methods
          .rebalance()
          .accounts({
            admin,
            vault: vaultFixture.vault.publicKey,
            fromStrategy: from.strategy,
            toStrategy: otherStrategy.strategy,
          })
          .rpc(),
        "InvalidStrategyVault",
      );
    });
  });
});
