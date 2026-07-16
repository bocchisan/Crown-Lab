// «Подписка» — the stream shape. The canister here stores nothing at all: it
// derives the escrow from the birth fields you declare, checks the schedule
// (or the donor's signature, for cancel), and signs. Everything else is the
// chain's job — including the release order, which the shape enforces, not the
// canister.

import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";

import { asBytes } from "../canisters.ts";
import { fromHex, hex, utf8 } from "../bytes.ts";
import { chunkDueAt, decodeStream, refuseIfSettled } from "../escrow.ts";
import { createAtaIx, ed25519VerifyIx, streamCancelIx, streamCreateIx, streamRefundIx, streamReleaseIx } from "../ix.ts";
import { type Lab, participantByAddress } from "../lab.ts";
import { explorerAddress, explorerTx, formatUsdc, send } from "../net.ts";
import { cancelAuthorization, cancelMessage, releaseMessage } from "../messages.ts";
import { type SubscriptionEntry, load, update } from "../store.ts";
import { button, el, field, labeled, link, log, logLink, row, section, short, span } from "../ui.ts";
import { participantSelect, refreshBalances, selectedSigner } from "./participants.ts";

/** The shape's deploy constant: refund opens this long after a chunk is due. */
const RELEASE_MARGIN = 900n;

export function subscriptionPanel(lab: Lab): HTMLElement {
  const donor = participantSelect(lab);
  const owner = participantSelect(lab);
  const chunk = field("USDC", "0.04", 7);
  const nChunks = field("кусков", "3", 4);
  const period = field("период, с", "45", 6);
  const backdate = field("t0 сдвиг, с", "0", 6);

  const createRow = row(
    labeled("донор", donor),
    labeled("владелец", owner),
    labeled("кусок, USDC", chunk),
    labeled("кусков", nChunks),
    labeled("период, с", period),
    labeled("t0 назад, с", backdate),
    button("1. оформить подписку", async () => {
      if (!lab.subscription) throw new Error("canister id игры «подписка» не задан");
      const donorSigner = selectedSigner(lab, donor);
      const ownerSigner = selectedSigner(lab, owner);
      // Any opaque 32 bytes: the canister is client-agnostic, the id is just
      // the key derivation path of this subscription's resolver.
      const subscriptionId = sha256(utf8(`crown-lab:sub:${Date.now()}`));
      const resolverOut = await lab.subscription.get_resolver(lab.chainId, subscriptionId);
      if ("Err" in resolverOut) throw new Error(`get_resolver: ${resolverOut.Err}`);
      const resolver = asBytes(resolverOut.Ok);

      const t0 = BigInt(Math.floor(Date.now() / 1000)) - BigInt(backdate.value || "0");
      const birth = {
        donor: donorSigner.publicKey,
        recipients: [ownerSigner.publicKey],
        shares: [10_000],
        chunk: BigInt(Math.round(Number(chunk.value) * 1e6)),
        nChunks: Number(nChunks.value),
        t0,
        period: BigInt(period.value),
        resolver,
        feeBps: lab.feeBps,
        feeWallet: lab.feeWallet.toBytes(),
        // Client convention: nonce = t0, so the birth is recoverable from a
        // single account read (docs/bot-spec.md §6).
        nonce: BigInt.asUintN(64, t0),
      };
      const { instruction, escrow } = streamCreateIx(birth, lab.addresses);
      const signature = await send(lab.connection, donorSigner, [instruction]);
      const entry: SubscriptionEntry = {
        subscriptionId: hex(subscriptionId),
        escrow: escrow.toBase58(),
        donor: donorSigner.address,
        recipient: ownerSigner.address,
        chunk: birth.chunk.toString(),
        nChunks: birth.nChunks,
        t0: t0.toString(),
        period: period.value,
        resolver: hex(resolver),
      };
      update((store) => store.subscriptions.unshift(entry));
      logLink(
        `подписка ${short(entry.escrow)}: списано ${formatUsdc(birth.chunk * BigInt(birth.nChunks))} USDC вперёд`,
        "tx",
        explorerTx(signature),
        "ok",
      );
      await refreshBalances(lab);
      lab.refresh();
    }),
  );

  const list = el("div");
  for (const entry of load().subscriptions) list.append(subscriptionRow(lab, entry));

  return section(
    "Игра «Подписка» — stream",
    el("div", { className: "muted" }, [
      "Донор оплачивает N кусков вперёд. Каждый кусок канистра разрешает только по расписанию " +
        "(now ≥ t0 + index·период), порядок держит сама форма ончейн. Отмена — по подписи донора, " +
        "остаток возвращается мгновенно. refund() открывается через 900 с после просрочки куска — " +
        "страховка от мёртвого резолвера (поставь «t0 назад» = 2000, чтобы проверить сразу).",
    ]),
    createRow,
    list,
  );
}

function subscriptionRow(lab: Lab, entry: SubscriptionEntry): HTMLElement {
  const payerSelect = participantSelect(lab, entry.donor);
  const indexInput = field("index", "0", 4);
  const state = el("div", { className: "muted" });

  const birthArg = () => ({
    chain: lab.chainId,
    subscription_id: fromHex(entry.subscriptionId),
    donor: new PublicKey(entry.donor).toBytes(),
    recipients: [new PublicKey(entry.recipient).toBytes()],
    shares: [10_000],
    chunk: BigInt(entry.chunk),
    n_chunks: entry.nChunks,
    t0: BigInt(entry.t0),
    period: BigInt(entry.period),
    nonce: BigInt.asUintN(64, BigInt(entry.t0)),
  });

  const readEscrow = async () => {
    const account = await lab.connection.getAccountInfo(new PublicKey(entry.escrow));
    if (!account) throw new Error("эскроу не найден на чейне");
    return decodeStream(new Uint8Array(account.data));
  };

  /** Every money move demands a live escrow; a settled one has no ATA left. */
  const liveEscrow = async (what: string) => {
    const escrow = await readEscrow();
    refuseIfSettled(escrow, what);
    return escrow;
  };

  const showState = async (): Promise<void> => {
    const escrow = await readEscrow();
    const now = BigInt(Math.floor(Date.now() / 1000));
    const due = chunkDueAt(escrow, escrow.released);
    const waiting = due > now ? `следующий кусок через ${due - now} с` : "следующий кусок созрел";
    state.textContent =
      `выпущено ${escrow.released}/${escrow.nChunks} · settled: ${escrow.settled} · ` +
      `${escrow.settled ? "терминален" : waiting} · refund через ${
        escrow.settled ? "—" : `${due + RELEASE_MARGIN > now ? due + RELEASE_MARGIN - now : 0n} с`
      }`;
    log(`${short(entry.escrow)}: ${state.textContent}`, "muted");
  };

  return el("div", {}, [
    el("div", { className: "row" }, [
      link(short(entry.escrow), explorerAddress(entry.escrow)),
      span(`${formatUsdc(BigInt(entry.chunk))} × ${entry.nChunks}, период ${entry.period} с`, "pill"),
      labeled("платит газ", payerSelect),
      labeled("кусок №", indexInput),
      button("2. выпустить кусок", async () => {
        if (!lab.subscription) throw new Error("canister id игры не задан");
        const index = Number(indexInput.value);
        await liveEscrow("выпуск куска");
        const out = await lab.subscription.request_release({ ...birthArg(), index });
        if ("Err" in out) throw new Error(`request_release: ${out.Err}`);
        const escrowFromCanister = new PublicKey(asBytes(out.Ok.escrow)).toBase58();
        if (escrowFromCanister !== entry.escrow) {
          throw new Error(`канистра вывела другой эскроу: ${escrowFromCanister}`);
        }
        const escrow = await readEscrow();
        const payer = selectedSigner(lab, payerSelect);
        const address = new PublicKey(entry.escrow);
        const message = releaseMessage(lab.domains.stream, lab.addresses.factoryStream, address, index);
        const tx = await send(lab.connection, payer, [
          createAtaIx(new PublicKey(payer.publicKey), new PublicKey(entry.recipient), lab.addresses.usdc),
          createAtaIx(new PublicKey(payer.publicKey), new PublicKey(escrow.feeWallet), lab.addresses.usdc),
          ed25519VerifyIx(asBytes(escrow.resolver), asBytes(out.Ok.signature), message),
          streamReleaseIx(address, escrow, index, lab.addresses),
        ]);
        const fee = (escrow.chunk * BigInt(escrow.feeBps)) / 10_000n;
        logLink(
          `кусок ${index}: владельцу ${formatUsdc(escrow.chunk - fee)} USDC через сплиттер, комиссия ${formatUsdc(fee)}`,
          "tx",
          explorerTx(tx),
          "ok",
        );
        await refreshBalances(lab);
        await showState();
      }),
      button("3. отменить", async () => {
        if (!lab.subscription) throw new Error("canister id игры не задан");
        // The donor's word: signed over the escrow address, verified by the
        // canister before it signs the on-chain cancel.
        await liveEscrow("отмена");
        const donorSigner = participantByAddress(lab, entry.donor);
        const authorization = cancelAuthorization(
          lab.chainId,
          lab.ids.subscription,
          new PublicKey(entry.escrow).toBytes(),
        );
        const signature = await donorSigner.signMessage(authorization);
        const out = await lab.subscription.request_cancel({ ...birthArg(), signature });
        if ("Err" in out) throw new Error(`request_cancel: ${out.Err}`);
        const escrow = await readEscrow();
        const payer = selectedSigner(lab, payerSelect);
        const address = new PublicKey(entry.escrow);
        const message = cancelMessage(lab.domains.stream, lab.addresses.factoryStream, address);
        const tx = await send(lab.connection, payer, [
          ed25519VerifyIx(asBytes(escrow.resolver), asBytes(out.Ok.signature), message),
          streamCancelIx(address, escrow, lab.addresses),
        ]);
        const left = escrow.chunk * BigInt(escrow.nChunks - escrow.released);
        logLink(`отмена: донору вернулось ${formatUsdc(left)} USDC, книга не двигается`, "tx", explorerTx(tx), "ok");
        await refreshBalances(lab);
        await showState();
      }),
      button("refund()", async () => {
        const escrow = await liveEscrow("refund");
        const payer = selectedSigner(lab, payerSelect);
        const tx = await send(lab.connection, payer, [
          streamRefundIx(new PublicKey(entry.escrow), escrow, lab.addresses),
        ]);
        logLink("refund(): остаток донору без подписи — резолвер не нужен", "tx", explorerTx(tx), "ok");
        await refreshBalances(lab);
        await showState();
      }),
      button("состояние", showState),
      button("×", () => {
        update((store) => {
          store.subscriptions = store.subscriptions.filter((sub) => sub.escrow !== entry.escrow);
        });
        lab.refresh();
      }),
    ]),
    state,
  ]);
}
