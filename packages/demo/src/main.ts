import { DocSession, move } from "@collab/client";

const NAMES = ["ash", "bea", "cy", "dara", "eli", "fern", "gus", "hana", "ivo", "juno"];
const COLORS = ["#5aa9ff", "#f0883e", "#4fd28b", "#e06c9a", "#c792ea", "#ffcb6b"];

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const area = $<HTMLTextAreaElement>("text");
const mirror = $<HTMLDivElement>("mirror");
const peerList = $<HTMLDivElement>("peers");
const dot = $<HTMLSpanElement>("dot");

const docId = (location.hash.slice(1) || "scratch").trim();
$("doc-name").textContent = `/ ${docId}`;

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];

const session = new DocSession({
  url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`,
  doc: docId,
  name: pick(NAMES),
  color: pick(COLORS),
});

$("site").textContent = String(session.site);

session.on("status", (status) => {
  $("status").textContent = status;
  dot.className = `dot ${status}`;
  area.readOnly = status === "closed";
});

session.on("change", (events, source) => {
  if (source === "remote") {
    // Keep the caret where the user left it, allowing for text that just
    // appeared to the left of it.
    let start = area.selectionStart;
    let end = area.selectionEnd;
    for (const event of events) {
      start = move(start, event);
      end = move(end, event);
    }
    area.value = session.text;
    area.setSelectionRange(start, end);
  }
  paint();
});

session.on("peers", paint);
session.on("error", (err) => console.warn("[collab]", err.code, err.detail));

area.addEventListener("input", () => {
  const before = session.text;
  const after = area.value;
  if (before === after) return;

  const patch = diff(before, after);
  if (patch.removed > 0) session.remove(patch.at, patch.removed);
  if (patch.added.length > 0) session.insert(patch.at, patch.added);
  reportSelection();
});

area.addEventListener("scroll", () => {
  mirror.scrollTop = area.scrollTop;
});

document.addEventListener("selectionchange", () => {
  if (document.activeElement === area) reportSelection();
});

function reportSelection(): void {
  session.setSelection(area.selectionStart, area.selectionEnd);
}

/**
 * A textarea only tells us what it looks like now, so work out the edit from
 * the shared prefix and suffix. That is enough for typing, pasting and
 * selection replacement, which is everything this demo can produce.
 */
function diff(before: string, after: string): { at: number; removed: number; added: string } {
  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before[start] === after[start]) start++;

  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }

  return { at: start, removed: endBefore - start, added: after.slice(start, endAfter) };
}

function paint(): void {
  const text = session.text;
  if (area.value !== text) area.value = text;

  $("chars").textContent = String(text.length);
  $("rtt").textContent = session.rtt > 0 ? `${session.rtt} ms` : "—";

  const peers = session
    .peers()
    .map((peer) => ({
      at: Math.min(Math.max(peer.state.head, 0), text.length),
      name: peer.state.name,
      color: safeColor(peer.state.color),
    }))
    .sort((a, b) => a.at - b.at);

  let html = "";
  let cursor = 0;
  for (const peer of peers) {
    html += escape(text.slice(cursor, peer.at));
    html += `<i class="caret" style="color:${peer.color}"><span>${escape(peer.name)}</span></i>`;
    cursor = peer.at;
  }
  // The trailing newline keeps a caret on the last line from being clipped.
  mirror.innerHTML = html + escape(text.slice(cursor)) + "\n";
  mirror.scrollTop = area.scrollTop;

  peerList.innerHTML =
    peers.length === 0
      ? '<div class="empty">Just you for now.</div>'
      : peers
          .map(
            (peer) =>
              `<div class="peer"><span class="swatch" style="background:${peer.color}"></span>` +
              `<span>${escape(peer.name)}</span><span class="at">${peer.at}</span></div>`,
          )
          .join("");
}

function escape(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** Presence comes from another client, so don't paste it into a style blindly. */
function safeColor(value: string): string {
  return /^#[0-9a-f]{3,8}$/i.test(value) ? value : "#8b93a1";
}

session.connect();
paint();
setInterval(() => {
  $("rtt").textContent = session.rtt > 0 ? `${session.rtt} ms` : "—";
}, 2000);
