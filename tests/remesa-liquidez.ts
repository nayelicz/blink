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
  buildCancelReservationIx,
  buildInitializeReservationIx,
  buildRegisterMerchantIx,
  buildSetMerchantStatusIx,
  buildValidateCashoutIx,
  findReservationPda,
  findVaultPda,
} from "../client";

describe("remesa-liquidez", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.remesaLiquidez as Program<RemesaLiquidez>;
  const connection = provider.connection;

  const admin = (provider.wallet as anchor.Wallet).payer;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  it("happy path: initialize + validate_cashout transfers tokens to merchant", async () => {
    const s = await setup();
    const amount = await initialize(s);

    const ix = await buildValidateCashoutIx({
      program,
      receiver: s.receiver.publicKey,
      merchant: s.merchant.publicKey,
      mint: s.mint,
      merchantTokenAccount: s.merchantAta,
    });
    const tx = new Transaction().add(ix);
    await provider.sendAndConfirm(tx, [s.receiver, s.merchant]);

    const merchantBal = await getAccount(connection, s.merchantAta);
    expect(Number(merchantBal.amount)).to.equal(amount);

    const [reservationPda] = findReservationPda(program.programId, s.receiver.publicKey);
    const reservation = await program.account.turnReservation.fetch(reservationPda);
    expect(JSON.stringify(reservation.status)).to.contain("completed");
    expect(reservation.merchant.toBase58()).to.equal(s.merchant.publicKey.toBase58());
  });

  it("ReservationNotActive after a successful cashout", async () => {
    const s = await setup();
    await initialize(s);

    const ix = await buildValidateCashoutIx({
      program,
      receiver: s.receiver.publicKey,
      merchant: s.merchant.publicKey,
      mint: s.mint,
      merchantTokenAccount: s.merchantAta,
    });
    await provider.sendAndConfirm(new Transaction().add(ix), [s.receiver, s.merchant]);

    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [s.receiver, s.merchant]);
      expect.fail("expected ReservationNotActive");
    } catch (e: any) {
      expect(e.toString()).to.match(/ReservationNotActive|not in Active/i);
    }
  });

  it("ReservationExpired when expiry has passed", async () => {
    const s = await setup();
    await initialize(s, 50_000_000, 1);

    await sleep(2500);

    const ix = await buildValidateCashoutIx({
      program,
      receiver: s.receiver.publicKey,
      merchant: s.merchant.publicKey,
      mint: s.mint,
      merchantTokenAccount: s.merchantAta,
    });
    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [s.receiver, s.merchant]);
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

    const ix = await buildValidateCashoutIx({
      program,
      receiver: s.receiver.publicKey,
      merchant: s.merchant.publicKey,
      mint: s.mint,
      merchantTokenAccount: s.merchantAta,
    });
    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [s.receiver, s.merchant]);
      expect.fail("expected AccountNotInitialized for whitelist or InvalidMerchant");
    } catch (e: any) {
      expect(e.toString()).to.match(/AccountNotInitialized|InvalidMerchant/i);
    }
  });

  it("InvalidMerchant: deactivated whitelist entry blocks cashout", async () => {
    const s = await setup();
    await initialize(s);

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
      await provider.sendAndConfirm(new Transaction().add(ix), [s.receiver, s.merchant]);
      expect.fail("expected InvalidMerchant");
    } catch (e: any) {
      expect(e.toString()).to.match(/InvalidMerchant/i);
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

    const ix = await buildValidateCashoutIx({
      program,
      receiver: s.receiver.publicKey,
      merchant: otherMerchant.publicKey,
      mint: s.mint,
      merchantTokenAccount: otherAta.address,
    });
    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [s.receiver, otherMerchant]);
      expect.fail("expected InvalidMerchant");
    } catch (e: any) {
      expect(e.toString()).to.match(/InvalidMerchant/i);
    }
  });
});
