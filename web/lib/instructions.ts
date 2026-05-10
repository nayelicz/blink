/**
 * Helpers para construir instrucciones del programa Remesa+LiquidezIA
 * desde rutas server-side (Solana Actions / scripts).
 *
 * Mantienen las cuentas requeridas en un único lugar para evitar drift
 * entre rutas Blink y scripts E2E.
 */
import type { Program } from "@coral-xyz/anchor";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";

import type { RemesaLiquidez } from "@/types/remesa_liquidez";

export interface MarkVerifiedAccounts {
  /** Sender original de la reserva (firma la tx). */
  sender: PublicKey;
  /** PDA `TurnReservation` del receptor a desbloquear. */
  reservation: PublicKey;
}

/**
 * Construye la instrucción `mark_verified` que vira `is_verified = true`
 * sobre una `TurnReservation` existente. Sólo el sender original puede
 * firmar — el programa valida la relación `reservation.sender == sender`.
 */
export async function buildMarkVerifiedIx(
  program: Program<RemesaLiquidez>,
  accounts: MarkVerifiedAccounts
): Promise<TransactionInstruction> {
  return program.methods
    .markVerified()
    .accountsStrict({
      sender: accounts.sender,
      reservation: accounts.reservation,
    })
    .instruction();
}
