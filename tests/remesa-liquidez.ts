import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";

import { RemesaLiquidez } from "../target/types/remesa_liquidez";
import {
  BPS_DENOMINATOR,
  FEE_BPS,
  buildCancelReservationIx,
  buildInitializeConfigIx,
  buildInitializeReservationIx,
  buildMarkVerifiedIx,
  buildRegisterMerchantIx,
  buildSetMerchantStatusIx,
  buildValidateCashoutIx,
  buildWithdrawTreasuryIx,
  findConfigPda,
  findReservationPda,
  findTreasuryTokenAccountPda,
  findVaultPda,
} from "../client";

describe("remesa-liquidez", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.remesaLiquidez as Program<RemesaLiquidez>;
  const connection = provider.connection;

  const admin = (provider.wallet as anchor.Wallet).payer;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  before("bootstrap protocol Config (idempotent across the suite)", async () => {
    const [configPda] = findConfigPda(program.programId);
    const existing = await connection.getAccountInfo(configPda);
    if (existing) return;
    const ix = await buildInitializeConfigIx({ program, admin: admin.publicKey });
    await provider.sendAndConfirm(new Transaction().add(ix), [admin]);
  });

  async function airdrop(pk: PublicKey, sol = 2) {
    const sig = await connection.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
    const latest = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  }

  async function setup(opts: { mintMerchant?: boolean } = { mintMerchant: true }) {
    const sender = Keypair.generate();
    const receiver = Keypair.generate();
    const merchant = Keypair.generate();

    await Promise.all([airdrop(sender.publicKey), airdrop(receiver.publicKey), airdrop(merchant.publicKey)]);

    const mint = await createMint(connection, admin, admin.publicKey, null, 6);

    const senderAta = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      mint,
      sender.publicKey
    );
    const merchantAta = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      mint,
      merchant.publicKey
    );

    await mintTo(connection, admin, mint, senderAta.address, admin, 1_000_000_000);

    if (opts.mintMerchant !== false) {
      const ix = await buildRegisterMerchantIx({
        program,
        admin: admin.publicKey,
        merchant: merchant.publicKey,
      });
      const tx = new Transaction().add(ix);
      await provider.sendAndConfirm(tx, [admin]);
    }

    return { sender, receiver, merchant, mint, senderAta: senderAta.address, merchantAta: merchantAta.address };
  }

  async function initialize(
    s: Awaited<ReturnType<typeof setup>>,
    amount = 100_000_000,
    expirySeconds = 60,
    preferredMerchant: PublicKey | null = null
  ) {
    const ix = await buildInitializeReservationIx({
      program,
      sender: s.sender.publicKey,
      receiver: s.receiver.publicKey,
      mint: s.mint,
      senderTokenAccount: s.senderAta,
      amount,
      expirySeconds,
      preferredMerchant,
    });
    const tx = new Transaction().add(ix);
    await provider.sendAndConfirm(tx, [s.sender]);
    return amount;
  }

  async function markVerified(s: Awaited<ReturnType<typeof setup>>) {
    const ix = await buildMarkVerifiedIx({
      program,
      sender: s.sender.publicKey,
      receiver: s.receiver.publicKey,
    });
    await provider.sendAndConfirm(new Transaction().add(ix), [s.sender]);
  }

  it("happy path: mark_verified + merchant-only validate_cashout splits fee 0.25% to treasury", async () => {
    const s = await setup();
    const amount = await initialize(s);
    await markVerified(s);

    const expectedFee = Math.floor((amount * FEE_BPS) / BPS_DENOMINATOR);
    const expectedNet = amount - expectedFee;

    const ix = await buildValidateCashoutIx({
      program,
      receiver: s.receiver.publicKey,
      merchant: s.merchant.publicKey,
      mint: s.mint,
      merchantTokenAccount: s.merchantAta,
    });
    const tx = new Transaction().add(ix);
    await provider.sendAndConfirm(tx, [s.merchant]);

    const merchantBal = await getAccount(connection, s.merchantAta);
    expect(Number(merchantBal.amount)).to.equal(expectedNet);

    const [treasuryTokenAccount] = findTreasuryTokenAccountPda(
      program.programId,
      s.mint
    );
    const treasuryBal = await getAccount(connection, treasuryTokenAccount);
    expect(Number(treasuryBal.amount)).to.equal(expectedFee);
    expect(expectedFee).to.be.greaterThan(0);

    const [reservationPda] = findReservationPda(program.programId, s.receiver.publicKey);
    const reservation = await program.account.turnReservation.fetch(reservationPda);
    expect(JSON.stringify(reservation.status)).to.contain("completed");
    expect(reservation.merchant.toBase58()).to.equal(s.merchant.publicKey.toBase58());
    expect(reservation.isVerified).to.equal(true);
  });

  it("treasury vault accumulates fees across multiple cashouts (same mint)", async () => {
    const a = await setup();
    const aAmount = await initialize(a, 200_000_000);
    await markVerified(a);

    await provider.sendAndConfirm(
      new Transaction().add(
        await buildValidateCashoutIx({
          program,
          receiver: a.receiver.publicKey,
          merchant: a.merchant.publicKey,
          mint: a.mint,
          merchantTokenAccount: a.merchantAta,
        })
      ),
      [a.merchant]
    );

    const b = await setup({ mintMerchant: true });
    // Reuse the same mint so the treasury vault is shared.
    const bAmount = 400_000_000;
    const senderAta2 = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      a.mint,
      b.sender.publicKey
    );
    await mintTo(connection, admin, a.mint, senderAta2.address, admin, 1_000_000_000);
    const merchantAta2 = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      a.mint,
      b.merchant.publicKey
    );

    const initIx = await buildInitializeReservationIx({
      program,
      sender: b.sender.publicKey,
      receiver: b.receiver.publicKey,
      mint: a.mint,
      senderTokenAccount: senderAta2.address,
      amount: bAmount,
      expirySeconds: 60,
    });
    await provider.sendAndConfirm(new Transaction().add(initIx), [b.sender]);
    await provider.sendAndConfirm(
      new Transaction().add(
        await buildMarkVerifiedIx({
          program,
          sender: b.sender.publicKey,
          receiver: b.receiver.publicKey,
        })
      ),
      [b.sender]
    );
    await provider.sendAndConfirm(
      new Transaction().add(
        await buildValidateCashoutIx({
          program,
          receiver: b.receiver.publicKey,
          merchant: b.merchant.publicKey,
          mint: a.mint,
          merchantTokenAccount: merchantAta2.address,
        })
      ),
      [b.merchant]
    );

    const expectedTotalFee =
      Math.floor((aAmount * FEE_BPS) / BPS_DENOMINATOR) +
      Math.floor((bAmount * FEE_BPS) / BPS_DENOMINATOR);

    const [treasuryTokenAccount] = findTreasuryTokenAccountPda(
      program.programId,
      a.mint
    );
    const treasuryBal = await getAccount(connection, treasuryTokenAccount);
    expect(Number(treasuryBal.amount)).to.equal(expectedTotalFee);
  });

  it("ReceiverNotVerified: cashout fails if mark_verified was never called", async () => {
    const s = await setup();
    await initialize(s);

    const ix = await buildValidateCashoutIx({
      program,
      receiver: s.receiver.publicKey,
      merchant: s.merchant.publicKey,
      mint: s.mint,
      merchantTokenAccount: s.merchantAta,
    });
    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [s.merchant]);
      expect.fail("expected ReceiverNotVerified");
    } catch (e: any) {
      expect(e.toString()).to.match(/ReceiverNotVerified|humanity verification/i);
    }
  });

  it("AlreadyVerified: mark_verified is idempotent (second call errors)", async () => {
    const s = await setup();
    await initialize(s);
    await markVerified(s);

    const ix = await buildMarkVerifiedIx({
      program,
      sender: s.sender.publicKey,
      receiver: s.receiver.publicKey,
    });
    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [s.sender]);
      expect.fail("expected AlreadyVerified");
    } catch (e: any) {
      expect(e.toString()).to.match(/AlreadyVerified|already been marked/i);
    }
  });

  it("mark_verified requires the original sender (SenderMismatch otherwise)", async () => {
    const s = await setup();
    await initialize(s);

    const intruder = Keypair.generate();
    await airdrop(intruder.publicKey);

    const ix = await buildMarkVerifiedIx({
      program,
      sender: intruder.publicKey,
      receiver: s.receiver.publicKey,
    });
    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [intruder]);
      expect.fail("expected SenderMismatch / has_one violation");
    } catch (e: any) {
      expect(e.toString()).to.match(/SenderMismatch|ConstraintHasOne|has[_ ]one/i);
    }
  });

  it("ReservationNotActive after a successful cashout", async () => {
    const s = await setup();
    await initialize(s);
    await markVerified(s);

    const ix = await buildValidateCashoutIx({
      program,
      receiver: s.receiver.publicKey,
      merchant: s.merchant.publicKey,
      mint: s.mint,
      merchantTokenAccount: s.merchantAta,
    });
    await provider.sendAndConfirm(new Transaction().add(ix), [s.merchant]);

    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [s.merchant]);
      expect.fail("expected ReservationNotActive");
    } catch (e: any) {
      expect(e.toString()).to.match(/ReservationNotActive|not in Active/i);
    }
  });

  it("ReservationExpired when expiry has passed", async () => {
    const s = await setup();
    await initialize(s, 50_000_000, 1);
    await markVerified(s);

    await sleep(2500);

    const ix = await buildValidateCashoutIx({
      program,
      receiver: s.receiver.publicKey,
      merchant: s.merchant.publicKey,
      mint: s.mint,
      merchantTokenAccount: s.merchantAta,
    });
    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [s.merchant]);
      expect.fail("expected ReservationExpired");
    } catch (e: any) {
      expect(e.toString()).to.match(/ReservationExpired|already expired/i);
    }
  });

  it("receiver can cancel anytime while Active and rent is refunded", async () => {
    const s = await setup();
    const amount = await initialize(s);

    const senderLamportsBefore = await connection.getBalance(s.sender.publicKey);

    const ix = await buildCancelReservationIx({
      program,
      signer: s.receiver.publicKey,
      sender: s.sender.publicKey,
      receiver: s.receiver.publicKey,
      mint: s.mint,
      senderTokenAccount: s.senderAta,
    });
    await provider.sendAndConfirm(new Transaction().add(ix), [s.receiver]);

    const senderBal = await getAccount(connection, s.senderAta);
    expect(Number(senderBal.amount)).to.equal(1_000_000_000);

    const senderLamportsAfter = await connection.getBalance(s.sender.publicKey);
    expect(senderLamportsAfter).to.be.greaterThan(senderLamportsBefore);

    const [reservationPda] = findReservationPda(program.programId, s.receiver.publicKey);
    const acc = await connection.getAccountInfo(reservationPda);
    expect(acc).to.equal(null);

    const [vaultPda] = findVaultPda(program.programId, reservationPda);
    const vaultAcc = await connection.getAccountInfo(vaultPda);
    expect(vaultAcc).to.equal(null);
  });

  it("WaitUntilExpiration: sender cannot cancel before expiry", async () => {
    const s = await setup();
    await initialize(s, 100_000_000, 60);

    const ix = await buildCancelReservationIx({
      program,
      signer: s.sender.publicKey,
      sender: s.sender.publicKey,
      receiver: s.receiver.publicKey,
      mint: s.mint,
      senderTokenAccount: s.senderAta,
    });
    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [s.sender]);
      expect.fail("expected WaitUntilExpiration");
    } catch (e: any) {
      expect(e.toString()).to.match(/WaitUntilExpiration|wait until expiration/i);
    }
  });

  it("sender can cancel after expiry; vault closed and refund delivered", async () => {
    const s = await setup();
    await initialize(s, 200_000_000, 1);
    await sleep(2500);

    const ix = await buildCancelReservationIx({
      program,
      signer: s.sender.publicKey,
      sender: s.sender.publicKey,
      receiver: s.receiver.publicKey,
      mint: s.mint,
      senderTokenAccount: s.senderAta,
    });
    await provider.sendAndConfirm(new Transaction().add(ix), [s.sender]);

    const senderBal = await getAccount(connection, s.senderAta);
    expect(Number(senderBal.amount)).to.equal(1_000_000_000);

    const [reservationPda] = findReservationPda(program.programId, s.receiver.publicKey);
    const acc = await connection.getAccountInfo(reservationPda);
    expect(acc).to.equal(null);
  });

  it("InvalidMerchant: cashout fails when merchant is not whitelisted", async () => {
    const s = await setup({ mintMerchant: false });
    await initialize(s);
    await markVerified(s);

    const ix = await buildValidateCashoutIx({
      program,
      receiver: s.receiver.publicKey,
      merchant: s.merchant.publicKey,
      mint: s.mint,
      merchantTokenAccount: s.merchantAta,
    });
    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [s.merchant]);
      expect.fail("expected AccountNotInitialized for whitelist or InvalidMerchant");
    } catch (e: any) {
      expect(e.toString()).to.match(/AccountNotInitialized|InvalidMerchant/i);
    }
  });

  it("InvalidMerchant: deactivated whitelist entry blocks cashout", async () => {
    const s = await setup();
    await initialize(s);
    await markVerified(s);

    const offIx = await buildSetMerchantStatusIx({
      program,
      admin: admin.publicKey,
      merchant: s.merchant.publicKey,
      active: false,
    });
    await provider.sendAndConfirm(new Transaction().add(offIx), [admin]);

    const ix = await buildValidateCashoutIx({
      program,
      receiver: s.receiver.publicKey,
      merchant: s.merchant.publicKey,
      mint: s.mint,
      merchantTokenAccount: s.merchantAta,
    });
    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [s.merchant]);
      expect.fail("expected InvalidMerchant");
    } catch (e: any) {
      expect(e.toString()).to.match(/InvalidMerchant/i);
    }
  });

  it("withdraw_treasury: admin can drain accumulated fees to a destination ATA", async () => {
    const s = await setup();
    const amount = await initialize(s, 800_000_000);
    await markVerified(s);
    await provider.sendAndConfirm(
      new Transaction().add(
        await buildValidateCashoutIx({
          program,
          receiver: s.receiver.publicKey,
          merchant: s.merchant.publicKey,
          mint: s.mint,
          merchantTokenAccount: s.merchantAta,
        })
      ),
      [s.merchant]
    );

    const expectedFee = Math.floor((amount * FEE_BPS) / BPS_DENOMINATOR);
    const [treasuryTokenAccount] = findTreasuryTokenAccountPda(
      program.programId,
      s.mint
    );
    const treasuryBefore = await getAccount(connection, treasuryTokenAccount);
    expect(Number(treasuryBefore.amount)).to.be.greaterThanOrEqual(expectedFee);

    const adminAta = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      s.mint,
      admin.publicKey
    );
    const adminBefore = await getAccount(connection, adminAta.address);

    const wIx = await buildWithdrawTreasuryIx({
      program,
      admin: admin.publicKey,
      mint: s.mint,
      destinationTokenAccount: adminAta.address,
      amount: expectedFee,
    });
    await provider.sendAndConfirm(new Transaction().add(wIx), [admin]);

    const adminAfter = await getAccount(connection, adminAta.address);
    expect(Number(adminAfter.amount) - Number(adminBefore.amount)).to.equal(
      expectedFee
    );

    const treasuryAfter = await getAccount(connection, treasuryTokenAccount);
    expect(Number(treasuryBefore.amount) - Number(treasuryAfter.amount)).to.equal(
      expectedFee
    );
  });

  it("withdraw_treasury: non-admin signer is rejected (UnauthorizedAdmin)", async () => {
    const s = await setup();
    await initialize(s);
    await markVerified(s);
    await provider.sendAndConfirm(
      new Transaction().add(
        await buildValidateCashoutIx({
          program,
          receiver: s.receiver.publicKey,
          merchant: s.merchant.publicKey,
          mint: s.mint,
          merchantTokenAccount: s.merchantAta,
        })
      ),
      [s.merchant]
    );

    const intruder = Keypair.generate();
    await airdrop(intruder.publicKey);
    const intruderAta = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      s.mint,
      intruder.publicKey
    );

    const wIx = await buildWithdrawTreasuryIx({
      program,
      admin: intruder.publicKey,
      mint: s.mint,
      destinationTokenAccount: intruderAta.address,
      amount: 1,
    });
    try {
      await provider.sendAndConfirm(new Transaction().add(wIx), [intruder]);
      expect.fail("expected UnauthorizedAdmin");
    } catch (e: any) {
      expect(e.toString()).to.match(/UnauthorizedAdmin|not the protocol admin/i);
    }
  });

  it("withdraw_treasury: InsufficientTreasury when amount exceeds balance", async () => {
    const s = await setup();
    await initialize(s);
    await markVerified(s);
    await provider.sendAndConfirm(
      new Transaction().add(
        await buildValidateCashoutIx({
          program,
          receiver: s.receiver.publicKey,
          merchant: s.merchant.publicKey,
          mint: s.mint,
          merchantTokenAccount: s.merchantAta,
        })
      ),
      [s.merchant]
    );

    const adminAta = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      s.mint,
      admin.publicKey
    );

    const wIx = await buildWithdrawTreasuryIx({
      program,
      admin: admin.publicKey,
      mint: s.mint,
      destinationTokenAccount: adminAta.address,
      amount: 10_000_000_000_000,
    });
    try {
      await provider.sendAndConfirm(new Transaction().add(wIx), [admin]);
      expect.fail("expected InsufficientTreasury");
    } catch (e: any) {
      expect(e.toString()).to.match(/InsufficientTreasury|insufficient/i);
    }
  });

  it("InvalidMerchant: pre-locked merchant cannot be replaced by another", async () => {
    const s = await setup();
    const otherMerchant = Keypair.generate();
    await airdrop(otherMerchant.publicKey);

    const otherAta = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      s.mint,
      otherMerchant.publicKey
    );
    const reg = await buildRegisterMerchantIx({
      program,
      admin: admin.publicKey,
      merchant: otherMerchant.publicKey,
    });
    await provider.sendAndConfirm(new Transaction().add(reg), [admin]);

    await initialize(s, 100_000_000, 60, s.merchant.publicKey);
    await markVerified(s);

    const ix = await buildValidateCashoutIx({
      program,
      receiver: s.receiver.publicKey,
      merchant: otherMerchant.publicKey,
      mint: s.mint,
      merchantTokenAccount: otherAta.address,
    });
    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [otherMerchant]);
      expect.fail("expected InvalidMerchant");
    } catch (e: any) {
      expect(e.toString()).to.match(/InvalidMerchant/i);
    }
  });
});
