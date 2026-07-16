// Tiny DOM helpers and the log. No framework: the page is buttons and text,
// and every panel renders itself from scratch after each action.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

export function row(...children: (Node | string)[]): HTMLDivElement {
  return el("div", { className: "row" }, children);
}

export function button(label: string, onClick: () => void | Promise<void>): HTMLButtonElement {
  const node = el("button", { textContent: label });
  node.addEventListener("click", () => {
    void run(node, onClick);
  });
  return node;
}

/**
 * One action at a time per button: devnet round-trips take seconds and a
 * double click would send the same transaction twice.
 */
async function run(node: HTMLButtonElement, action: () => void | Promise<void>): Promise<void> {
  const label = node.textContent;
  node.disabled = true;
  node.textContent = `${label} …`;
  try {
    await action();
  } catch (error) {
    log(`✗ ${error instanceof Error ? error.message : String(error)}`, "bad");
  } finally {
    node.disabled = false;
    node.textContent = label;
  }
}

export function field(label: string, value: string, size = 12): HTMLInputElement {
  const input = el("input", { value, size });
  input.dataset.label = label;
  return input;
}

export function labeled(label: string, input: HTMLElement): HTMLLabelElement {
  return el("label", {}, [`${label} `, input]);
}

export function section(title: string, ...children: (Node | string)[]): HTMLElement {
  return el("section", {}, [el("h2", { textContent: title }), ...children]);
}

export function short(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function link(text: string, href: string): HTMLAnchorElement {
  return el("a", { textContent: text, href, target: "_blank", rel: "noreferrer" });
}

export function span(text: string, className = ""): HTMLSpanElement {
  return el("span", { textContent: text, className });
}

type Tone = "" | "ok" | "bad" | "wait" | "muted";

/** The running record of the session: every action, every signature, in order. */
export function log(message: string, tone: Tone = ""): void {
  const box = document.getElementById("log");
  if (!box) return;
  const stamp = new Date().toLocaleTimeString("ru-RU");
  const line = el("div", { className: tone }, [`${stamp}  ${message}`]);
  box.append(line);
  box.scrollTop = box.scrollHeight;
}

export function logLink(message: string, text: string, href: string, tone: Tone = ""): void {
  const box = document.getElementById("log");
  if (!box) return;
  const stamp = new Date().toLocaleTimeString("ru-RU");
  const line = el("div", { className: tone }, [`${stamp}  ${message} `, link(text, href)]);
  box.append(line);
  box.scrollTop = box.scrollHeight;
}
