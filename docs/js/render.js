// render.js — pure HTML-string builders (kept DOM-free so node can test them).

import { tierClass, evaluate, sortValue, average, median } from "./transform.js";

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export function pctSpan(pct) {
  const shown = Math.floor(pct);
  return `<span class="pct ${tierClass(shown)}">${shown}%</span>`;
}

// A percentile with a one-letter meaning suffix: 91b / 84a / 87m.
export function pctTag(pct, suffix) {
  const shown = Math.floor(pct);
  return `<span class="pct ${tierClass(shown)}">${shown}<i class="sfx">${suffix}</i></span>`;
}

// best · average · median as "91b 84a 87m". pcts drives avg/median.
export function bamHTML(best, pcts) {
  const arr = pcts?.length ? pcts : [best];
  return `${pctTag(best, "b")} ${pctTag(Math.round(average(arr)), "a")} ${pctTag(Math.round(median(arr)), "m")}`;
}

function muted(text) {
  return `<span class="muted">${esc(text)}</span>`;
}

// "today" / "6d" / "3mo" — how long ago a run happened (whenMs from the API).
export function ageText(whenMs, nowMs = Date.now()) {
  if (typeof whenMs !== "number" || whenMs <= 0) return null;
  const days = Math.floor((nowMs - whenMs) / 86_400_000);
  if (days < 1) return "today";
  if (days < 45) return `${days}d`;
  return `${Math.round(days / 30)}mo`;
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
    return `${bamHTML(ev.anyAtLevel.pct, ev.anyAtLevel.pcts)} ${muted(`(${runs} dungeon${runs === 1 ? "" : "s"})`)}`;
  }
  if (ev.anyBest) {
    return `${muted(`none at +${level} · best`)} +${ev.anyBest.level} ${pctSpan(ev.anyBest.pct)}`;
  }
  return muted(level ? `no logs +${level - 4}–+${level + 4}` : "no M+ logs");
}

export function dungeonCellHTML(ev, level, encounterID) {
  if (ev.status !== "OK" || !encounterID) return muted("—");
  const d = ev.dungeon;
  if (d) {
    const marker = d.kind === "below" ? ` (one below)` : d.kind === "above" ? ` (higher)` : "";
    const age = ageText(d.when);
    return `${bamHTML(d.pct, d.pcts)} ${muted(`@+${d.level}${marker}${d.spec ? " · " + d.spec : ""}${age ? " · " + age : ""}`)}`;
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
  const color = CLASS_COLORS[cls] ?? "#e8e6e3";
  return `<span class="charname" style="color:${color}">${esc(name)}</span>`;
}

// Small ↗ link to the character's full Warcraft Logs page.
export function profileLinkHTML(region, slug, fullName) {
  if (!slug || !region) return "";
  const charName = fullName.split("-")[0];
  const href = `https://www.warcraftlogs.com/character/${encodeURIComponent(region)}/${encodeURIComponent(slug)}/${encodeURIComponent(charName)}`;
  return ` <a class="wcl-link" href="${href}" target="_blank" rel="noopener" title="open on Warcraft Logs">↗</a>`;
}

// Per-character detail: dungeons x key levels matrix, with per-level
// average/median (across dungeons) at the bottom. Caller passes an
// already-windowed player.
export function detailMatrixHTML(player, encounters, targetLevel) {
  if (!player || player.missing) return "";
  const levels = player.levels ?? {};
  const levelNums = Object.keys(levels).map(Number).sort((a, b) => a - b);
  if (levelNums.length === 0) return `<div class="muted detail-empty">No Mythic+ logs in this range.</div>`;

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
        // each percentile links to the exact report fight it came from;
        // hover shows when the run happened (percentile is frozen to that day)
        const when = d.when ? new Date(d.when).toISOString().slice(0, 10) : null;
        const title = when ? `run on ${when} — open its report` : "open this run's report";
        const cell = d.report?.code
          ? `<a class="runlink" target="_blank" rel="noopener" title="${title}"
               href="https://www.warcraftlogs.com/reports/${encodeURIComponent(d.report.code)}?fight=${Number(d.report.fightID) || 1}&type=damage-done">${pctSpan(d.pct)}</a>`
          : `<span${when ? ` title="run on ${when}"` : ""}>${pctSpan(d.pct)}</span>`;
        row += `<td class="${l === targetLevel ? "target-level" : ""}">${cell}</td>`;
      } else {
        row += `<td class="${l === targetLevel ? "target-level" : ""}"><span class="muted">·</span></td>`;
      }
    }
    row += `</tr>`;
    if (any) body += row;
  }
  if (!body) return `<div class="muted detail-empty">No Mythic+ logs in this range.</div>`;

  // per-level stats across dungeons
  const statsRow = (label, fn) => {
    let row = `<tr class="stats"><td class="dungeon-col">${label}</td>`;
    for (const l of levelNums) {
      const pcts = Object.values(levels[l]?.dungeons ?? {}).map((d) => d.pct);
      const v = fn(pcts);
      row += `<td class="${l === targetLevel ? "target-level" : ""}">${v === null ? "" : pctSpan(Math.round(v))}</td>`;
    }
    return row + `</tr>`;
  };
  body += statsRow("Average", average);
  body += statsRow("Median", median);

  return `<table class="detail">${head}${body}</table>`;
}

// The main summary table.
// entries: [{ fullName, player (windowed), slug, region }]
export function summaryHTML(entries, { level, encounter, encounters }) {
  const rows = entries
    .map(({ fullName, player, slug, region }) => {
      const ev = evaluate(player, encounter?.id, level);
      return { fullName, player, slug, region, ev, sort: sortValue(ev) };
    })
    .sort((a, b) => (a.sort !== b.sort ? b.sort - a.sort : a.fullName.localeCompare(b.fullName)));

  const anyHead = level ? `Any dungeon @+${level}` : "Any dungeon";
  const dgHead = encounter ? `${esc(encounter.name)}${level ? ` (want +${level})` : ""}` : "This dungeon";

  let html = `<div class="table-wrap"><table class="summary"><thead><tr>
    <th>Applicant</th><th>${anyHead}</th><th>${dgHead}</th>
  </tr></thead><tbody>`;

  rows.forEach(({ fullName, player, slug, region, ev }, i) => {
    html += `<tr class="row" data-idx="${i}">
      <td>${nameHTML(fullName, player?.class)}${profileLinkHTML(region, slug, fullName)}</td>
      <td>${anyCellHTML(ev, level)}</td>
      <td>${dungeonCellHTML(ev, level, encounter?.id)}</td>
    </tr>
    <tr class="detail-row" data-idx="${i}"><td colspan="3">${detailMatrixHTML(player, encounters, level)}</td></tr>`;
  });

  html += `</tbody></table></div>`;
  return html;
}
