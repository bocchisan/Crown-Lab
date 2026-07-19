// «Аукцион» — the two-outcome game with lots. What is new against «Сбор»:
//
//   1. Money, text and auction are bound by derivation: the lot's resolver is
//      the threshold key at path [lot_id], lot_id = sha256(auction_id ‖
//      text_hash) — a signature of one lot cannot open another's escrow.
//   2. The first sighted game: register_entry READS the escrow account from
//      the chain (finalized) through the SOL RPC canister, so a freshly sent
//      create needs a couple of minutes before the canister sees it.
//   3. The finale runs on the canister's timer once `duration` expires: the
//      lot with the largest live sum of accepted entries wins, the losers are
//      cancelled at once, and the winner walks the Tasks path — ready → vote →
//      verdict.

import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";

import { asBytes, decodeAuctionRecord, optional } from "../canisters.ts";
import { fromHex, hex, utf8 } from "../bytes.ts";
import { decodeTwoOutcome, refuseIfSettled } from "../escrow.ts";
import { createAtaIx, ed25519VerifyIx, twoOutcomeClaimIx, twoOutcomeCreateIx, twoOutcomeRefundIx } from "../ix.ts";
import { type Lab, participantByAddress } from "../lab.ts";
import { explorerAddress, explorerTx, formatUsdc, send } from "../net.ts";
import { AUCTION_CHOICE, auctionId, auctionMessage, lotId, twoOutcomeVerdictMessage } from "../messages.ts";
import { type AuctionEntry, type LotEntry, load, update } from "../store.ts";
import { button, el, field, labeled, link, log, logLink, row, section, short, span } from "../ui.ts";
import { participantSelect, refreshBalances, selectedSigner } from "./participants.ts";

/** The game's profile on testnet (config/testnet.toml: voting_period = 120). */
const VOTING_PERIOD = 120n;
/** Frozen in the game's logic crate: the registration rule demands
 * deadline ≥ created + duration + perform_window + voting_period + 72h. */
const DEADLINE_MARGIN = 259_200n;

export function auctionPanel(lab: Lab): HTMLElement {
  const recipient = participantSelect(lab);
  const duration = field("duration", "300", 6);
  const performWindow = field("perform_window", "120", 6);
  const minEntry = field("min_entry", "0.01", 7);

  const createRow = row(
    labeled("получатель", recipient),
    labeled("duration, с", duration),
    labeled("perform_window, с", performWindow),
    labeled("min_entry, USDC", minEntry),
    button("1. создать аукцион", async () => {
      if (!lab.auction) throw new Error("canister id игры «аукцион» не задан");
      const manager = selectedSigner(lab, recipient);
      const recipientNonce = BigInt(Math.floor(Date.now() / 1000));
      const canisterId = lab.principalBytes("auction");
      const id = auctionId(canisterId, manager.publicKey, recipientNonce);
      const minEntryUnits = BigInt(Math.round(Number(minEntry.value) * 1e6));
      const message = auctionMessage(lab.chainId, lab.ids.auction, id, {
        kind: "create",
        recipientNonce,
        duration: BigInt(duration.value),
        performWindow: BigInt(performWindow.value),
        minEntry: minEntryUnits,
      });
      const signature = await manager.signMessage(message);
      const out = await lab.auction.create_auction({
        chain: lab.chainId,
        recipient: manager.publicKey,
        recipient_nonce: recipientNonce,
        duration: BigInt(duration.value),
        perform_window: BigInt(performWindow.value),
        min_entry: minEntryUnits,
        signature,
      });
      if ("Err" in out) throw new Error(`create_auction: ${out.Err}`);
      // The canister derives the same id from the same fields; if these two
      // ever differ, the client's derivation is wrong.
      if (hex(asBytes(out.Ok)) !== hex(id)) throw new Error("auction_id канистры не совпал с локальным");
      const entry: AuctionEntry = {
        auctionId: hex(id),
        recipient: manager.address,
        recipientNonce: recipientNonce.toString(),
        duration: duration.value,
        performWindow: performWindow.value,
        minEntry: minEntryUnits.toString(),
        lots: [],
      };
      update((store) => store.auctions.unshift(entry));
      log(`аукцион ${short(entry.auctionId)} создан (BIDDING ${duration.value} с)`, "ok");
      lab.refresh();
    }),
  );

  const list = el("div");
  for (const entry of load().auctions) list.append(auctionRow(lab, entry));

  return section(
    "Игра «Аукцион» — two-outcome, лоты со своими резолверами",
    el("div", { className: "muted" }, [
      "Получатель открывает аукцион, кто угодно вешает лоты-условия и докладывает вклады " +
        "(каждый вклад — свой эскроу, своя репутация и свой возврат). Получатель принимает лоты; " +
        "по таймеру канистра выбирает победителя (максимальная живая сумма принятых), проигравшим — cancel сразу. " +
        "Дальше путь «Заданий»: ready → голос → вердикт → claim. " +
        "Регистрация вклада ЧИТАЕТ эскроу с чейна (finalized) — свежему create нужна пара минут.",
    ]),
    createRow,
    list,
  );
}

function auctionRow(lab: Lab, entry: AuctionEntry): HTMLElement {
  const id = fromHex(entry.auctionId);
  const lotText = field("текст лота", "лот лаборатории", 18);
  const voter = participantSelect(lab);
  const state = el("div", { className: "muted" });

  const showState = async (): Promise<void> => {
    if (!lab.auction) throw new Error("canister id игры не задан");
    const certified = optional(await lab.auction.get_auction(lab.chainId, id));
    if (!certified) {
      state.textContent = "канистра аукцион не знает";
      return;
    }
    const record = decodeAuctionRecord(asBytes(certified.data));
    const name = Object.keys(record.state)[0] ?? "?";
    const winner =
      "done" in record.state ? Object.keys(optional(record.state.done.winner) ?? {})[0] ?? "нет" : null;
    const winnerLot = optional(record.winner_lot);
    const votes = record.votes
      .map((vote) => `${short(new PublicKey(asBytes(vote.voter)).toBase58())}:${Object.keys(vote.choice)[0]}(${vote.weight})`)
      .join(", ");
    const lots = await lab.auction.list_lots(lab.chainId, id);
    const board = lots
      .map(
        (lot) =>
          `${short(hex(asBytes(lot.lot_id)))}: ${lot.sum} minor, вкладов ${lot.entries}` +
          `${optional(lot.accepted_at) !== null ? ", принят" : ""}${optional(lot.returned) ? ", возвращён" : ""}`,
      )
      .join(" · ");
    state.textContent =
      `состояние: ${name}${winner ? ` → победный исход: ${winner}` : ""}` +
      `${winnerLot ? ` · победный лот ${short(hex(asBytes(winnerLot)))}` : ""}` +
      ` · голоса: ${votes || "нет"} · лидерборд: ${board || "пусто"}`;
    log(state.textContent, "muted");
  };

  // ready / cancel are the auction recipient's word; the operator words are
  // verified against the platform operator's wallet (select its key first).
  const say = async (
    kind: "ready" | "cancel" | "operator-cancel",
    signerAddress: string,
  ): Promise<void> => {
    if (!lab.auction) throw new Error("canister id игры не задан");
    const signer = participantByAddress(lab, signerAddress);
    const message = auctionMessage(lab.chainId, lab.ids.auction, id, { kind });
    const signature = await signer.signMessage(message);
    const method =
      kind === "ready" ? "ready" : kind === "cancel" ? "cancel_auction" : "operator_cancel_auction";
    const out = await lab.auction[method]({ chain: lab.chainId, auction_id: id, signature });
    if ("Err" in out) throw new Error(`${method}: ${out.Err}`);
    log(`${method}: ok (подписал ${signer.label})`, "ok");
    await showState();
  };

  const lots = el("div");
  for (const lot of entry.lots) lots.append(lotRow(lab, entry, lot, voter, showState));

  return el("div", {}, [
    el("div", { className: "row" }, [
      span(`аукцион ${short(entry.auctionId)}`, "pill"),
      span(
        `получатель ${short(entry.recipient)} · BIDDING ${entry.duration} с · min_entry ${formatUsdc(BigInt(entry.minEntry))} USDC`,
        "muted",
      ),
      labeled("текст лота", lotText),
      button("2. добавить лот", async () => {
        if (!lab.auction) throw new Error("canister id игры не задан");
        const textHash = sha256(utf8(lotText.value));
        const localLotId = lotId(id, textHash);
        // The resolver is derived on demand at path [lot_id]; the canister
        // answers the same key for the same (auction, text) forever.
        const out = await lab.auction.get_resolver({ auction_id: id, text_hash: textHash });
        if ("Err" in out) throw new Error(`get_resolver: ${out.Err}`);
        const lot: LotEntry = {
          lotId: hex(localLotId),
          text: lotText.value,
          textHash: hex(textHash),
          resolver: hex(asBytes(out.Ok)),
          entries: [],
        };
        update((store) => {
          const target = store.auctions.find((auction) => auction.auctionId === entry.auctionId);
          target?.lots.unshift(lot);
        });
        log(`лот ${short(lot.lotId)} «${lot.text}»: резолвер ${short(lot.resolver)}`, "ok");
        lab.refresh();
      }),
      labeled("голосует", voter),
      button("5. ready", () => say("ready", entry.recipient)),
      button("голос done", () => vote(lab, entry, voter, AUCTION_CHOICE.done)),
      button("голос not_done", () => vote(lab, entry, voter, AUCTION_CHOICE.notDone)),
      button("cancel (из BIDDING)", () => say("cancel", entry.recipient)),
      button("состояние", showState),
      // The censorship paths: select the operator's imported key in «голосует».
      button("operator-cancel", async () => say("operator-cancel", selectedSigner(lab, voter).address)),
      button("×", () => {
        update((store) => {
          store.auctions = store.auctions.filter((auction) => auction.auctionId !== entry.auctionId);
        });
        lab.refresh();
      }),
    ]),
    lots,
    state,
  ]);
}

function lotRow(
  lab: Lab,
  auction: AuctionEntry,
  lot: LotEntry,
  voter: HTMLSelectElement,
  showState: () => Promise<void>,
): HTMLElement {
  const auctionIdBytes = fromHex(auction.auctionId);
  const contributor = participantSelect(lab);
  const gross = field("USDC", "0.03", 7);

  const lotWord = async (
    kind: "accept" | "return-lot" | "operator-refund-lot",
    signerAddress: string,
  ): Promise<void> => {
    if (!lab.auction) throw new Error("canister id игры не задан");
    const signer = participantByAddress(lab, signerAddress);
    const message = auctionMessage(lab.chainId, lab.ids.auction, auctionIdBytes, {
      kind,
      lot: fromHex(lot.lotId),
    });
    const signature = await signer.signMessage(message);
    const method =
      kind === "accept" ? "accept_lot" : kind === "return-lot" ? "return_lot" : "operator_refund_lot";
    const out = await lab.auction[method]({
      chain: lab.chainId,
      auction_id: auctionIdBytes,
      lot_id: fromHex(lot.lotId),
      signature,
    });
    if ("Err" in out) throw new Error(`${method}: ${out.Err}`);
    log(`${method}: ok (подписал ${signer.label})`, "ok");
    await showState();
  };

  const entryWord = async (
    kind: "return-entry" | "operator-refund-entry",
    escrow: string,
    signerAddress: string,
  ): Promise<void> => {
    if (!lab.auction) throw new Error("canister id игры не задан");
    const signer = participantByAddress(lab, signerAddress);
    const escrowBytes = new PublicKey(escrow).toBytes();
    const message = auctionMessage(lab.chainId, lab.ids.auction, auctionIdBytes, {
      kind,
      escrow: escrowBytes,
    });
    const signature = await signer.signMessage(message);
    const method = kind === "return-entry" ? "return_entry" : "operator_refund_entry";
    const out = await lab.auction[method]({
      chain: lab.chainId,
      auction_id: auctionIdBytes,
      escrow: escrowBytes,
      signature,
    });
    if ("Err" in out) throw new Error(`${method}: ${out.Err}`);
    log(`${method}: ok (подписал ${signer.label})`, "ok");
    await showState();
  };

  const claimOne = async (entry: LotEntry["entries"][number], outcome: number): Promise<void> => {
    if (!lab.auction) throw new Error("canister id игры не задан");
    const escrow = new PublicKey(entry.escrow);
    const account = await lab.connection.getAccountInfo(escrow);
    if (!account) throw new Error("эскроу не найден на чейне");
    const decoded = decodeTwoOutcome(new Uint8Array(account.data));
    refuseIfSettled(decoded, "claim");

    // The signature is issued on demand and resolves in three steps: the
    // entry's outcome, else the lot's, else the auction's.
    const out = await lab.auction.request_signature({
      chain: lab.chainId,
      auction_id: auctionIdBytes,
      text_hash: fromHex(lot.textHash),
      donor: new PublicKey(entry.donor).toBytes(),
      gross: BigInt(entry.gross),
      deadline: BigInt(entry.deadline),
      nonce: BigInt(entry.nonce),
    });
    if ("Err" in out) throw new Error(`request_signature: ${out.Err}`);
    const verdictName = Object.keys(out.Ok.outcome)[0] ?? "?";
    const escrowFromCanister = new PublicKey(asBytes(out.Ok.escrow)).toBase58();
    if (escrowFromCanister !== entry.escrow) {
      throw new Error(`канистра вывела другой эскроу: ${escrowFromCanister}`);
    }
    const decidedOutcome = "settle" in out.Ok.outcome ? 0 : 1;
    if (decidedOutcome !== outcome) {
      throw new Error(
        `исход вклада — ${verdictName}, а claim(${outcome}) просит ` +
          `${outcome === 0 ? "settle" : "cancel"}: подпись под один исход не открывает другой. ` +
          `Жми claim(${decidedOutcome}).`,
      );
    }
    log(`исход вклада: ${verdictName}; подпись выдана для ${short(entry.escrow)}`, "muted");

    const payer = selectedSigner(lab, voter);
    const message = twoOutcomeVerdictMessage(lab.domains.twoOutcome, lab.addresses.factoryTwoOutcome, escrow, outcome);
    const tx = await send(lab.connection, payer, [
      createAtaIx(new PublicKey(payer.publicKey), new PublicKey(decoded.recipient), lab.addresses.usdc),
      createAtaIx(new PublicKey(payer.publicKey), new PublicKey(decoded.feeWallet), lab.addresses.usdc),
      ed25519VerifyIx(asBytes(decoded.resolver), asBytes(out.Ok.signature), message),
      twoOutcomeClaimIx(escrow, decoded, outcome, lab.addresses),
    ]);
    const fee = (decoded.gross * BigInt(decoded.feeBps)) / 10_000n;
    logLink(
      outcome === 0
        ? `claim(0): получателю ${formatUsdc(decoded.gross - fee)} USDC; книга начислит ВКЛАДЧИКУ`
        : `claim(1): вклад ${formatUsdc(decoded.gross)} USDC вернулся вкладчику`,
      "tx",
      explorerTx(tx),
      "ok",
    );
    await refreshBalances(lab);
  };

  const entries = el("div");
  for (const entry of lot.entries) {
    entries.append(
      el("div", { className: "row" }, [
        span("  └ вклад", "muted"),
        link(short(entry.escrow), explorerAddress(entry.escrow)),
        span(`${formatUsdc(BigInt(entry.gross))} USDC`, "pill"),
        span(short(entry.donor), "muted"),
        button("claim(0) settle", () => claimOne(entry, 0)),
        button("claim(1) cancel", () => claimOne(entry, 1)),
        button("return-entry (получатель)", () => entryWord("return-entry", entry.escrow, auction.recipient)),
        button("op-refund-entry", () =>
          entryWord("operator-refund-entry", entry.escrow, selectedSigner(lab, voter).address),
        ),
        button("refund()", async () => {
          const escrow = new PublicKey(entry.escrow);
          const account = await lab.connection.getAccountInfo(escrow);
          if (!account) throw new Error("эскроу не найден");
          const decoded = decodeTwoOutcome(new Uint8Array(account.data));
          refuseIfSettled(decoded, "refund");
          const payer = selectedSigner(lab, voter);
          const tx = await send(lab.connection, payer, [twoOutcomeRefundIx(escrow, decoded, lab.addresses)]);
          logLink("refund(): вклад вернулся мимо игры", "tx", explorerTx(tx), "ok");
          await refreshBalances(lab);
        }),
      ]),
    );
  }

  return el("div", {}, [
    el("div", { className: "row" }, [
      span(`└ лот ${short(lot.lotId)} «${lot.text}»`, "muted"),
      labeled("вкладчик", contributor),
      labeled("USDC", gross),
      button("3. вклад + register", async () => {
        if (!lab.auction) throw new Error("canister id игры не задан");
        const donor = selectedSigner(lab, contributor);
        const manager = participantByAddress(lab, auction.recipient);
        const now = BigInt(Math.floor(Date.now() / 1000));
        // The registration rule the canister enforces, plus slack for drift.
        const deadline =
          now +
          BigInt(auction.duration) +
          BigInt(auction.performWindow) +
          VOTING_PERIOD +
          DEADLINE_MARGIN +
          600n;
        const nonce = now;
        const grossUnits = BigInt(Math.round(Number(gross.value) * 1e6));
        if (grossUnits < BigInt(auction.minEntry)) {
          throw new Error(`вклад ниже min_entry аукциона (${auction.minEntry} minor)`);
        }
        const birth = {
          donor: donor.publicKey,
          // In this game the escrow's recipient is the auction's recipient.
          recipient: manager.publicKey,
          gross: grossUnits,
          deadline,
          resolver: fromHex(lot.resolver),
          feeBps: lab.feeBps,
          feeWallet: lab.feeWallet.toBytes(),
          nonce,
        };
        const { instruction, escrow } = twoOutcomeCreateIx(birth, lab.addresses);
        const signature = await send(lab.connection, donor, [instruction]);
        logLink(`вклад ${gross.value} USDC от ${donor.label}`, "tx", explorerTx(signature), "ok");

        // The canister reads the escrow itself at finalized commitment; the
        // transaction above confirmed at confirmed, so retry until the gap
        // closes (typically well under a minute on devnet).
        log("register_entry: канистра читает эскроу с чейна (finalized) — жду…", "wait");
        let registered = false;
        for (let attempt = 0; attempt < 18 && !registered; attempt++) {
          const out = await lab.auction.register_entry({
            chain: lab.chainId,
            auction_id: auctionIdBytes,
            text_hash: fromHex(lot.textHash),
            donor: donor.publicKey,
            gross: grossUnits,
            deadline,
            nonce,
          });
          if ("Ok" in out) {
            const stored = new PublicKey(asBytes(out.Ok)).toBase58();
            if (stored !== escrow.toBase58()) throw new Error(`канистра вывела другой эскроу: ${stored}`);
            registered = true;
          } else if (out.Err.includes("does not exist")) {
            await new Promise((resolve) => setTimeout(resolve, 10_000));
          } else {
            throw new Error(`register_entry: ${out.Err}`);
          }
        }
        if (!registered) throw new Error("register_entry: эскроу так и не финализировался — повтори кнопкой позже");
        update((store) => {
          const target = store.auctions
            .find((candidate) => candidate.auctionId === auction.auctionId)
            ?.lots.find((candidate) => candidate.lotId === lot.lotId);
          target?.entries.push({
            escrow: escrow.toBase58(),
            donor: donor.address,
            gross: grossUnits.toString(),
            deadline: deadline.toString(),
            nonce: nonce.toString(),
          });
        });
        log(`вклад зарегистрирован в лоте ${short(lot.lotId)}`, "ok");
        await refreshBalances(lab);
        lab.refresh();
      }),
      button("4. accept (получатель)", () => lotWord("accept", auction.recipient)),
      button("return-lot (получатель)", () => lotWord("return-lot", auction.recipient)),
      button("op-refund-lot", () => lotWord("operator-refund-lot", selectedSigner(lab, voter).address)),
    ]),
    entries,
  ]);
}

async function vote(
  lab: Lab,
  entry: AuctionEntry,
  select: HTMLSelectElement,
  choice: (typeof AUCTION_CHOICE)[keyof typeof AUCTION_CHOICE],
): Promise<void> {
  if (!lab.auction) throw new Error("canister id игры не задан");
  const voter = selectedSigner(lab, select);
  const id = fromHex(entry.auctionId);
  const message = auctionMessage(lab.chainId, lab.ids.auction, id, { kind: "vote", choice });
  const signature = await voter.signMessage(message);
  const out = await lab.auction.vote({
    chain: lab.chainId,
    auction_id: id,
    voter: voter.publicKey,
    choice: choice === AUCTION_CHOICE.done ? { done: null } : { not_done: null },
    signature,
  });
  if ("Err" in out) throw new Error(`vote: ${out.Err}`);
  log(`голос ${choice} принят (${voter.label}); вес взят из книги`, "ok");
}
