import {
  ACTIONS_CORS_HEADERS,
  createPostResponse,
  type ActionGetResponse,
  type ActionPostRequest,
  type ActionPostResponse,
} from "@solana/actions";
import { PublicKey, Transaction } from "@solana/web3.js";

import { ACTION_ICON_URL, getConnection, getProgram } from "@/lib/anchor";
import { buildMarkVerifiedIx } from "@/lib/instructions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TITLE = "TIA: Desbloquear Fondos";
const DESCRIPTION =
  "El receptor ha completado su validación de identidad. Al confirmar, permitirás que el comercio entregue el efectivo de forma segura.";
const LABEL = "Aprobar Retiro";
const LABEL_ALREADY_APPROVED = "Retiro ya aprobado";

/**
 * Icono dedicado al flow de verificación (orb/identidad). Se puede sobre-escribir
 * con `NEXT_PUBLIC_VERIFY_ICON_URL` para mantener consistencia con la marca World ID.
 */
const VERIFY_ICON_URL =
  process.env.NEXT_PUBLIC_VERIFY_ICON_URL ?? ACTION_ICON_URL;

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

function parsePubkey(raw: string | null): PublicKey | null {
  if (!raw) return null;
  try {
    return new PublicKey(raw);
  } catch {
    return null;
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: ACTIONS_CORS_HEADERS });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const pdaRaw = url.searchParams.get("pda");

  if (!pdaRaw) {
    const errResponse: ActionGetResponse = {
      icon: VERIFY_ICON_URL,
      title: TITLE,
      label: LABEL,
      description:
        "Falta el parámetro 'pda' (TurnReservation). Reescanea el QR del receptor o revisa el enlace de la blink.",
      disabled: true,
    };
    return jsonWithCors(errResponse, { status: 400 });
  }

  const reservationPda = parsePubkey(pdaRaw);
  if (!reservationPda) {
    const errResponse: ActionGetResponse = {
      icon: VERIFY_ICON_URL,
      title: TITLE,
      label: LABEL,
      description: "El parámetro 'pda' no es una llave pública válida.",
      disabled: true,
    };
    return jsonWithCors(errResponse, { status: 400 });
  }

  try {
    const connection = getConnection();
    const program = getProgram(connection);

    const reservation = await program.account.turnReservation.fetchNullable(
      reservationPda
    );

    if (!reservation) {
      const errResponse: ActionGetResponse = {
        icon: VERIFY_ICON_URL,
        title: TITLE,
        label: LABEL,
        description:
          "TurnReservation no encontrada. Verifica que la reserva exista en devnet antes de aprobar.",
        disabled: true,
      };
      return jsonWithCors(errResponse, { status: 404 });
    }

    if (reservation.isVerified === true) {
      const alreadyVerified: ActionGetResponse = {
        icon: VERIFY_ICON_URL,
        title: TITLE,
        label: LABEL_ALREADY_APPROVED,
        description:
          "Esta reserva ya fue marcada como verificada. El receptor puede cobrar en cualquier comercio whitelisteado sin firmar de nuevo.",
        disabled: true,
      };
      return jsonWithCors(alreadyVerified);
    }

    const response: ActionGetResponse = {
      icon: VERIFY_ICON_URL,
      title: TITLE,
      label: LABEL,
      description: DESCRIPTION,
    };
    return jsonWithCors(response);
  } catch (err) {
    console.error("[GET /api/actions/verify] error:", err);
    const errResponse: ActionGetResponse = {
      icon: VERIFY_ICON_URL,
      title: TITLE,
      label: LABEL,
      description:
        "No se pudo leer el estado de la reserva en este momento. Reintenta en unos segundos.",
      disabled: true,
    };
    return jsonWithCors(errResponse, { status: 503 });
  }
}

export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    const reservationPda = parsePubkey(url.searchParams.get("pda"));
    if (!reservationPda) {
      return jsonWithCors(
        {
          message:
            "Missing or invalid 'pda' query parameter (TurnReservation PDA).",
        },
        { status: 400 }
      );
    }

    let body: ActionPostRequest;
    try {
      body = (await req.json()) as ActionPostRequest;
    } catch {
      return jsonWithCors(
        { message: "Invalid JSON body. Expected { account: <senderPubkey> }" },
        { status: 400 }
      );
    }

    if (!body?.account) {
      return jsonWithCors(
        { message: "Missing 'account' (sender pubkey) in body." },
        { status: 400 }
      );
    }

    let sender: PublicKey;
    try {
      sender = new PublicKey(body.account);
    } catch {
      return jsonWithCors(
        { message: "Invalid 'account' (not a Solana pubkey)." },
        { status: 400 }
      );
    }

    const connection = getConnection();
    const program = getProgram(connection);

    const reservation = await program.account.turnReservation.fetchNullable(
      reservationPda
    );
    if (!reservation) {
      return jsonWithCors(
        {
          message:
            "TurnReservation no encontrada para esa PDA. Verifica el enlace de la blink.",
        },
        { status: 404 }
      );
    }

    if (!reservation.sender.equals(sender)) {
      return jsonWithCors(
        {
          message:
            "Sólo el sender original de la reserva puede aprobar el retiro.",
        },
        { status: 403 }
      );
    }

    if (reservation.isVerified === true) {
      return jsonWithCors(
        { message: "Esta reserva ya fue marcada como verificada." },
        { status: 409 }
      );
    }

    const ix = await buildMarkVerifiedIx(program, {
      sender,
      reservation: reservationPda,
    });

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(
      "confirmed"
    );

    const tx = new Transaction({
      feePayer: sender,
      blockhash,
      lastValidBlockHeight,
    });
    tx.add(ix);

    const payload: ActionPostResponse = await createPostResponse({
      fields: {
        type: "transaction",
        transaction: tx,
        message: `Aprobar retiro para la reserva ${reservationPda.toBase58()}. Tras esta firma el receptor podrá cobrar el efectivo en cualquier comercio whitelisteado.`,
      },
    });

    return jsonWithCors(payload);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[POST /api/actions/verify] error:", err);
    return jsonWithCors({ message }, { status: 500 });
  }
}
