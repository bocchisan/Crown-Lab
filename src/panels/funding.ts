// «Сбор» — a crowdfunding collection over the same two-outcome shape. Two
// things differ from «Задания» and both are worth watching here:
//
//   1. Every collection has its own resolver — the threshold key derived at
//      path [collection_id] — so a signature of one collection cannot open
//      another's escrow.
//   2. Signatures are issued on demand (request_signature) rather than stored:
//      one verdict moves every contribution, each claimed separately.

import { PublicKey } from "@solana/web3.js";

import { asBytes, decodeCollectionRecord, optional } from "../canisters.ts";
import { fromHex, hex } from "../bytes.ts";
import { decodeTwoOutcome, refuseIfSettled } from "../escrow.ts";
import { createAtaIx, ed25519VerifyIx, twoOutcomeClaimIx, twoOutcomeCreateIx, twoOutcomeRefundIx } from "../ix.ts";
import { type Lab, participantByAddress } from "../lab.ts";
import { explorerAddress, explorerTx, formatUsdc, send } from "../net.ts";
import {
  FUNDING_CHOICE,
  collectionId,
  collectionMessage,
  twoOutcomeVerdictMessage,
} from "../messages.ts";
import { type CollectionEntry, load, update } from "../store.ts";
import { button, el, field, labeled, link, log, logLink, row, section, short, span } from "../ui.ts";
import { participantSelect, refreshBalances, selectedSigner } from "./participants.ts";

const DEADLINE_MARGIN = 259_200n;

export function fundingPanel(lab: Lab): HTMLElement {
  const recipient = participantSelect(lab);
  const goal = field("goal", "1", 6);
  const duration = field("duration", "600", 6);

  const createRow = row(
    labeled("получатель", recipient),
    labeled("цель, USDC", goal),
    labeled("duration, с", duration),
    button("1. создать коллекцию", async () => {
      if (!lab.funding) throw new Error("canister id игры «сбор» не задан");
      const manager = selectedSigner(lab, recipient);
      const recipientNonce = BigInt(Math.floor(Date.now() / 1000));
      const canisterId = lab.principalBytes("conditionalFunding");
      const id = collectionId(canisterId, manager.publicKey, recipientNonce);
      const goalUnits = BigInt(Math.round(Number(goal.value) * 1e6));
      const message = collectionMessage(lab.chainId, lab.ids.conditionalFunding, id, {
        kind: "create",
        goal: goalUnits,
        duration: BigInt(duration.value),
      });
      const signature = await manager.signMessage(message);
      const out = await lab.funding.create_collection({
        chain: lab.chainId,
        recipient: manager.publicKey,
        recipient_nonce: recipientNonce,
        goal: goalUnits,
        duration: BigInt(duration.value),
        signature,
      });
      if ("Err" in out) throw new Error(`create_collection: ${out.Err}`);
      const stored = asBytes(out.Ok);
      // The canister derives the same id from the same fields; if these two
      // ever differ, the client's derivation is wrong.
      if (hex(stored) !== hex(id)) throw new Error("collection_id канистры не совпал с локальным");
      const resolver = optional(await lab.funding.get_resolver(lab.chainId, id));
      if (!resolver) throw new Error("резолвер коллекции ещё не готов");
      const entry: CollectionEntry = {
        collectionId: hex(id),
        recipient: manager.address,
        recipientNonce: recipientNonce.toString(),
        goal: goalUnits.toString(),
        duration: duration.value,
        resolver: hex(asBytes(resolver)),
        contributions: [],
      };
      update((store) => store.collections.unshift(entry));
      log(`коллекция ${short(entry.collectionId)} создана; её собственный резолвер ${short(entry.resolver)}`, "ok");
      lab.refresh();
    }),
  );

  const list = el("div");
  for (const entry of load().collections) list.append(collectionRow(lab, entry));

  return section(
    "Игра «Сбор» — two-outcome, общий вердикт коллекции",
    el("div", { className: "muted" }, [
      "Получатель открывает сбор, вкладчики вешают по эскроу на общий резолвер коллекции. " +
        "Получатель жмёт «ready», держатели репутации голосуют, и один вердикт решает судьбу всех вкладов: " +
        "settle → получателю (за вычетом комиссии), refund → каждому его вклад целиком. " +
        "Кворум testnet — 150000 веса, порог — строгое большинство.",
    ]),
    createRow,
    list,
  );
}

function collectionRow(lab: Lab, entry: CollectionEntry): HTMLElement {
  const id = fromHex(entry.collectionId);
  const contributor = participantSelect(lab);
  const gross = field("USDC", "0.03", 7);
  const voter = participantSelect(lab);
  const state = el("div", { className: "muted" });

  const showState = async (): Promise<void> => {
    if (!lab.funding) throw new Error("canister id игры не задан");
    const certified = optional(await lab.funding.get_collection(lab.chainId, id));
    if (!certified) {
      state.textContent = "канистра коллекцию не знает";
      return;
    }
    const record = decodeCollectionRecord(asBytes(certified.data));
    const name = Object.keys(record.state)[0] ?? "?";
    const decided = "decided" in record.state ? Object.keys(record.state.decided.outcome)[0] : null;
    const votes = record.votes
      .map((vote) => `${short(new PublicKey(asBytes(vote.voter)).toBase58())}:${Object.keys(vote.choice)[0]}(${vote.weight})`)
      .join(", ");
    const turnout = record.votes.reduce((sum, vote) => sum + vote.weight, 0n);
    state.textContent =
      `состояние: ${name}${decided ? ` → ${decided}` : ""} · явка ${turnout}/${record.quorum_weight} (кворум) · голоса: ${votes || "нет"}`;
    log(state.textContent, "muted");
  };

  // ready / cancel are the recipient's word; operator-refund is verified
  // against the platform operator's wallet (select its imported key first).
  const say = async (kind: "ready" | "cancel" | "operator-refund", signerAddress: string): Promise<void> => {
    if (!lab.funding) throw new Error("canister id игры не задан");
    const signer = participantByAddress(lab, signerAddress);
    const message = collectionMessage(lab.chainId, lab.ids.conditionalFunding, id, { kind });
    const signature = await signer.signMessage(message);
    const method =
      kind === "ready" ? "ready" : kind === "cancel" ? "recipient_cancel" : "operator_refund";
    const out = await lab.funding[method]({ chain: lab.chainId, collection_id: id, signature });
    if ("Err" in out) throw new Error(`${method}: ${out.Err}`);
    log(`${method}: ok (подписал ${signer.label})`, "ok");
    await showState();
  };

  const claimOne = async (contribution: CollectionEntry["contributions"][number], outcome: number): Promise<void> => {
    if (!lab.funding) throw new Error("canister id игры не задан");
    // Read the escrow first: a settled one is terminal, and asking the
    // canister for a signature it cannot help with only wastes a round-trip.
    const escrow = new PublicKey(contribution.escrow);
    const account = await lab.connection.getAccountInfo(escrow);
    if (!account) throw new Error("эскроу не найден на чейне");
    const decoded = decodeTwoOutcome(new Uint8Array(account.data));
    refuseIfSettled(decoded, "claim");

    // The signature is issued on demand: recipient and resolver come from the
    // canister's record, never from this request.
    const out = await lab.funding.request_signature({
      chain: lab.chainId,
      collection_id: id,
      donor: new PublicKey(contribution.donor).toBytes(),
      gross: BigInt(contribution.gross),
      deadline: BigInt(contribution.deadline),
      nonce: BigInt(contribution.nonce),
    });
    if ("Err" in out) throw new Error(`request_signature: ${out.Err}`);
    const verdictName = Object.keys(out.Ok.outcome)[0] ?? "?";
    const escrowFromCanister = new PublicKey(asBytes(out.Ok.escrow)).toBase58();
    if (escrowFromCanister !== contribution.escrow) {
      throw new Error(`канистра вывела другой эскроу: ${escrowFromCanister}`);
    }
    // One verdict decides the whole collection, and the canister signs only
    // that one. Requesting the other outcome builds a different message, the
    // signature stops verifying, and the ed25519 precompile answers
    // InvalidSignature — the guarantee working, not a bug.
    const decidedOutcome = "settle" in out.Ok.outcome ? 0 : 1;
    if (decidedOutcome !== outcome) {
      throw new Error(
        `вердикт коллекции — ${verdictName}, а claim(${outcome}) просит ` +
          `${outcome === 0 ? "settle" : "refund"}: подпись под один исход не открывает другой. ` +
          `Это и есть гарантия игры — жми claim(${decidedOutcome}).`,
      );
    }
    log(`вердикт коллекции: ${verdictName}; подпись выдана для ${short(contribution.escrow)}`, "muted");

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
        ? `claim(0): получатель получил ${formatUsdc(decoded.gross - fee)} USDC; книга начислит ВКЛАДЧИКУ`
        : `claim(1): вклад ${formatUsdc(decoded.gross)} USDC вернулся вкладчику`,
      "tx",
      explorerTx(tx),
      "ok",
    );
    await refreshBalances(lab);
  };

  const contributions = el("div");
  for (const contribution of entry.contributions) {
    contributions.append(
      el("div", { className: "row" }, [
        span("└ вклад", "muted"),
        link(short(contribution.escrow), explorerAddress(contribution.escrow)),
        span(`${formatUsdc(BigInt(contribution.gross))} USDC`, "pill"),
        span(short(contribution.donor), "muted"),
        button("claim(0) settle", () => claimOne(contribution, 0)),
        button("claim(1) refund", () => claimOne(contribution, 1)),
        button("refund()", async () => {
          const escrow = new PublicKey(contribution.escrow);
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
      span(`коллекция ${short(entry.collectionId)}`, "pill"),
      span(`получатель ${short(entry.recipient)} · цель ${formatUsdc(BigInt(entry.goal))} USDC`, "muted"),
      labeled("вкладчик", contributor),
      labeled("USDC", gross),
      button("2. внести вклад", async () => {
        const donor = selectedSigner(lab, contributor);
        const manager = participantByAddress(lab, entry.recipient);
        const now = BigInt(Math.floor(Date.now() / 1000));
        const deadline = now + BigInt(entry.duration) + 120n + DEADLINE_MARGIN + 600n;
        const nonce = now;
        const grossUnits = BigInt(Math.round(Number(gross.value) * 1e6));
        const birth = {
          donor: donor.publicKey,
          // In this game the escrow's recipient is the collection's recipient.
          recipient: manager.publicKey,
          gross: grossUnits,
          deadline,
          resolver: fromHex(entry.resolver),
          feeBps: lab.feeBps,
          feeWallet: lab.feeWallet.toBytes(),
          nonce,
        };
        const { instruction, escrow } = twoOutcomeCreateIx(birth, lab.addresses);
        const signature = await send(lab.connection, donor, [instruction]);
        update((store) => {
          const target = store.collections.find((collection) => collection.collectionId === entry.collectionId);
          target?.contributions.push({
            escrow: escrow.toBase58(),
            donor: donor.address,
            gross: grossUnits.toString(),
            deadline: deadline.toString(),
            nonce: nonce.toString(),
          });
        });
        logLink(`вклад ${gross.value} USDC от ${donor.label}`, "tx", explorerTx(signature), "ok");
        await refreshBalances(lab);
        lab.refresh();
      }),
      button("3. ready", () => say("ready", entry.recipient)),
      button("отмена (получатель)", () => say("cancel", entry.recipient)),
      labeled("голосует", voter),
      button("4. голос done", () => vote(lab, entry, voter, FUNDING_CHOICE.done)),
      button("голос not_done", () => vote(lab, entry, voter, FUNDING_CHOICE.notDone)),
      button("состояние", showState),
      // The censorship path: select the operator's imported key in «голосует».
      button("operator-refund", async () => {
        const operator = selectedSigner(lab, voter);
        await say("operator-refund", operator.address);
      }),
      button("×", () => {
        update((store) => {
          store.collections = store.collections.filter(
            (collection) => collection.collectionId !== entry.collectionId,
          );
        });
        lab.refresh();
      }),
    ]),
    contributions,
    state,
  ]);
}

async function vote(
  lab: Lab,
  entry: CollectionEntry,
  select: HTMLSelectElement,
  choice: (typeof FUNDING_CHOICE)[keyof typeof FUNDING_CHOICE],
): Promise<void> {
  if (!lab.funding) throw new Error("canister id игры не задан");
  const voter = selectedSigner(lab, select);
  const id = fromHex(entry.collectionId);
  const message = collectionMessage(lab.chainId, lab.ids.conditionalFunding, id, {
    kind: "vote",
    choice,
  });
  const signature = await voter.signMessage(message);
  const out = await lab.funding.vote({
    chain: lab.chainId,
    collection_id: id,
    voter: voter.publicKey,
    choice: choice === FUNDING_CHOICE.done ? { done: null } : { not_done: null },
    signature,
  });
  if ("Err" in out) throw new Error(`vote: ${out.Err}`);
  log(`голос ${choice} принят (${voter.label})`, "ok");
}
