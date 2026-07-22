// The core: a direct donate through the splitter, and the book that reads it
// back. This panel is the one that proves the whole loop — a donate here is
// the reputation the games' votes are weighed with.

import { PublicKey } from "@solana/web3.js";

import { type CanisterName, type Lab, setCanisterId } from "../lab.ts";
import { createAtaIx, donateIx } from "../ix.ts";
import { explorerAddress, explorerTx, formatUsdc, send } from "../net.ts";
import { button, el, field, labeled, link, log, logLink, row, section, short, span } from "../ui.ts";
import { participantSelect, refreshBalances, selectedSigner } from "./participants.ts";

/** Cached so the book line survives a re-render without re-querying. */
let bookLine = "нажми «читать книгу»";
let statusLine = "";
/** The last donate's signature, waiting to be pushed into the book. */
let lastSignature: string | null = null;

export function corePanel(lab: Lab): HTMLElement {
  const from = participantSelect(lab);
  const to = participantSelect(lab);
  const amount = field("USDC", "0.1", 8);

  const donateRow = row(
    span("донат:"),
    labeled("от", from),
    labeled("получателю", to),
    labeled("USDC", amount),
    button("донат через сплиттер", async () => {
      const donor = selectedSigner(lab, from);
      const recipient = selectedSigner(lab, to);
      const gross = BigInt(Math.round(Number(amount.value) * 1e6));
      if (gross <= 0n) throw new Error("нулевой донат программа отвергнет");
      const recipientKey = new PublicKey(recipient.publicKey);
      const signature = await send(lab.connection, donor, [
        // The recipient may have no USDC account yet; the splitter demands it.
        createAtaIx(new PublicKey(donor.publicKey), recipientKey, lab.addresses.usdc),
        donateIx(new PublicKey(donor.publicKey), recipientKey, gross, lab.addresses),
      ]);
      lastSignature = signature;
      logLink(
        `донат ${amount.value} USDC: ${donor.label} → ${recipient.label} (весь gross, комиссии нет)`,
        "tx",
        explorerTx(signature),
        "ok",
      );
      log("подпись запомнена; после финализации нажми «записать в книгу»", "muted");
      await refreshBalances(lab);
    }),
    // The push: the relayer pays to include this donate's signature. The caller
    // attaches no cycles — the relayer does, from its budget (relay-spec §2).
    button("записать в книгу (relay.submit)", async () => {
      if (!lab.relay) throw new Error("canister id crown-relay не задан");
      if (!lastSignature) throw new Error("сначала сделай донат — нужна его подпись");
      const result = await lab.relay.submit(lastSignature);
      if ("Refused" in result) throw new Error(`релеер отказал: ${result.Refused}`);
      const forwarded = result.Forwarded;
      if ("Rejected" in forwarded) {
        log(`индекс отверг: ${forwarded.Rejected} — не финализирован? повтори через пару секунд`, "wait");
      } else {
        log(`записано в книгу: ${forwarded.Applied} сеттлмент(ов)`, "ok");
      }
    }),
  );

  // ---- the book ----
  const donor = participantSelect(lab);
  const recipient = participantSelect(lab);
  const bookRow = row(
    span("книга:"),
    labeled("донор", donor),
    labeled("получатель", recipient),
    button("читать книгу", async () => {
      if (!lab.index) throw new Error("canister id crown-index не задан");
      const p = selectedSigner(lab, donor);
      const s = selectedSigner(lab, recipient);
      const reputation = await lab.index.get_reputation(lab.chainId, p.publicKey, s.publicKey);
      const anomalies = await lab.index.get_anomaly_count();
      const applied = await lab.index.get_applied_count();
      bookLine = `${p.label} → ${s.label}: ${formatUsdc(reputation)} USDC репутации (${reputation} minor)`;
      statusLine = `аномалий: ${anomalies} · применённых подписей: ${applied} · reduce v${await lab.index.get_reduce_version()}`;
      log(bookLine, "ok");
      if (anomalies > 0n) log(`аномалий ${anomalies} — сверка события с переводом не сошлась`, "bad");
      lab.refresh();
    }),
  );

  const info = el("div", { className: "muted" }, [
    `профиль ${lab.profile} · сеть ${lab.chainId} · комиссия игр ${lab.feeBps / 100}% → ${short(lab.feeWallet.toBase58())}`,
    el("br"),
    "сплиттер ",
    link(short(lab.addresses.splitter.toBase58()), explorerAddress(lab.addresses.splitter.toBase58())),
    " · two-outcome ",
    link(short(lab.addresses.factoryTwoOutcome.toBase58()), explorerAddress(lab.addresses.factoryTwoOutcome.toBase58())),
    " · stream ",
    link(short(lab.addresses.factoryStream.toBase58()), explorerAddress(lab.addresses.factoryStream.toBase58())),
  ]);

  return section(
    "Ядро — донат и книга",
    info,
    donateRow,
    bookRow,
    el("div", {}, [span(bookLine)]),
    el("div", { className: "muted" }, [statusLine]),
    canisterRow(lab),
  );
}

/**
 * Canister ids come from config/local.toml (written by scripts/lab-up.sh); a
 * replica that was redeployed by hand can be pointed at from here instead.
 */
function canisterRow(lab: Lab): HTMLElement {
  const names: [CanisterName, string][] = [
    ["crownIndex", "crown-index"],
    ["crownRelay", "crown-relay"],
    ["conditionalTasks", "задания"],
    ["conditionalFunding", "сбор"],
    ["auction", "аукцион"],
    ["subscription", "подписка"],
  ];
  const container = el("div", { className: "row" }, [span("канистры:")]);
  for (const [name, title] of names) {
    const id = lab.ids[name];
    const input = field(title, id, 28);
    input.addEventListener("change", () => {
      setCanisterId(name, input.value);
      log(`${title}: canister id = ${input.value || "—"}; перезагрузи страницу`, "wait");
    });
    container.append(labeled(title, input), span(id ? "✓" : "не задан", id ? "ok" : "bad"));
  }
  return container;
}
