import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { RemesaLiquidez } from "../target/types/remesa_liquidez";

export const RESERVATION_SEED = Buffer.from("reservation");
export const VAULT_SEED = Buffer.from("vault");
export const MERCHANT_SEED = Buffer.from("merchant");

export type RemesaProgram = Program<RemesaLiquidez>;

export function findReservationPda(
  programId: PublicKey,
  receiver: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [RESERVATION_SEED, receiver.toBuffer()],
    programId
  );
}

export function findVaultPda(
  programId: PublicKey,
  reservation: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, reservation.toBuffer()],
    programId
  );
}

export function findMerchantPda(
  programId: PublicKey,
  merchant: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [MERCHANT_SEED, merchant.toBuffer()],
    programId
  );
}

export interface InitializeReservationArgs {
  program: RemesaProgram;
  sender: PublicKey;
  receiver: PublicKey;
  mint: PublicKey;
  senderTokenAccount: PublicKey;
  amount: BN | number | bigint;
  expirySeconds: BN | number | bigint;
  preferredMerchant?: PublicKey | null;
}

export async function buildInitializeReservationIx(
  args: InitializeReservationArgs
): Promise<TransactionInstruction> {
  const [reservation] = findReservationPda(args.program.programId, args.receiver);
  const [vault] = findVaultPda(args.program.programId, reservation);

  const amount = new BN(args.amount.toString());
  const expirySeconds = new BN(args.expirySeconds.toString());

  return args.program.methods
    .initializeReservation(amount, expirySeconds, args.preferredMerchant ?? null)
    .accountsStrict({
      sender: args.sender,
      receiver: args.receiver,
      mint: args.mint,
      senderTokenAccount: args.senderTokenAccount,
      reservation,
      vault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .instruction();
}

export interface ValidateCashoutArgs {
  program: RemesaProgram;
  receiver: PublicKey;
  merchant: PublicKey;
  mint: PublicKey;
  merchantTokenAccount: PublicKey;
}

export async function buildValidateCashoutIx(
  args: ValidateCashoutArgs
): Promise<TransactionInstruction> {
  const [reservation] = findReservationPda(args.program.programId, args.receiver);
  const [vault] = findVaultPda(args.program.programId, reservation);
  const [merchantWhitelist] = findMerchantPda(
    args.program.programId,
    args.merchant
  );

  return args.program.methods
    .validateCashout()
    .accountsStrict({
      receiver: args.receiver,
      merchant: args.merchant,
      merchantWhitelist,
      reservation,
      mint: args.mint,
      vault,
      merchantTokenAccount: args.merchantTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

export interface CancelReservationArgs {
  program: RemesaProgram;
  signer: PublicKey;
  sender: PublicKey;
  receiver: PublicKey;
  mint: PublicKey;
  senderTokenAccount: PublicKey;
}

export async function buildCancelReservationIx(
  args: CancelReservationArgs
): Promise<TransactionInstruction> {
  const [reservation] = findReservationPda(args.program.programId, args.receiver);
  const [vault] = findVaultPda(args.program.programId, reservation);

  return args.program.methods
    .cancelReservation()
    .accountsStrict({
      signer: args.signer,
      sender: args.sender,
      reservation,
      mint: args.mint,
      vault,
      senderTokenAccount: args.senderTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

export interface RegisterMerchantArgs {
  program: RemesaProgram;
  admin: PublicKey;
  merchant: PublicKey;
}

export async function buildRegisterMerchantIx(
  args: RegisterMerchantArgs
): Promise<TransactionInstruction> {
  const [merchantAccount] = findMerchantPda(
    args.program.programId,
    args.merchant
  );

  return args.program.methods
    .registerMerchant(args.merchant)
    .accountsStrict({
      admin: args.admin,
      merchantAccount,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export interface SetMerchantStatusArgs {
  program: RemesaProgram;
  admin: PublicKey;
  merchant: PublicKey;
  active: boolean;
}

export async function buildSetMerchantStatusIx(
  args: SetMerchantStatusArgs
): Promise<TransactionInstruction> {
  const [merchantAccount] = findMerchantPda(
    args.program.programId,
    args.merchant
  );

  return args.program.methods
    .setMerchantStatus(args.active)
    .accountsStrict({
      admin: args.admin,
      merchantAccount,
    })
    .instruction();
}
