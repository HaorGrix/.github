// Org-wide contribution analytics for every HaorGrix repository.
//
// Data source: GitHub's stats/contributors API per repo (server-side counts —
// no cloning). GitHub computes these lazily, so 202 responses are retried.
//
// Outputs:
//   1. ALWAYS  — org dashboard spliced into profile/README.md between the
//      ORG-ANALYTICS markers (shows on github.com/HaorGrix front page):
//      leaderboard across all repos + per-repo table + monthly org cadence.
//   2. OPTIONAL — when ORG_ANALYTICS_TOKEN (org PAT, repo scope) is present,
//      pushes a per-repo analytics section into each active repo's README via
//      the contents API (marker-based; section is appended once if missing).
//
// Bots excluded. Lifetime numbers, plus a last-30-days activity slice.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const ORG = process.env.ORG || "HaorGrix";
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
const PAT = process.env.ORG_ANALYTICS_TOKEN || ""; // optional, enables per-repo push

const START = "<!-- ORG-ANALYTICS:START (auto-generated — do not edit by hand) -->";
const END = "<!-- ORG-ANALYTICS:END -->";
const REPO_START = "<!-- REPO-ANALYTICS:START (auto-generated — do not edit by hand) -->";
const REPO_END = "<!-- REPO-ANALYTICS:END -->";

const isBot = (login) => !login || /\[bot\]$/i.test(login) || /^github-actions$/i.test(login);
const num = (n) => (n || 0).toLocaleString("en-US");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (path, { method = "GET", body, token = TOKEN, raw = false } = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 202) return 202; // stats still computing
  if (res.status === 204) return null; // empty repo — no stats body at all
  if (!res.ok) return null;
  if (raw) return res.text();
  try {
    return await res.json();
  } catch {
    return null; // empty/malformed body (e.g. 200 with no content)
  }
};

// ---- enumerate repos --------------------------------------------------------
const repos = [];
for (let page = 1; ; page++) {
  const batch = await api(`/orgs/${ORG}/repos?per_page=100&page=${page}`);
  if (!Array.isArray(batch) || batch.length === 0) break;
  repos.push(...batch.map((r) => ({ name: r.name, archived: r.archived, pushed: r.pushed_at })));
  if (batch.length < 100) break;
}
console.log(`repos: ${repos.length}`);

// ---- per-repo contributor stats (retry 202s) --------------------------------
const cutoff30 = Math.floor((Date.now() - 30 * 864e5) / 1000);
const person = {}; // login -> {add, del, commits, a30, d30, c30, repos:Set}
const perRepo = {}; // repo -> {add, del, commits, contributors:Set, c30}
const monthly = {}; // YYYY-MM -> {add, del, commits} (trailing 6 months)
const monthKeys = [];
{
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    monthKeys.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  }
}

for (const r of repos) {
  let stats = null;
  for (let i = 0; i < 6; i++) {
    stats = await api(`/repos/${ORG}/${r.name}/stats/contributors`);
    if (stats !== 202) break;
    await sleep(5000);
  }
  if (!Array.isArray(stats)) { console.log(`  skip ${r.name} (no stats)`); continue; }
  for (const c of stats) {
    const login = c.author?.login;
    if (isBot(login)) continue;
    const p = (person[login] ??= { add: 0, del: 0, commits: 0, a30: 0, d30: 0, c30: 0, repos: new Set() });
    const rr = (perRepo[r.name] ??= { add: 0, del: 0, commits: 0, contributors: new Set(), c30: 0 });
    p.commits += c.total;
    rr.commits += c.total;
    rr.contributors.add(login);
    p.repos.add(r.name);
    for (const w of c.weeks) {
      p.add += w.a; p.del += w.d;
      rr.add += w.a; rr.del += w.d;
      if (w.w >= cutoff30) { p.a30 += w.a; p.d30 += w.d; p.c30 += w.c; rr.c30 += w.c; }
      if (w.c || w.a || w.d) {
        const mk = new Date(w.w * 1000).toISOString().slice(0, 7);
        if (monthKeys.includes(mk)) {
          const m = (monthly[mk] ??= { add: 0, del: 0, commits: 0 });
          m.add += w.a; m.del += w.d; m.commits += w.c;
        }
      }
    }
  }
}

// ---- render org dashboard ---------------------------------------------------
const logins = Object.keys(person).sort((a, b) => person[b].add - person[a].add);
const T = { add: 0, del: 0, commits: 0 };
for (const l of logins) { T.add += person[l].add; T.del += person[l].del; T.commits += person[l].commits; }
const activeRepos = Object.entries(perRepo).filter(([, v]) => v.commits > 0)
  .sort((a, b) => b[1].add - a[1].add);
const genDate = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
const trend = (c30) => (c30 === 0 ? "▪ idle" : c30 >= 40 ? "▲ high" : c30 >= 10 ? "△ active" : "▵ light");

let out = "";
out += `## 📊 Org Contribution Analytics\n\n`;
out += `> **${logins.length}** contributors · **${activeRepos.length}** repos with code · **${num(T.commits)}** commits · **+${num(T.add)} / −${num(T.del)}** lines (net **${num(T.add - T.del)}**) · refreshed weekly (Thu 18:00 BDT)\n\n`;

out += `### Team leaderboard — lifetime, all repos\n\n`;
out += `| | Contributor | Lines + | Lines − | Net | Commits | Repos | 30-day |\n`;
out += `| :---: | :--- | ---: | ---: | ---: | ---: | ---: | :---: |\n`;
for (const l of logins) {
  const p = person[l];
  out += `| <a href="https://github.com/${l}"><img src="https://github.com/${l}.png?size=48" width="34" height="34" alt="@${l}" /></a> | [@${l}](https://github.com/${l}) | ${num(p.add)} | ${num(p.del)} | ${num(p.add - p.del)} | **${num(p.commits)}** | ${p.repos.size} | ${trend(p.c30)} |\n`;
}
out += `| | **Total** | **${num(T.add)}** | **${num(T.del)}** | **${num(T.add - T.del)}** | **${num(T.commits)}** | ${activeRepos.length} | |\n\n`;

out += `### Repositories\n\n`;
out += `| Repository | Lines + | Lines − | Commits | Contributors | 30-day |\n`;
out += `| :--- | ---: | ---: | ---: | ---: | :---: |\n`;
for (const [name, v] of activeRepos) {
  out += `| [${name}](https://github.com/${ORG}/${name}) | ${num(v.add)} | ${num(v.del)} | ${num(v.commits)} | ${v.contributors.size} | ${trend(v.c30)} |\n`;
}
out += `\n### Org cadence (trailing 6 months)\n\n`;
out += `| Month | Commits | Lines + | Lines − |\n| :--- | ---: | ---: | ---: |\n`;
for (const mk of monthKeys) {
  const m = monthly[mk] || { add: 0, del: 0, commits: 0 };
  out += `| ${mk} | ${num(m.commits)} | ${num(m.add)} | ${num(m.del)} |\n`;
}
out += `\n<sub>Auto-generated ${genDate} · source: GitHub contributor statistics · bots excluded · lockfile/vendor churn not filtered (API-level counts)</sub>\n`;

const readmePath = "profile/README.md";
const readme = readFileSync(readmePath, "utf8");
const re = new RegExp(`${START.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}[\\s\\S]*?${END}`);
if (re.test(readme)) {
  writeFileSync(readmePath, readme.replace(re, `${START}\n${out}${END}`));
} else {
  writeFileSync(readmePath, readme.trimEnd() + `\n\n---\n\n${START}\n${out}${END}\n`);
}
console.log("org dashboard written to profile/README.md");

// ---- optional: per-repo README sections (needs org PAT) ---------------------
if (PAT) {
  for (const [name, v] of activeRepos) {
    // per-repo per-person detail needs the repo's own stats; re-fetch once
    const stats = await api(`/repos/${ORG}/${name}/stats/contributors`);
    if (!Array.isArray(stats)) continue;
    let section = `### 📊 Contribution Analytics\n\n| | Contributor | Lines + | Lines − | Net | Commits |\n| :---: | :--- | ---: | ---: | ---: | ---: |\n`;
    const rowsR = stats
      .filter((c) => !isBot(c.author?.login))
      .map((c) => ({
        login: c.author.login,
        add: c.weeks.reduce((n, w) => n + w.a, 0),
        del: c.weeks.reduce((n, w) => n + w.d, 0),
        commits: c.total,
      }))
      .sort((a, b) => b.add - a.add);
    for (const r of rowsR) {
      section += `| <a href="https://github.com/${r.login}"><img src="https://github.com/${r.login}.png?size=48" width="30" height="30" alt="@${r.login}" /></a> | [@${r.login}](https://github.com/${r.login}) | ${num(r.add)} | ${num(r.del)} | ${num(r.add - r.del)} | **${num(r.commits)}** |\n`;
    }
    section += `\n<sub>Auto-updated weekly (Thu 18:00 BDT) by [org-analytics](https://github.com/${ORG}/.github) · bots excluded</sub>\n`;

    const file = await api(`/repos/${ORG}/${name}/contents/README.md`, { token: PAT });
    if (!file?.content) { console.log(`  ${name}: no README, skipped`); continue; }
    const current = Buffer.from(file.content, "base64").toString("utf8");
    const reR = new RegExp(`${REPO_START.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}[\\s\\S]*?${REPO_END}`);
    const block = `${REPO_START}\n${section}${REPO_END}`;
    const next = reR.test(current)
      ? current.replace(reR, block)
      : current.trimEnd() + `\n\n---\n\n${block}\n`;
    if (next === current) continue;
    const put = await api(`/repos/${ORG}/${name}/contents/README.md`, {
      method: "PUT",
      token: PAT,
      body: {
        message: "docs(readme): auto-update contribution analytics [skip ci]",
        content: Buffer.from(next).toString("base64"),
        sha: file.sha,
      },
    });
    console.log(`  ${name}: ${put ? "updated" : "FAILED"}`);
    await sleep(500);
  }
} else {
  console.log("ORG_ANALYTICS_TOKEN not set — per-repo README push skipped (org dashboard only)");
}
