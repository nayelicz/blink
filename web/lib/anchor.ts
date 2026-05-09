import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  Transaction,
  VersionedTransaction,
  clusterApiUrl,
  type Cluster,
} from "@solana/web3.js";

import idl from "@root/target/idl/remesa_liquidez.json";
import type { RemesaLiquidez } from "@root/target/types/remesa_liquidez";

export function getCluster(): Cluster {
  const raw =
    process.env.SOLANA_CLUSTER ??
    process.env.NEXT_PUBLIC_SOLANA_CLUSTER ??
    "devnet";
  if (raw === "mainnet-beta" || raw === "testnet" || raw === "devnet") {
    return raw;
  }
  return "devnet";
}

export function getConnection(): Connection {
  const rpcUrl =
    process.env.SOLANA_RPC_URL ??
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ??
    clusterApiUrl(getCluster());
  return new Connection(rpcUrl, "confirmed");
}

/**
 * Minimal read-only wallet for server-side AnchorProvider — never signs.
 */
function readOnlyWallet() {
  const kp = Keypair.generate();
  return {
    publicKey: kp.publicKey,
    signTransaction: async <T extends Transaction | VersionedTransaction>(
      tx: T
    ): Promise<T> => tx,
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(
      txs: T[]
    ): Promise<T[]> => txs,
    payer: kp,
  };
}

export function getProgram(connection: Connection): Program<RemesaLiquidez> {
  const provider = new AnchorProvider(connection, readOnlyWallet(), {
    commitment: "confirmed",
  });
  return new Program<RemesaLiquidez>(
    idl as unknown as Idl,
    provider
  ) as unknown as Program<RemesaLiquidez>;
}

export const ACTION_ICON_URL =
  process.env.NEXT_PUBLIC_BLINK_ICON_URL ??
  "https://images.unsplash.com/photo-1556742031-c6961e8560b0?auto=format&fit=crop&w=1200&q=80";
