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

// Raw throughput, compactly: 1.25M / 21.1k / 845. The unit thresholds sit
// just under the round number so 999,999 reads "1M", not "1000k".
export function formatAmount(n) {
  // sub-1 throughput isn't a real run; rendering it as "0" under a
  // percentile just looks broken
  if (typeof n !== "number" || !Number.isFinite(n) || n < 1) return null;
  for (const [size, suffix, min] of [[1e9, "B", 999_500_000], [1e6, "M", 999_500], [1e3, "k", 999.5]]) {
    if (n < min) continue;
    const v = n / size;
    const shown = v >= 100 ? Math.round(v) : v >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100;
    return `${shown}${suffix}`;
  }
  return String(Math.round(n));
}

// What the raw numbers in a table mean. Healer tables are built from
// healing rankings, so their amounts are HPS, not DPS.
export function metricLabel(player) {
  return player?.metric === "hps" ? "HPS" : "DPS";
}

// The throughput line under a percentile.
export function amountHTML(amount, label) {
  const text = formatAmount(amount);
  return text ? `<span class="amt" title="${esc(label)}">${text}</span>` : "";
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

// Small role chip: T / H / D. Healers get a hint that their numbers are HPS.
const ROLE_META = {
  tank: ["T", "role-tank", "Tank — judged on damage (Key %)"],
  healer: ["H", "role-healer", "Healer — judged on healing (HPS Key %)"],
  dps: ["D", "role-dps", "DPS — judged on damage (Key %)"],
};

export function roleChipHTML(role) {
  if (!role) return "";
  const [letter, cls, title] = ROLE_META[role] ?? ROLE_META.dps;
  return ` <span class="role ${cls}" title="${title}">${letter}</span>`;
}

// Role chips for a row. Single-role players get the plain chip; multi-role
// players get one chip per played role — ordered by how many of their top
// keys (per-dungeon highest-score run) each role holds, most first. The
// viewed role is solid, the others dimmed and clickable (the row
// re-renders with that role's runs).
export function roleChipsHTML(entry) {
  const byRole = entry?.byRole ?? {};
  const roles = (entry?.order?.length ? entry.order : ["tank", "healer", "dps"])
    .filter((r) => byRole[r]);
  if (roles.length === 0) return roleChipHTML(entry?.player?.role ?? entry?.detected);
  if (roles.length === 1) return roleChipHTML(roles[0]);
  const totalTops = Object.values(entry?.topKeys ?? {}).reduce((a, v) => a + (v?.keys ?? 0), 0);
  return " " + roles.map((r) => {
    const [letter, cls, title] = ROLE_META[r];
    const state = r === entry.selected ? "sel" : "dim";
    const keys = entry?.topKeys?.[r]?.keys ?? 0;
    const tops = keys > 0 ? ` — holds ${keys} of their ${totalTops} top keys` : "";
    const hint = `${title}${tops}${state === "dim" ? " — click to judge them as this" : ""}`;
    return `<button type="button" class="role ${cls} ${state}" data-key="${esc(entry.key ?? entry.fullName)}" data-role="${r}" title="${hint}">${letter}</button>`;
  }).join("");
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

  // tables built from healing rankings link to the report's healing tab;
  // keyed off the metric, not the role, so a fallback table of dps-metric
  // numbers never mislabels its links
  const reportTab = player.metric === "hps" ? "healing" : "damage-done";
  const metric = metricLabel(player);

  let body = "";
  for (const e of encounters) {
    let row = `<tr><td class="dungeon-col">${esc(e.name)}</td>`;
    let any = false;
    for (const l of levelNums) {
      const d = levels[l]?.dungeons?.[e.id];
      if (d) {
        any = true;
        // each percentile links to the exact report fight it came from;
        // the throughput of that same run sits under it (the percentile
        // says how they ranked, the amount says what they actually did)
        const when = d.when ? new Date(d.when).toISOString().slice(0, 10) : null;
        const amountText = formatAmount(d.amount);
        const parts = [
          when ? `run on ${when}` : null,
          amountText ? `${amountText} ${metric}` : null,
        ].filter(Boolean);
        const inner = `${pctSpan(d.pct)}${amountHTML(d.amount, metric)}`;
        const cell = d.report?.code
          ? `<a class="runlink" target="_blank" rel="noopener" title="${esc([...parts, "open its report"].join(" — "))}"
               href="https://www.warcraftlogs.com/reports/${encodeURIComponent(d.report.code)}?fight=${Number(d.report.fightID) || 1}&type=${reportTab}">${inner}</a>`
          : `<span${parts.length ? ` title="${esc(parts.join(" — "))}"` : ""}>${inner}</span>`;
        row += `<td class="${l === targetLevel ? "target-level" : ""}">${cell}</td>`;
      } else {
        row += `<td class="${l === targetLevel ? "target-level" : ""}"><span class="muted">·</span></td>`;
      }
    }
    row += `</tr>`;
    if (any) body += row;
  }
  if (!body) return `<div class="muted detail-empty">No Mythic+ logs in this range.</div>`;

  // per-level stats across dungeons, same two-line shape as the cells
  const statsRow = (label, fn) => {
    let row = `<tr class="stats"><td class="dungeon-col">${label}</td>`;
    for (const l of levelNums) {
      const dungeons = Object.values(levels[l]?.dungeons ?? {});
      const v = fn(dungeons.map((d) => d.pct));
      const amounts = dungeons.map((d) => d.amount).filter((a) => typeof a === "number");
      // only summarize throughput when EVERY dungeon at this level has one:
      // an average over a subset, sat under an average over all of them,
      // reads as the same population and would quietly mislead
      const a = amounts.length === dungeons.length ? fn(amounts) : null;
      const cell = v === null ? "" : `${pctSpan(Math.round(v))}${a === null ? "" : amountHTML(a, `${label.toLowerCase()} ${metric}`)}`;
      row += `<td class="${l === targetLevel ? "target-level" : ""}">${cell}</td>`;
    }
    return row + `</tr>`;
  };
  body += statsRow("Average", average);
  body += statsRow("Median", median);

  const note = `<div class="matrix-note">Top number = Key % (rank at that key level) · under it = ${metric} on that run</div>`;
  return `<table class="detail">${head}${body}</table>${note}`;
}

// The main summary table.
// entries: [{ fullName, player (windowed), slug, region,
//             detected?, selected?, sortRole?, order?, topKeys?, byRole? }]
// player is the active view; sorting always follows the sortRole (the
// initially shown role) so toggling one row's chips never reshuffles
// the list.
export function summaryHTML(entries, { level, encounter, encounters }) {
  const rows = entries
    .map((entry) => {
      const { player, byRole, sortRole, detected } = entry;
      const ev = evaluate(player, encounter?.id, level);
      const sortPlayer = byRole?.[sortRole ?? detected] ?? player;
      const sortEv = sortPlayer === player ? ev : evaluate(sortPlayer, encounter?.id, level);
      return { ...entry, ev, sort: sortValue(sortEv) };
    })
    .sort((a, b) => (a.sort !== b.sort ? b.sort - a.sort : a.fullName.localeCompare(b.fullName)));

  const anyHead = level ? `Any dungeon @+${level}` : "Any dungeon";
  const dgHead = encounter ? `${esc(encounter.name)}${level ? ` (want +${level})` : ""}` : "This dungeon";

  let html = `<div class="table-wrap"><table class="summary"><thead><tr>
    <th>Applicant</th><th>${anyHead}</th><th>${dgHead}</th>
  </tr></thead><tbody>`;

  rows.forEach((entry, i) => {
    const { fullName, player, slug, region, ev } = entry;
    const key = esc(entry.key ?? fullName);
    html += `<tr class="row" data-idx="${i}" data-key="${key}">
      <td>${nameHTML(fullName, player?.class)}${roleChipsHTML(entry)}${profileLinkHTML(region, slug, fullName)}</td>
      <td>${anyCellHTML(ev, level)}</td>
      <td>${dungeonCellHTML(ev, level, encounter?.id)}</td>
    </tr>
    <tr class="detail-row" data-idx="${i}" data-key="${key}"><td colspan="3">${detailMatrixHTML(player, encounters, level)}</td></tr>`;
  });

  html += `</tbody></table></div>`;
  return html;
}
