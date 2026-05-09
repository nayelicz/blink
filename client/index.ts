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
export const TREASURY_AUTHORITY_SEED = Buffer.from("treasury");
export const TREASURY_VAULT_SEED = Buffer.from("treasury_vault");
export const CONFIG_SEED = Buffer.from("config");

/** Protocol fee in basis points charged on every successful validate_cashout. */
export const FEE_BPS = 25;
export const BPS_DENOMINATOR = 10_000;

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

export function findTreasuryAuthorityPda(
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([TREASURY_AUTHORITY_SEED], programId);
}

export function findTreasuryTokenAccountPda(
  programId: PublicKey,
  mint: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [TREASURY_VAULT_SEED, mint.toBuffer()],
    programId
  );
}

export function findConfigPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId);
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
  const [treasuryAuthority] = findTreasuryAuthorityPda(args.program.programId);
  const [treasuryTokenAccount] = findTreasuryTokenAccountPda(
    args.program.programId,
    args.mint
  );

  return args.program.methods
    .validateCashout()
    .accountsStrict({
      merchant: args.merchant,
      merchantWhitelist,
      reservation,
      mint: args.mint,
      vault,
      merchantTokenAccount: args.merchantTokenAccount,
      treasuryAuthority,
      treasuryTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .instruction();
}

export interface MarkVerifiedArgs {
  program: RemesaProgram;
  sender: PublicKey;
  receiver: PublicKey;
}

export async function buildMarkVerifiedIx(
  args: MarkVerifiedArgs
): Promise<TransactionInstruction> {
  const [reservation] = findReservationPda(args.program.programId, args.receiver);
  return args.program.methods
    .markVerified()
    .accountsStrict({
      sender: args.sender,
      reservation,
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

export interface InitializeConfigArgs {
  program: RemesaProgram;
  admin: PublicKey;
}

export async function buildInitializeConfigIx(
  args: InitializeConfigArgs
): Promise<TransactionInstruction> {
  const [config] = findConfigPda(args.program.programId);
  return args.program.methods
    .initializeConfig()
    .accountsStrict({
      admin: args.admin,
      config,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export interface WithdrawTreasuryArgs {
  program: RemesaProgram;
  admin: PublicKey;
  mint: PublicKey;
  destinationTokenAccount: PublicKey;
  amount: BN | number | bigint;
}

export async function buildWithdrawTreasuryIx(
  args: WithdrawTreasuryArgs
): Promise<TransactionInstruction> {
  const [config] = findConfigPda(args.program.programId);
  const [treasuryAuthority] = findTreasuryAuthorityPda(args.program.programId);
  const [treasuryTokenAccount] = findTreasuryTokenAccountPda(
    args.program.programId,
    args.mint
  );

  return args.program.methods
    .withdrawTreasury(new BN(args.amount.toString()))
    .accountsStrict({
      admin: args.admin,
      config,
      mint: args.mint,
      treasuryAuthority,
      treasuryTokenAccount,
      destinationTokenAccount: args.destinationTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}
