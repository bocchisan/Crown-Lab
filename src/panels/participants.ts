// Participants: who signs what. A scenario needs four of them, so the page
// keeps burner keys next to the connected wallet and funds them from it.

import { PublicKey } from "@solana/web3.js";

import { type Lab, allParticipants, connectedWallets, participantByAddress } from "../lab.ts";
import { type Balances, balancesOf, explorerAddress, explorerTx, formatSol, formatUsdc, fund } from "../net.ts";
import { type Signer, burnerSigner, importBurner, loadBurners, newBurner, saveBurners } from "../signer.ts";
import { discoverWallets, solanaChainOf } from "../wallet.ts";
import { button, el, field, labeled, link, log, logLink, row, section, short, span } from "../ui.ts";

/** Balances are read once per render and cached here, so tables paint fast. */
const cache = new Map<string, Balances>();
/** book[(chain, participant, bookStreamer)], filled by the same refresh. */
const reputation = new Map<string, bigint>();
/** Whose book we are looking at: reputation is always local to a streamer. */
let bookStreamer: string | null = null;

export function participantSelect(lab: Lab, selected?: string): HTMLSelectElement {
  const select = el("select");
  for (const signer of allParticipants(lab)) {
    const option = el("option", { value: signer.address, textContent: `${signer.label} (${short(signer.address)})` });
    if (signer.address === selected) option.selected = true;
    select.append(option);
  }
  if (select.options.length === 0) select.append(el("option", { value: "", textContent: "— нет участников —" }));
  return select;
}

export function selectedSigner(lab: Lab, select: HTMLSelectElement): Signer {
  return participantByAddress(lab, select.value);
}

export async function refreshBalances(lab: Lab): Promise<void> {
  const participants = allParticipants(lab);
  bookStreamer ??= participants[0]?.address ?? null;
  const streamer = participants.find((signer) => signer.address === bookStreamer);

  for (const signer of participants) {
    cache.set(
      signer.address,
      await balancesOf(lab.connection, new PublicKey(signer.publicKey), lab.addresses.usdc),
    );
    if (lab.index && streamer) {
      reputation.set(
        signer.address,
        await lab.index.get_reputation(lab.chainId, signer.publicKey, streamer.publicKey),
      );
    }
  }
  lab.refresh();
}

export function participantsPanel(lab: Lab): HTMLElement {
  // Reputation is per (payer, streamer): the column is meaningless without
  // naming whose book we read, so the header carries the choice.
  const streamerPick = participantSelect(lab, bookStreamer ?? undefined);
  streamerPick.addEventListener("change", () => {
    bookStreamer = streamerPick.value;
    void refreshBalances(lab);
  });
  const streamerLabel = allParticipants(lab).find((signer) => signer.address === bookStreamer);

  const table = el("table", {}, [
    el("thead", {}, [
      el("tr", {}, [
        el("th", { textContent: "участник" }),
        el("th", { textContent: "тип" }),
        el("th", { textContent: "адрес" }),
        el("th", { textContent: "SOL" }),
        el("th", { textContent: "USDC" }),
        el("th", { textContent: `репутация → ${streamerLabel ? streamerLabel.label : "?"}` }),
        el("th", { textContent: "" }),
      ]),
    ]),
  ]);
  const body = el("tbody");
  for (const signer of allParticipants(lab)) {
    const balances = cache.get(signer.address);
    const actions = el("td");
    if (signer.kind === "burner") {
      actions.append(
        button("ключ", () => {
          const stored = loadBurners().find((burner) => burner.label === signer.label);
          if (stored) log(`${signer.label}: ${stored.secret}`, "muted");
        }),
        button("удалить", () => {
          saveBurners(loadBurners().filter((burner) => burner.label !== signer.label));
          reloadBurners(lab);
        }),
      );
    }
    const rep = reputation.get(signer.address);
    // The vote's weight floor in «Задания» and «Сбор» is 100000 minor.
    const enough = rep !== undefined && rep >= 100_000n;
    body.append(
      el("tr", {}, [
        el("td", { textContent: signer.label }),
        el("td", {}, [span(signer.kind === "wallet" ? "кошелёк" : "burner", "pill")]),
        el("td", {}, [link(short(signer.address), explorerAddress(signer.address))]),
        el("td", { textContent: balances ? formatSol(balances.sol) : "—" }),
        el("td", { textContent: balances ? formatUsdc(balances.usdc) : "—" }),
        el("td", {}, [
          rep === undefined
            ? span("—", "muted")
            : span(`${formatUsdc(rep)} (${rep})`, enough ? "ok" : "muted"),
        ]),
        actions,
      ]),
    );
  }
  table.append(body);

  // ---- adding participants ----
  const wallets = discoverWallets(solanaChainOf(lab.chainId));
  const walletRow = row(span("кошелёк:"));
  if (wallets.length === 0) {
    walletRow.append(
      span(
        "расширение не объявилось. Phantom/Solflare должны быть установлены, разблокированы и " +
          "не спрятаны за другим кошельком; страница подхватит их сама, как только они зарегистрируются.",
        "muted",
      ),
    );
  }
  for (const wallet of wallets) {
    const connect = button(`подключить ${wallet.name}`, async () => {
      const signer = await wallet.connect();
      if (connectedWallets.some((existing) => existing.address === signer.address)) {
        log(`${signer.label} уже подключён`, "muted");
        return;
      }
      connectedWallets.push(signer);
      log(`подключён ${signer.label}: ${signer.address}`, "ok");
      await refreshBalances(lab);
    });
    if (wallet.blocked) {
      // Listed anyway, with the reason: an extension that is installed but
      // silently absent from the page is impossible to debug otherwise.
      connect.disabled = true;
      connect.title = wallet.blocked;
      walletRow.append(connect, span(wallet.blocked, "bad"));
    } else {
      walletRow.append(connect);
    }
  }

  const burnerLabel = field("label", "burner", 10);
  const importText = field("ключ", "", 26);
  const addRow = row(
    span("burner:"),
    labeled("имя", burnerLabel),
    button("создать", () => {
      const burner = newBurner(burnerLabel.value.trim() || `burner-${loadBurners().length + 1}`);
      saveBurners([...loadBurners(), burner]);
      log(`создан burner ${burner.label}`, "ok");
      reloadBurners(lab);
    }),
    labeled("импорт (base58 или [1,2,…])", importText),
    button("импортировать", () => {
      const burner = importBurner(burnerLabel.value.trim() || `burner-${loadBurners().length + 1}`, importText.value);
      saveBurners([...loadBurners(), burner]);
      importText.value = "";
      log(`импортирован ${burner.label}`, "ok");
      reloadBurners(lab);
    }),
  );

  // ---- funding ----
  const from = participantSelect(lab);
  const to = participantSelect(lab);
  const sol = field("SOL", "0.02", 8);
  const usdc = field("USDC", "0.2", 8);
  const fundRow = row(
    span("профинансировать:"),
    labeled("от", from),
    labeled("кому", to),
    labeled("SOL", sol),
    labeled("USDC", usdc),
    button("перевести", async () => {
      const source = selectedSigner(lab, from);
      const target = selectedSigner(lab, to);
      if (source.address === target.address) throw new Error("отправитель и получатель совпадают");
      const signature = await fund(
        lab.connection,
        source,
        new PublicKey(target.publicKey),
        lab.addresses.usdc,
        BigInt(Math.round(Number(sol.value) * 1e9)),
        BigInt(Math.round(Number(usdc.value) * 1e6)),
      );
      logLink(`${source.label} → ${target.label}: ${sol.value} SOL, ${usdc.value} USDC`, "tx", explorerTx(signature), "ok");
      await refreshBalances(lab);
    }),
  );

  return section(
    "Участники",
    table,
    row(
      button("обновить балансы и репутацию", () => refreshBalances(lab)),
      labeled("книга стримера", streamerPick),
      span("репутация всегда локальна стримеру: у одного кошелька их столько, скольким он донатил", "muted"),
    ),
    walletRow,
    addRow,
    fundRow,
    el("div", { className: "muted" }, [
      "Донор должен держать devnet USDC (faucet.circle.com) и SOL. Остальные роли проще держать burner-ключами: " +
        "они подписывают сообщения канистрам и платят ренту, а девать их некуда — это devnet.",
    ]),
  );
}

function reloadBurners(lab: Lab): void {
  lab.participants = loadBurners().map(burnerSigner);
  lab.refresh();
  void refreshBalances(lab);
}
