# Deploy guide — Remesa+liquidezIA

## Local validator (already working)

```bash
anchor build
anchor test
```

12+ integration tests pass on `solana-test-validator`.

## Devnet

### 1. Wallet + funding

```bash
solana config set --url devnet
solana address                   # current address
solana balance
```

You need ~5 SOL on devnet for the program deploy (~400 KB binary).
The CLI airdrop is heavily rate-limited; use the web faucet:
https://faucet.solana.com
(paste the address from `solana address`).

### 2. Build + deploy

```bash
anchor build
anchor deploy --provider.cluster devnet
```

If the deploy fails halfway, recover the buffer rent and retry:

```bash
solana program close --buffers --keypair ~/.config/solana/id.json
```

### 3. Bootstrap protocol Config (one-shot)

The `Config` PDA must exist before anyone can call `withdraw_treasury`.

```bash
cd web
npx ts-node --esm -e "
import * as anchor from '@coral-xyz/anchor';
import { Connection, Transaction, clusterApiUrl } from '@solana/web3.js';
import { buildInitializeConfigIx } from '../client';
import { getProgram, getConnection } from './lib/anchor';
const wallet = anchor.AnchorProvider.env().wallet as anchor.Wallet;
const conn = getConnection();
const program = getProgram(conn);
const ix = await buildInitializeConfigIx({ program, admin: wallet.publicKey });
const sig = await anchor.AnchorProvider.env().sendAndConfirm(new Transaction().add(ix));
console.log('Config initialized:', sig);
"
```

Or, more conservatively, add a `scripts/init-config.ts` to the repo that the
team runs once at deploy time.

### 4. Whitelist merchants

Each merchant pubkey must be registered before they can settle cashouts:

```bash
# pseudocode — wire this into a small CLI or a Web admin UI
buildRegisterMerchantIx({ program, admin, merchant })
```

## Web (Next.js / Vercel)

### Required env vars

```
SOLANA_CLUSTER=devnet
SOLANA_RPC_URL=<your Helius / Triton / Quicknode devnet RPC>
NEXT_PUBLIC_BLINK_ICON_URL=https://<your-cdn>/icon.png
```

### Pre-build hook

Vercel must have access to `target/idl/remesa_liquidez.json` and
`target/types/remesa_liquidez.ts` (these are gitignored). Two options:

1. **Recommended** — copy the artifacts into `web/` before pushing:
   ```bash
   mkdir -p web/idl web/types
   cp target/idl/remesa_liquidez.json web/idl/
   cp target/types/remesa_liquidez.ts  web/types/
   ```
   then update the `@root/target/...` imports to `@/idl/...` / `@/types/...`.

2. Or run `anchor build` as a preinstall step in CI.

### Endpoints exposed

| Path                         | Purpose                                          |
|------------------------------|--------------------------------------------------|
| `GET /actions.json`          | Dial.to discovery (registers Action URL paths)   |
| `GET /api/actions/cashout`   | Blink metadata for the merchant cash-out         |
| `POST /api/actions/cashout`  | Builds the merchant-signed `validate_cashout` tx |
| `GET /api/actions/verify`    | Blink metadata for the sender's verify-step      |
| `POST /api/actions/verify`   | Builds the sender-signed `mark_verified` tx      |

### Testing the Blink

Once deployed at `https://<your-domain>`:

1. Open `https://dial.to/?action=solana-action:https://<your-domain>/api/actions/verify?receiver=<receiverPubkey>`
2. Connect a wallet that holds the `sender` pubkey of the reservation.
3. Sign — `is_verified` flips on-chain.
4. Open `https://dial.to/?action=solana-action:https://<your-domain>/api/actions/cashout?pda=<reservationPda>`
5. Connect a whitelisted merchant wallet. Sign. Tokens flow.

## Smoke test sequence (devnet)

```
1. anchor deploy
2. initialize_config (admin = your wallet)
3. register_merchant (merchant_a, merchant_b, ...)
4. mint a fake "MXNe" SPL token (decimals = 6) — use spl-token CLI
5. initialize_reservation { sender, receiver, mint, amount=100 MXNe, expiry=24h }
6. mark_verified  (sender signs — Blink #1)
7. validate_cashout (merchant signs — Blink #2)
8. Verify: merchantATA gained 99.75, treasury vault gained 0.25
9. withdraw_treasury (admin → multisig destination ATA)
```
