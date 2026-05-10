// ─────────────────────────────────────────────────────────
// lidiaBlinkRoutes.ts  –  Solana Blink multi-paso para LidIA
//
// Flujo:
//   GET  /api/actions/lidia-retiro              → Paso 1: oferta de LidIA
//   POST /api/actions/lidia-retiro              → Paso 2: acepta/rechaza cashback
//   GET  /api/actions/lidia-retiro/horario      → Paso 3: elige hora y sucursal
//   POST /api/actions/lidia-retiro/horario      → Paso 4: confirma y mintea ticket cNFT
// ─────────────────────────────────────────────────────────

import { Router, Request, Response } from "express";
import { createPostResponse, type ActionGetResponse } from "@solana/actions";
import {
  Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { computePricing } from "../pricing/pricingEngine.js";
import { mintTicket } from "../services/cNFTService.js";
import { reserveSlot } from "../pricing/liquidityService.js";
import pool from "../db/pool.js";

const router = Router();
const RPC_URL  = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const BASE_URL = process.env.BLINKS_BASE_URL || process.env.BASE_URL || "http://localhost:3000";

// ── GET /api/actions/lidia-retiro/preview ────────────────────────────────────
// Página HTML con OpenGraph tags — genera el preview visual en WhatsApp
// WhatsApp lee estos tags cuando preview_url: true está activo
router.get("/api/actions/lidia-retiro/preview", async (req: Request, res: Response) => {
  try {
    const amountUSDC = parseFloat(req.query.amount as string) || 50;
    const zone       = (req.query.zone as string) || "";
    const wallet     = (req.query.wallet as string) || "";

    const decision = await computePricing({
      walletSolana: wallet || "11111111111111111111111111111111",
      amountUSDC,
      userWA: "",
      zone,
      isUrgent: false,
    });

    const store    = decision.recommendedStores[0];
    const hora     = decision.optimalWindowStart.toLocaleTimeString("es-MX", {
      hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City",
    });
    const amountMXN  = (amountUSDC * 17.20).toFixed(0);
    const pdaParam   = req.query.pda as string | undefined;
    const blinkUrl   = pdaParam
      ? `solana-action:https://web-coral-pi-66.vercel.app/api/actions/cashout?pda=${pdaParam}`
      : `solana-action:${BASE_URL}/api/actions/lidia-retiro?amount=${amountUSDC}&zone=${encodeURIComponent(zone)}${wallet ? `&wallet=${wallet}` : ""}`;
    const pageTitle  = pdaParam ? "Validar retiro en tienda" : `Retiro de $${amountUSDC} USDC`;
    const btnLabel   = pdaParam ? "🏪 Validar cashout (comerciante)" : "🎟 Abrir con wallet Solana";
    const description = `💰 $${amountUSDC} USDC (~$${amountMXN} MXN) · ✨ +$${decision.cashbackUSDC} USDC cashback si retiras a las ${hora} · 📍 ${store?.storeName ?? "Tienda cercana"}`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>

  <!-- OpenGraph — WhatsApp lee estos tags para el preview visual -->
  <meta property="og:type"        content="website"/>
  <meta property="og:url"         content="${BASE_URL}/api/actions/lidia-retiro/preview?amount=${amountUSDC}&zone=${encodeURIComponent(zone)}"/>
  <meta property="og:title"       content="🎙 LidIA — Retiro de $${amountUSDC} USDC (~$${amountMXN} MXN)"/>
  <meta property="og:description" content="${description}"/>
  <meta property="og:image"       content="${BASE_URL}/lidia-icon.png"/>
  <meta property="og:image:width" content="512"/>
  <meta property="og:image:height"content="512"/>

  <!-- Twitter / Telegram -->
  <meta name="twitter:card"        content="summary_large_image"/>
  <meta name="twitter:title"       content="🎙 LidIA — Retiro de $${amountUSDC} USDC"/>
  <meta name="twitter:description" content="${description}"/>
  <meta name="twitter:image"       content="${BASE_URL}/lidia-icon.png"/>

  <title>LidIA — Retiro de $${amountUSDC} USDC</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, sans-serif; background: #0f0f0f; color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 16px; padding: 2rem; max-width: 420px; width: 100%; text-align: center; }
    img { width: 100px; height: 100px; border-radius: 50%; margin-bottom: 1rem; }
    h1 { font-size: 1.2rem; font-weight: 700; margin-bottom: 0.5rem; background: linear-gradient(90deg, #9945FF, #14F195); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    p { color: #888; font-size: 0.9rem; line-height: 1.6; margin-bottom: 1.5rem; }
    .blink-btn { display: block; background: #9945FF; color: #fff; text-decoration: none; padding: 0.85rem 1.5rem; border-radius: 10px; font-weight: 600; font-size: 0.95rem; margin-bottom: 0.75rem; }
    .cashback { background: #0d2e1a; border: 1px solid #14F195; border-radius: 8px; padding: 0.75rem; color: #14F195; font-size: 0.85rem; margin-bottom: 1rem; }
    .store { color: #555; font-size: 0.8rem; }
  </style>
</head>
<body>
  <div class="card">
    <img src="${BASE_URL}/lidia-icon.png" alt="LidIA"/>
    <h1>${pageTitle}</h1>
    <p>~$${amountMXN} MXN disponibles para retirar</p>
    <div class="cashback">✨ Cashback disponible: +$${decision.cashbackUSDC} USDC si retiras a las ${hora}</div>
    <a class="blink-btn" href="${blinkUrl}">${btnLabel}</a>
    <div class="store">📍 ${store?.storeName ?? "Tienda cercana"} · ${store?.zone ?? ""}</div>
  </div>
</body>
</html>`);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});
// URL: /api/actions/lidia-retiro?amount=50&zone=Roma+Norte
router.get("/api/actions/lidia-retiro", async (req: Request, res: Response) => {
  try {
    const amountUSDC = parseFloat(req.query.amount as string) || 50;
    const zone       = (req.query.zone as string) || "";

    // Calcular pricing dinámico
    const decision = await computePricing({
      walletSolana: "11111111111111111111111111111111", // placeholder para GET
      amountUSDC,
      userWA: "",
      zone,
      isUrgent: false,
    });

    const store    = decision.recommendedStores[0];
    const hora     = decision.optimalWindowStart.toLocaleTimeString("es-MX", {
      hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City",
    });
    const amountMXN = (amountUSDC * 17.20).toFixed(0);
    const slotEmoji = decision.timeSlot.type === "peak" ? "🔴 Hora pico" :
                      decision.timeSlot.type === "valley" ? "🟢 Hora valle" : "🟡 Hora normal";

    const response: ActionGetResponse = {
      type:        "action",
      title:       `🎙 LidIA — Retiro de $${amountUSDC} USDC (~$${amountMXN} MXN)`,
      icon:        `${BASE_URL}/lidia-icon.png`,
      description: `${slotEmoji}\n\n` +
                   `💰 Si retiras ahora: comisión estándar $${decision.baseFeeUSDC} USDC\n` +
                   `✨ Si esperas a las ${hora}: +$${decision.cashbackUSDC} USDC cashback\n` +
                   `📍 Sucursal sugerida: ${store?.storeName ?? "Tienda cercana"} (${store?.zone ?? ""})\n\n` +
                   `_${decision.lidiaScript}_`,
      label:       "Ver opciones de retiro",
      links: {
        actions: [
          {
            type:  "transaction",
            label: `✅ Aceptar cashback (+$${decision.cashbackUSDC} USDC a las ${hora})`,
            href:  `${BASE_URL}/api/actions/lidia-retiro?amount=${amountUSDC}&zone=${encodeURIComponent(zone)}&accept=true`,
            parameters: [
              { name: "account", label: "Tu wallet de Solana", required: true, type: "text" },
            ],
          },
          {
            type:  "transaction",
            label: "⚡ Retirar ahora (sin espera)",
            href:  `${BASE_URL}/api/actions/lidia-retiro?amount=${amountUSDC}&zone=${encodeURIComponent(zone)}&accept=false`,
            parameters: [
              { name: "account", label: "Tu wallet de Solana", required: true, type: "text" },
            ],
          },
        ],
      },
    };

    return res.json(response);
  } catch (err) {
    console.error("[LidiaBlink] GET error:", err);
    return res.status(500).json({ error: (err as Error).message });
  }
});

// ── PASO 2: POST — Procesa la decisión del usuario ────────────────────────────
router.post("/api/actions/lidia-retiro", async (req: Request, res: Response) => {
  try {
    const amountUSDC = parseFloat(req.query.amount as string) || 50;
    const zone       = (req.query.zone as string) || "";
    const accept     = req.query.accept === "true";
    const { account } = req.body;

    if (!account) return res.status(400).json({ error: "account requerido" });

    const walletSolana = account as string;
    const connection   = new Connection(RPC_URL, "confirmed");
    const publicKey    = new PublicKey(walletSolana);

    // Calcular pricing
    const decision = await computePricing({ walletSolana, amountUSDC, userWA: "", zone, isUrgent: !accept });

    // Transacción simbólica: transferencia de 0 SOL (memo de intención)
    // En producción: transferir el monto al escrow del programa Anchor
    const { blockhash } = await connection.getLatestBlockhash();
    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.feePayer        = publicKey;

    // Agregar instrucción memo con el ticket
    tx.add(SystemProgram.transfer({
      fromPubkey: publicKey,
      toPubkey:   publicKey,
      lamports:   0,
    }));

    if (accept) {
      // Usuario aceptó el cashback → ir al paso de horario
      const store    = decision.recommendedStores[0];
      const hora     = decision.optimalWindowStart.toLocaleTimeString("es-MX", {
        hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City",
      });

      const payload = await createPostResponse({
        fields: {
          type:        "transaction",
          transaction: tx,
          message:     `✅ ¡Excelente! Te reservamos tu turno para las ${hora} en ${store?.storeName ?? "tienda cercana"}. Cashback: +$${decision.cashbackUSDC} USDC`,
          links: {
            next: {
              type: "inline",
              action: {
                type:        "action",
                title:       "🎟 Confirmar ticket de retiro",
                icon:        `${BASE_URL}/lidia-icon.png`,
                description: `📍 ${store?.storeName} · 🕐 ${hora} · 💰 +$${decision.cashbackUSDC} USDC cashback\n\nFirma para mintear tu ticket cNFT en Solana y bloquear los fondos en escrow.`,
                label:       "Confirmar y mintear ticket",
                links: {
                  actions: [{
                    type:  "transaction",
                    label: "🎟 Mintear Ticket cNFT",
                    href:  `${BASE_URL}/api/actions/lidia-retiro/confirmar?amount=${amountUSDC}&zone=${encodeURIComponent(zone)}&store=${store?.storeId ?? "spin-001"}&cashback=${decision.cashbackUSDC}&window=${decision.optimalWindowStart.toISOString()}`,
                    parameters: [
                      { name: "account", label: "Tu wallet", required: true, type: "text" },
                    ],
                  }],
                },
              },
            },
          },
        },
      });

      return res.json(payload);
    } else {
      // Usuario rechazó → retiro inmediato
      const payload = await createPostResponse({
        fields: {
          type:        "transaction",
          transaction: tx,
          message:     `⚡ Retiro inmediato registrado. Ve a cualquier tienda aliada con tu código: RB-${Date.now().toString(36).toUpperCase()}`,
        },
      });
      return res.json(payload);
    }
  } catch (err) {
    console.error("[LidiaBlink] POST error:", err);
    return res.status(500).json({ error: (err as Error).message });
  }
});

// ── PASO 4: POST — Confirmar y mintear ticket cNFT ───────────────────────────
router.post("/api/actions/lidia-retiro/confirmar", async (req: Request, res: Response) => {
  try {
    const amountUSDC  = parseFloat(req.query.amount as string) || 50;
    const storeId     = (req.query.store as string) || "spin-001";
    const cashback    = parseFloat(req.query.cashback as string) || 0;
    const windowStart = new Date((req.query.window as string) || Date.now());
    const { account } = req.body;

    if (!account) return res.status(400).json({ error: "account requerido" });

    const walletSolana = account as string;
    const connection   = new Connection(RPC_URL, "confirmed");
    const publicKey    = new PublicKey(walletSolana);

    // Reservar slot en aliado
    const { code, expiresAt } = await reserveSlot(storeId, amountUSDC * 17.20, windowStart);

    // Mintear cNFT
    const mintResult = await mintTicket({
      ticketCode:   code,
      userWA:       "",
      walletSolana,
      amountUSDC,
      storeName:    storeId,
      windowStart,
      cashbackUSDC: cashback,
    });

    // Guardar en DB
    await pool.query(
      `INSERT INTO withdrawal_tickets
       (ticket_code, cnft_mint, wallet_solana, user_wa, amount_usdc,
        store_id, store_name, zone, source, window_start, window_end,
        cashback_usdc, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        code, mintResult.signature, walletSolana, "", amountUSDC,
        storeId, storeId, null, "spin",
        windowStart,
        new Date(windowStart.getTime() + 2 * 3600_000),
        cashback, expiresAt,
      ]
    );

    // Transacción simbólica de confirmación
    const { blockhash } = await connection.getLatestBlockhash();
    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.feePayer        = publicKey;
    tx.add(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: publicKey, lamports: 0 }));

    const hora = windowStart.toLocaleTimeString("es-MX", {
      hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City",
    });

    const payload = await createPostResponse({
      fields: {
        type:        "transaction",
        transaction: tx,
        message:     `🎟 ¡Ticket minteado en Solana!\n\nCódigo: ${code}\n🕐 ${hora}\n💰 Cashback: +$${cashback} USDC al retirar\n🌐 Lleva tu teléfono para validar con World ID`,
      },
    });

    return res.json(payload);
  } catch (err) {
    console.error("[LidiaBlink] confirmar error:", err);
    return res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
