// render.js — pure HTML-string builders (kept DOM-free so node can test them).

import { tierClass, evaluate, sortValue } from "./transform.js";

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export function pctSpan(pct) {
  const shown = Math.floor(pct);
  return `<span class="pct ${tierClass(shown)}">${shown}%</span>`;
}

function muted(text) {
  return `<span class="muted">${esc(text)}</span>`;
}

export function anyCellHTML(ev, level) {
  if (ev.status === "NO_WCL") return muted("no WCL character");
  if (!level) {
    return ev.anyBest
      ? `${muted("best:")} +${ev.anyBest.level} ${pctSpan(ev.anyBest.pct)}`
      : muted("no M+ logs");
  }
  if (ev.anyAtLevel) {
    const runs = ev.anyAtLevel.runs;
    return `${pctSpan(ev.anyAtLevel.pct)} ${muted(`(${runs} dungeon${runs === 1 ? "" : "s"})`)}`;
  }
  if (ev.anyBest) {
    return `${muted(`none at +${level} · best`)} +${ev.anyBest.level} ${pctSpan(ev.anyBest.pct)}`;
  }
  return muted("no M+ logs");
}

export function dungeonCellHTML(ev, level, encounterID) {
  if (ev.status !== "OK" || !encounterID) return muted("—");
  const d = ev.dungeon;
  if (d) {
    const marker = d.kind === "below" ? ` (one below)` : d.kind === "above" ? ` (higher)` : "";
    return `${pctSpan(d.pct)} ${muted(`@+${d.level}${marker}${d.spec ? " · " + d.spec : ""}`)}`;
  }
  if (ev.dungeonBest) {
    return `${muted("only lower · best")} +${ev.dungeonBest.level} ${pctSpan(ev.dungeonBest.pct)}`;
  }
  return muted("never logged");
}

const CLASS_COLORS = {
  WARRIOR: "#c69b6d", PALADIN: "#f48cba", HUNTER: "#aad372", ROGUE: "#fff468",
  PRIEST: "#ffffff", DEATHKNIGHT: "#c41e3a", SHAMAN: "#0070dd", MAGE: "#3fc7eb",
  WARLOCK: "#8788ee", MONK: "#00ff98", DRUID: "#ff7c0a", DEMONHUNTER: "#a330c9",
  EVOKER: "#33937f",
};

export function nameHTML(name, cls) {
  const color = CLASS_COLORS[cls] ?? "#e8e8e8";
  return `<span class="charname" style="color:${color}">${esc(name)}</span>`;
}

// Per-character detail: dungeons x key levels matrix.
export function detailMatrixHTML(player, encounters, targetLevel) {
  if (!player || player.missing) return "";
  const levels = player.levels ?? {};
  const levelNums = Object.keys(levels).map(Number).sort((a, b) => a - b);
  if (levelNums.length === 0) return `<div class="muted detail-empty">No Mythic+ logs this season.</div>`;

  let head = `<tr><th class="dungeon-col">Dungeon</th>`;
  for (const l of levelNums) {
    const cls = l === targetLevel ? ' class="target-level"' : "";
    head += `<th${cls}>+${l}</th>`;
  }
  head += `</tr>`;

  let body = "";
  for (const e of encounters) {
    let row = `<tr><td class="dungeon-col">${esc(e.name)}</td>`;
    let any = false;
    for (const l of levelNums) {
      const d = levels[l]?.dungeons?.[e.id];
      if (d) {
        any = true;
        row += `<td class="${l === targetLevel ? "target-level" : ""}">${pctSpan(d.pct)}</td>`;
      } else {
        row += `<td class="${l === targetLevel ? "target-level" : ""}"><span class="muted">·</span></td>`;
      }
    }
    row += `</tr>`;
    if (any) body += row;
  }
  if (!body) return `<div class="muted detail-empty">No Mythic+ logs this season.</div>`;
  return `<table class="detail">${head}${body}</table>`;
}

// The main summary table. players: [{ fullName, player }]. Returns HTML.
export function summaryHTML(entries, { level, encounter, encounters }) {
  const rows = entries
    .map(({ fullName, player }) => {
      const ev = evaluate(player, encounter?.id, level);
      return { fullName, player, ev, sort: sortValue(ev) };
    })
    .sort((a, b) => (a.sort !== b.sort ? b.sort - a.sort : a.fullName.localeCompare(b.fullName)));

  const anyHead = level ? `Any dungeon @+${level}` : "Any dungeon";
  const dgHead = encounter ? `${esc(encounter.name)}${level ? ` (want +${level})` : ""}` : "This dungeon";

  let html = `<table class="summary"><thead><tr>
    <th>Applicant</th><th>${anyHead}</th><th>${dgHead}</th>
  </tr></thead><tbody>`;

  rows.forEach(({ fullName, player, ev }, i) => {
    html += `<tr class="row" data-idx="${i}">
      <td>${nameHTML(fullName, player?.class)}</td>
      <td>${anyCellHTML(ev, level)}</td>
      <td>${dungeonCellHTML(ev, level, encounter?.id)}</td>
    </tr>
    <tr class="detail-row" data-idx="${i}"><td colspan="3">${detailMatrixHTML(player, encounters, level)}</td></tr>`;
  });

  html += `</tbody></table>`;
  return html;
}
