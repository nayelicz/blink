import {
  ACTIONS_CORS_HEADERS,
  createPostResponse,
  type ActionGetResponse,
  type ActionPostRequest,
  type ActionPostResponse,
} from "@solana/actions";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  findMerchantPda,
  findTreasuryAuthorityPda,
  findTreasuryTokenAccountPda,
  findVaultPda,
} from "@root/client";
import { ACTION_ICON_URL, getConnection, getProgram } from "@/lib/anchor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ICON_URL = ACTION_ICON_URL;

const TITLE = "Retiro de Efectivo - TIA";
const DESCRIPTION =
  "Estás a punto de validar la entrega de efectivo. Asegúrate de haber verificado la identidad del receptor mediante World ID antes de firmar.";
const LABEL = "Finalizar Entrega";

function jsonWithCors(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...ACTIONS_CORS_HEADERS,
      ...(init.headers ?? {}),
    },
  });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: ACTIONS_CORS_HEADERS });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const pda = url.searchParams.get("pda");

  if (!pda) {
    const errResponse: ActionGetResponse = {
      icon: ICON_URL,
      title: TITLE,
      label: LABEL,
      description:
        "Falta el parámetro 'pda' (TurnReservation). Reescanea el QR del cliente o verifica el enlace de la blink.",
      disabled: true,
    };
    return jsonWithCors(errResponse, { status: 400 });
  }

  try {
    new PublicKey(pda);
  } catch {
    const errResponse: ActionGetResponse = {
      icon: ICON_URL,
      title: TITLE,
      label: LABEL,
      description:
        "El parámetro 'pda' no es una llave pública válida de Solana.",
      disabled: true,
    };
    return jsonWithCors(errResponse, { status: 400 });
  }

  const response: ActionGetResponse = {
    icon: ICON_URL,
    title: TITLE,
    label: LABEL,
    description: DESCRIPTION,
  };
  return jsonWithCors(response);
}

export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    const pda = url.searchParams.get("pda");
    if (!pda) {
      return jsonWithCors(
        { message: "Missing required query parameter: pda" },
        { status: 400 }
      );
    }

    let reservationPda: PublicKey;
    try {
      reservationPda = new PublicKey(pda);
    } catch {
      return jsonWithCors(
        { message: "Invalid 'pda' query parameter (not a Solana pubkey)" },
        { status: 400 }
      );
    }

    let body: ActionPostRequest;
    try {
      body = (await req.json()) as ActionPostRequest;
    } catch {
      return jsonWithCors(
        { message: "Invalid JSON body. Expected { account: <merchantPubkey> }" },
        { status: 400 }
      );
    }

    if (!body?.account) {
      return jsonWithCors(
        { message: "Missing 'account' (merchant pubkey) in body" },
        { status: 400 }
      );
    }

    let merchant: PublicKey;
    try {
      merchant = new PublicKey(body.account);
    } catch {
      return jsonWithCors(
        { message: "Invalid 'account' (not a Solana pubkey)" },
        { status: 400 }
      );
    }

    const connection = getConnection();
    const program = getProgram(connection);

    // Fetch the on-chain reservation. This validates the PDA exists.
    const reservation = await program.account.turnReservation.fetchNullable(
      reservationPda
    );
    if (!reservation) {
      return jsonWithCors(
        {
          message:
            "TurnReservation no encontrada en la red. Verifica el PDA y el cluster.",
        },
        { status: 404 }
      );
    }

    // Status guard mirrors the on-chain check but gives a friendly UX error.
    const statusKey = Object.keys(reservation.status)[0] ?? "unknown";
    if (statusKey !== "active") {
      return jsonWithCors(
        {
          message: `La reserva no está activa (estado actual: ${statusKey}).`,
        },
        { status: 400 }
      );
    }

    if (reservation.expiresAt.toNumber() <= Math.floor(Date.now() / 1000)) {
      return jsonWithCors(
        {
          message:
            "La reserva ya expiró. El sender puede solicitar un reembolso vía cancel_reservation.",
        },
        { status: 400 }
      );
    }

    // World ID gate: the sender must have flipped `is_verified` via
    // mark_verified before the receiver shows up at the merchant.
    if (!reservation.isVerified) {
      return jsonWithCors(
        {
          message:
            "El receptor aún no ha completado la verificación de humanidad (World ID). Pídele que complete la verificación en la app antes de cobrar.",
        },
        { status: 412 }
      );
    }

    // Lock-on-claim safety: if a merchant is already pre-selected, only that
    // merchant can validate. Pubkey::default() means "open".
    const lockedMerchant = reservation.merchant as PublicKey;
    if (
      !lockedMerchant.equals(PublicKey.default) &&
      !lockedMerchant.equals(merchant)
    ) {
      return jsonWithCors(
        {
          message:
            "Esta reserva está asignada a otro comerciante. No puedes validarla.",
        },
        { status: 403 }
      );
    }

    // Whitelist guard: the merchant must have a registered + active MerchantAccount.
    const [merchantWhitelistPda] = findMerchantPda(program.programId, merchant);
    const merchantWhitelist =
      await program.account.merchantAccount.fetchNullable(merchantWhitelistPda);
    if (!merchantWhitelist) {
      return jsonWithCors(
        {
          message:
            "El comerciante no está registrado en el whitelist on-chain.",
        },
        { status: 403 }
      );
    }
    if (!merchantWhitelist.active) {
      return jsonWithCors(
        { message: "El comerciante está deshabilitado actualmente." },
        { status: 403 }
      );
    }

    const merchantTokenAccount = getAssociatedTokenAddressSync(
      reservation.mint,
      merchant
    );
    const [vaultPda] = findVaultPda(program.programId, reservationPda);
    const [treasuryAuthority] = findTreasuryAuthorityPda(program.programId);
    const [treasuryTokenAccount] = findTreasuryTokenAccountPda(
      program.programId,
      reservation.mint
    );

    const ix = await program.methods
      .validateCashout()
      .accountsStrict({
        merchant,
        merchantWhitelist: merchantWhitelistPda,
        reservation: reservationPda,
        mint: reservation.mint,
        vault: vaultPda,
        merchantTokenAccount,
        treasuryAuthority,
        treasuryTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");

    const tx = new Transaction({
      feePayer: merchant,
      blockhash,
      lastValidBlockHeight,
    });
    tx.add(ix);

    // Single-signer: the merchant is the sole required signature. World ID
    // verification was already recorded on-chain via `mark_verified` (gated
    // above by `reservation.isVerified`). The contract splits the amount:
    // 99.75% goes to the merchant ATA, 0.25% to the protocol treasury PDA.
    const gross = BigInt(reservation.amount.toString());
    const fee = (gross * 25n) / 10000n;
    const net = gross - fee;
    const payload: ActionPostResponse = await createPostResponse({
      fields: {
        type: "transaction",
        transaction: tx,
        message: `Validar entrega de efectivo: recibirás ${net.toString()} (neto) y ${fee.toString()} se enviarán al tesoro del protocolo (0.25%).`,
      },
    });

    return jsonWithCors(payload);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[POST /api/actions/cashout] error:", err);
    return jsonWithCors({ message }, { status: 500 });
  }
}
