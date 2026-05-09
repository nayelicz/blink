import {
  ACTIONS_CORS_HEADERS,
  createPostResponse,
  type ActionGetResponse,
  type ActionPostRequest,
  type ActionPostResponse,
} from "@solana/actions";
import {
  PublicKey,
  Transaction,
} from "@solana/web3.js";

import { findReservationPda } from "@root/client";
import {
  ACTION_ICON_URL,
  getConnection,
  getProgram,
} from "@/lib/anchor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TITLE = "Verificar Receptor (World ID)";
const DESCRIPTION =
  "Confirma que el receptor completó la verificación de humanidad con World ID. Esta firma desbloquea el cobro en el comercio sin que el receptor tenga que firmar en la POS.";
const LABEL = "Marcar Verificado";

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
  const receiver = url.searchParams.get("receiver");

  if (!receiver) {
    const errResponse: ActionGetResponse = {
      icon: ACTION_ICON_URL,
      title: TITLE,
      label: LABEL,
      description:
        "Falta el parámetro 'receiver'. La Mini App debe pasar la pubkey del receptor verificado.",
      disabled: true,
    };
    return jsonWithCors(errResponse, { status: 400 });
  }

  try {
    new PublicKey(receiver);
  } catch {
    const errResponse: ActionGetResponse = {
      icon: ACTION_ICON_URL,
      title: TITLE,
      label: LABEL,
      description: "El parámetro 'receiver' no es una llave pública válida.",
      disabled: true,
    };
    return jsonWithCors(errResponse, { status: 400 });
  }

  const response: ActionGetResponse = {
    icon: ACTION_ICON_URL,
    title: TITLE,
    label: LABEL,
    description: DESCRIPTION,
  };
  return jsonWithCors(response);
}

export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    const receiverParam = url.searchParams.get("receiver");
    if (!receiverParam) {
      return jsonWithCors(
        { message: "Missing required query parameter: receiver" },
        { status: 400 }
      );
    }

    let receiver: PublicKey;
    try {
      receiver = new PublicKey(receiverParam);
    } catch {
      return jsonWithCors(
        { message: "Invalid 'receiver' query parameter" },
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
        { message: "Missing 'account' (sender pubkey) in body" },
        { status: 400 }
      );
    }

    let sender: PublicKey;
    try {
      sender = new PublicKey(body.account);
    } catch {
      return jsonWithCors(
        { message: "Invalid 'account' (not a Solana pubkey)" },
        { status: 400 }
      );
    }

    const connection = getConnection();
    const program = getProgram(connection);

    const [reservationPda] = findReservationPda(program.programId, receiver);
    const reservation = await program.account.turnReservation.fetchNullable(
      reservationPda
    );
    if (!reservation) {
      return jsonWithCors(
        {
          message:
            "TurnReservation no encontrada para ese receptor. Crea la reserva primero.",
        },
        { status: 404 }
      );
    }

    if (!reservation.sender.equals(sender)) {
      return jsonWithCors(
        {
          message:
            "Sólo el sender original de la reserva puede marcarla como verificada.",
        },
        { status: 403 }
      );
    }

    if (reservation.isVerified) {
      return jsonWithCors(
        { message: "Esta reserva ya está marcada como verificada." },
        { status: 409 }
      );
    }

    const ix = await program.methods
      .markVerified()
      .accountsStrict({
        sender,
        reservation: reservationPda,
      })
      .instruction();

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");

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
        message: `Confirmar verificación World ID para ${receiver.toBase58()}. Tras esta firma el receptor podrá cobrar en cualquier comercio whitelisteado sin firmar de nuevo.`,
      },
    });

    return jsonWithCors(payload);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[POST /api/actions/verify] error:", err);
    return jsonWithCors({ message }, { status: 500 });
  }
}
