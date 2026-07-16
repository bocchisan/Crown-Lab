// «Задания» — the two-outcome game. One escrow per task; the canister signs
// the verdict its own state machine reached, and the shape enforces it.
//
// The whole scenario, in the order the e2e drives it:
//   resolver → create escrow → register → accept|decline → done → vote →
//   (voting period) → verdict → claim(0|1);  refund() lives outside the game.

import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";

import { asBytes, decodeTaskRecord, optional } from "../canisters.ts";
import { fromHex, hex, utf8 } from "../bytes.ts";
import { decodeTwoOutcome, refuseIfSettled } from "../escrow.ts";
import { createAtaIx, ed25519VerifyIx, twoOutcomeClaimIx, twoOutcomeCreateIx, twoOutcomeRefundIx } from "../ix.ts";
import { type Lab, participantByAddress } from "../lab.ts";
import { explorerAddress, explorerTx, formatUsdc, send } from "../net.ts";
import { TASK_CHOICE, type TaskAction, taskMessage, twoOutcomeVerdictMessage } from "../messages.ts";
import { type TaskEntry, load, update } from "../store.ts";
import { button, el, field, labeled, link, log, logLink, row, section, short, span } from "../ui.ts";
import { participantSelect, refreshBalances, selectedSigner } from "./participants.ts";

/** The canister's own floor (config/testnet.toml: min_gross = 34). */
const MIN_GROSS = 34n;
/** Frozen in the game's logic crate. */
const DEADLINE_MARGIN = 259_200n;

let resolverHex = "";

async function resolver(lab: Lab): Promise<Uint8Array> {
  if (!lab.tasks) throw new Error("canister id игры «задания» не задан");
  const value = optional(await lab.tasks.get_resolver(lab.chainId));
  if (!value) throw new Error("резолвер ещё не прогрелся (threshold-ключ) — подожди и повтори");
  return asBytes(value);
}

export function tasksPanel(lab: Lab): HTMLElement {
  const donor = participantSelect(lab);
  const streamer = participantSelect(lab);
  const gross = field("USDC", "0.03", 8);
  const duration = field("duration", "3600", 7);
  const votingPeriod = field("voting_period", "120", 6);
  const text = field("текст", "проверка лаборатории", 22);

  const createRow = row(
    labeled("донор", donor),
    labeled("стример", streamer),
    labeled("USDC", gross),
    labeled("duration, с", duration),
    labeled("voting_period, с", votingPeriod),
    labeled("текст", text),
    button("1. создать эскроу", async () => {
      const key = await resolver(lab);
      const donorSigner = selectedSigner(lab, donor);
      const streamerSigner = selectedSigner(lab, streamer);
      const grossUnits = BigInt(Math.round(Number(gross.value) * 1e6));
      if (grossUnits < MIN_GROSS) throw new Error(`gross ниже пола игры (${MIN_GROSS} minor)`);
      const now = BigInt(Math.floor(Date.now() / 1000));
      // The canister demands deadline >= now + duration + voting_period +
      // DEADLINE_MARGIN; the extra minute absorbs the clock drift.
      const deadline = now + BigInt(duration.value) + BigInt(votingPeriod.value) + DEADLINE_MARGIN + 600n;
      const nonce = now;
      const birth = {
        donor: donorSigner.publicKey,
        streamer: streamerSigner.publicKey,
        gross: grossUnits,
        deadline,
        resolver: key,
        feeBps: lab.feeBps,
        feeWallet: lab.feeWallet.toBytes(),
        nonce,
      };
      const { instruction, escrow } = twoOutcomeCreateIx(birth, lab.addresses);
      const signature = await send(lab.connection, donorSigner, [instruction]);
      // task_id ≡ the escrow address: the canister derives the same bytes.
      const entry: TaskEntry = {
        escrow: escrow.toBase58(),
        taskId: hex(escrow.toBytes()),
        donor: donorSigner.address,
        streamer: streamerSigner.address,
        gross: grossUnits.toString(),
        deadline: deadline.toString(),
        duration: duration.value,
        nonce: nonce.toString(),
        textHash: hex(sha256(utf8(text.value))),
      };
      update((store) => store.tasks.unshift(entry));
      logLink(`эскроу ${short(entry.escrow)} создан на ${gross.value} USDC`, "tx", explorerTx(signature), "ok");
      await refreshBalances(lab);
      lab.refresh();
    }),
    button("резолвер", async () => {
      resolverHex = hex(await resolver(lab));
      log(`резолвер игры: ${resolverHex}`, "ok");
      lab.refresh();
    }),
  );

  const list = el("div");
  for (const entry of load().tasks) list.append(taskRow(lab, entry));

  return section(
    "Игра «Задания» — two-outcome",
    el("div", { className: "muted" }, [
      "Донор вешает эскроу и регистрирует задание, стример принимает и отмечает выполненным, " +
        "держатели репутации голосуют. По истечении voting_period канистра решает и подписывает вердикт: " +
        "settle → деньги стримеру через сплиттер (за вычетом комиссии игры), cancel → донору. " +
        `Голос требует веса ≥ 100000 (донат ≥ 0.1 USDC этому же стримеру). Резолвер: ${resolverHex ? short(resolverHex) : "—"}`,
    ]),
    createRow,
    list,
  );
}

function taskRow(lab: Lab, entry: TaskEntry): HTMLElement {
  const voter = participantSelect(lab, entry.donor);
  const state = el("div", { className: "muted" });

  // accept/decline/done are the streamer's moves: the canister checks the
  // signature against the streamer stored in the record, nobody else's.
  const call = async (
    method: "accept" | "decline" | "done",
    signerAddress: string,
  ): Promise<void> => {
    if (!lab.tasks) throw new Error("canister id игры не задан");
    const actual = participantByAddress(lab, signerAddress);
    const message = taskMessage(lab.chainId, lab.ids.conditionalTasks, fromHex(entry.taskId), {
      kind: method,
    });
    const signature = await actual.signMessage(message);
    const out = await lab.tasks[method]({
      chain: lab.chainId,
      task_id: fromHex(entry.taskId),
      signature,
    });
    if ("Err" in out) throw new Error(`${method}: ${out.Err}`);
    log(`${method}: ok (подписал ${actual.label})`, "ok");
    await showState();
  };

  const showState = async (): Promise<void> => {
    if (!lab.tasks) throw new Error("canister id игры не задан");
    const certified = optional(await lab.tasks.get_task(lab.chainId, fromHex(entry.taskId)));
    if (!certified) {
      state.textContent = "канистра задания не знает (ещё не зарегистрировано)";
      return;
    }
    const record = decodeTaskRecord(asBytes(certified.data));
    const name = Object.keys(record.state)[0] ?? "?";
    const votes = record.votes
      .map((vote) => `${short(new PublicKey(asBytes(vote.voter)).toBase58())}:${Object.keys(vote.choice)[0]}(${vote.weight})`)
      .join(", ");
    const decided = "decided" in record.state ? Object.keys(record.state.decided.outcome)[0] : null;
    state.textContent =
      `состояние: ${name}${decided ? ` → ${decided}` : ""} · голоса: ${votes || "нет"} · ` +
      `сертификат: ${certified.certificate.length ? "есть" : "нет"}`;
    log(state.textContent, "muted");
  };

  const claim = async (outcome: number): Promise<void> => {
    if (!lab.tasks) throw new Error("canister id игры не задан");
    // A settled escrow is terminal: say so before spending a round-trip on a
    // verdict the chain will refuse anyway.
    const escrow = new PublicKey(entry.escrow);
    const account = await lab.connection.getAccountInfo(escrow);
    if (!account) throw new Error("эскроу не найден на чейне");
    const decoded = decodeTwoOutcome(new Uint8Array(account.data));
    refuseIfSettled(decoded, "claim");

    const verdict = optional(await lab.tasks.get_verdict(lab.chainId, fromHex(entry.taskId)));
    if (!verdict) throw new Error("вердикта ещё нет — задание не решено");
    const signature = optional(verdict.signature);
    if (!signature) throw new Error("вердикт есть, подписи ещё нет — канистра подпишет в течение тика");
    // The canister signs ITS verdict. Asking for the other outcome builds a
    // different message, so the signature stops verifying and the ed25519
    // precompile fails with InvalidSignature — which is the guarantee working,
    // not a bug. Say that instead of shipping a doomed transaction.
    const decided = Object.keys(verdict.outcome)[0] ?? "?";
    const decidedOutcome = "settle" in verdict.outcome ? 0 : 1;
    if (decidedOutcome !== outcome) {
      throw new Error(
        `вердикт канистры — ${decided}, а claim(${outcome}) просит ` +
          `${outcome === 0 ? "settle" : "cancel"}: подпись под один исход не открывает другой. ` +
          `Это и есть гарантия игры — жми claim(${decidedOutcome}).`,
      );
    }
    log(`вердикт канистры: ${decided}`, "muted");

    const payer = selectedSigner(lab, voter);
    const message = twoOutcomeVerdictMessage(lab.domains.twoOutcome, lab.addresses.factoryTwoOutcome, escrow, outcome);
    const tx = await send(lab.connection, payer, [
      createAtaIx(new PublicKey(payer.publicKey), new PublicKey(decoded.streamer), lab.addresses.usdc),
      createAtaIx(new PublicKey(payer.publicKey), new PublicKey(decoded.feeWallet), lab.addresses.usdc),
      // The ed25519 record must sit immediately before the claim.
      ed25519VerifyIx(asBytes(decoded.resolver), asBytes(signature), message),
      twoOutcomeClaimIx(escrow, decoded, outcome, lab.addresses),
    ]);
    const fee = (decoded.gross * BigInt(decoded.feeBps)) / 10_000n;
    logLink(
      outcome === 0
        ? `claim(0): стримеру ${formatUsdc(decoded.gross - fee)} USDC, комиссия игры ${formatUsdc(fee)}`
        : `claim(1): донору вернулось ${formatUsdc(decoded.gross)} USDC, книга не двигается`,
      "tx",
      explorerTx(tx),
      "ok",
    );
    await refreshBalances(lab);
  };

  return el("div", { className: "row" }, [
    link(short(entry.escrow), explorerAddress(entry.escrow)),
    span(`${formatUsdc(BigInt(entry.gross))} USDC`, "pill"),
    button("2. register", async () => {
      if (!lab.tasks) throw new Error("canister id игры не задан");
      const donorSigner = participantByAddress(lab, entry.donor);
      const key = await resolver(lab);
      const message = taskMessage(lab.chainId, lab.ids.conditionalTasks, fromHex(entry.taskId), {
        kind: "register",
        textHash: fromHex(entry.textHash),
        duration: BigInt(entry.duration),
      });
      const signature = await donorSigner.signMessage(message);
      const out = await lab.tasks.register_task({
        chain: lab.chainId,
        donor: donorSigner.publicKey,
        streamer: new PublicKey(entry.streamer).toBytes(),
        gross: BigInt(entry.gross),
        deadline: BigInt(entry.deadline),
        resolver: key,
        nonce: BigInt(entry.nonce),
        duration: BigInt(entry.duration),
        text_hash: fromHex(entry.textHash),
        signature,
      });
      if ("Err" in out) throw new Error(`register: ${out.Err}`);
      log(`задание зарегистрировано: task_id ${short(entry.escrow)} (≡ адрес эскроу)`, "ok");
      await showState();
    }),
    button("3. accept", () => call("accept", entry.streamer)),
    button("decline", () => call("decline", entry.streamer)),
    button("4. done", () => call("done", entry.streamer)),
    labeled("голосует", voter),
    button("5. голос done", () => vote(lab, entry, voter, TASK_CHOICE.done)),
    button("голос not_done", () => vote(lab, entry, voter, TASK_CHOICE.notDone)),
    button("состояние", showState),
    button("6. claim(0) settle", () => claim(0)),
    button("claim(1) cancel", () => claim(1)),
    button("refund", async () => {
      const escrow = new PublicKey(entry.escrow);
      const account = await lab.connection.getAccountInfo(escrow);
      if (!account) throw new Error("эскроу не найден");
      const decoded = decodeTwoOutcome(new Uint8Array(account.data));
      refuseIfSettled(decoded, "refund");
      const payer = selectedSigner(lab, voter);
      const tx = await send(lab.connection, payer, [twoOutcomeRefundIx(escrow, decoded, lab.addresses)]);
      logLink("refund(): деньги донору без всякой подписи (только после дедлайна)", "tx", explorerTx(tx), "ok");
      await refreshBalances(lab);
    }),
    button("×", () => {
      update((store) => {
        store.tasks = store.tasks.filter((task) => task.escrow !== entry.escrow);
      });
      lab.refresh();
    }),
    state,
  ]);
}

async function vote(
  lab: Lab,
  entry: TaskEntry,
  select: HTMLSelectElement,
  choice: (typeof TASK_CHOICE)[keyof typeof TASK_CHOICE],
): Promise<void> {
  if (!lab.tasks) throw new Error("canister id игры не задан");
  const voter = selectedSigner(lab, select);
  const message = taskMessage(lab.chainId, lab.ids.conditionalTasks, fromHex(entry.taskId), {
    kind: "vote",
    choice,
  });
  const signature = await voter.signMessage(message);
  const out = await lab.tasks.vote({
    chain: lab.chainId,
    task_id: fromHex(entry.taskId),
    voter: voter.publicKey,
    choice: choice === TASK_CHOICE.done ? { done: null } : { not_done: null },
    signature,
  });
  if ("Err" in out) throw new Error(`vote: ${out.Err}`);
  log(`голос ${choice} принят (${voter.label}); вес взят из книги`, "ok");
}
