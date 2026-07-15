// Regenerate the Contributors table in README.md between the CONTRIBUTORS markers.
// Counts come from `git shortlog -sne` (identities consolidated by .mailmap, applied by git).
// GitHub handles are auto-derived from each author's `<id>+<handle>@users.noreply.github.com`
// commit email, so this works in any repo with zero per-repo config. Add a HANDLES override
// only when someone commits with a non-GitHub email and you still want their avatar/link.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// Optional overrides: canonical git name (post-.mailmap) -> GitHub handle.
const HANDLES = {
  "MusfiqurTuhin": "MusfiqurTuhin",
  "Antardip Himel": "AntardipHimel",
  "Prithweeraj Acharjee": "Prithweeraj-Acharjee",
};
const ROLES = {};
// Non-people to keep out of the table (bots).
const EXCLUDE = new Set(["github-actions[bot]", "github-actions", "dependabot[bot]"]);

const START = "<!-- CONTRIBUTORS:START (auto-generated — do not edit by hand) -->";
const END = "<!-- CONTRIBUTORS:END -->";

if (!existsSync("README.md")) { console.error("No README.md"); process.exit(1); }

// Derive a GitHub handle from a noreply email, e.g. 123456+octocat@users.noreply.github.com -> octocat
function handleFromEmail(email) {
  if (!email) return null;
  let m = email.match(/^\d+\+([A-Za-z0-9-]+)@users\.noreply\.github\.com$/i);
  if (m) return m[1];
  m = email.match(/^([A-Za-z0-9-]+)@users\.noreply\.github\.com$/i);
  if (m) return m[1];
  return null;
}

const shortlog = execSync("git shortlog -sne HEAD", { encoding: "utf8" });
const rows = shortlog
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    const m = l.match(/^(\d+)\s+(.+?)\s+<(.+)>$/);
    return m ? { count: Number(m[1]), name: m[2], email: m[3] } : null;
  })
  .filter((r) => r && !EXCLUDE.has(r.name));

// Lines ADDED per author (%aN is mailmap-aware). Merges + lockfiles excluded for a fairer count.
const locAdded = {};
const numstat = execSync(
  'git log --no-merges --numstat --pretty=%x01%aN HEAD -- . ":(exclude)*.lock" ":(exclude)**/package-lock.json" ":(exclude)package-lock.json" ":(exclude)**/pnpm-lock.yaml" ":(exclude)**/yarn.lock"',
  { encoding: "utf8", maxBuffer: 1 << 30 }
);
let cur = null;
for (const line of numstat.split("\n")) {
  if (line.startsWith("\x01")) { cur = line.slice(1); continue; }
  const m = line.match(/^(\d+)\t\d+\t/);
  if (m && cur) locAdded[cur] = (locAdded[cur] || 0) + Number(m[1]);
}

// Rank by lines added (the "how much code" view the table leads with).
rows.sort((a, b) => (locAdded[b.name] || 0) - (locAdded[a.name] || 0));

const total = rows.reduce((n, r) => n + r.count, 0);
const totalLoc = rows.reduce((n, r) => n + (locAdded[r.name] || 0), 0);
let table = "| | Contributor | GitHub | Lines added | Commits |\n| :---: | :--- | :--- | ---: | ---: |\n";
for (const r of rows) {
  const handle = HANDLES[r.name] || handleFromEmail(r.email);
  const role = ROLES[r.name] ? ` _(${ROLES[r.name]})_` : "";
  const avatar = handle ? `<img src="https://github.com/${handle}.png?size=48" width="34" height="34" alt="" />` : "";
  const gh = handle ? `[@${handle}](https://github.com/${handle})` : "—";
  table += `| ${avatar} | **${r.name}**${role} | ${gh} | ${(locAdded[r.name] || 0).toLocaleString()} | **${r.count}** |\n`;
}
table += `| | | **Total** | **${totalLoc.toLocaleString()}** | **${total}** |\n`;

const readme = readFileSync("README.md", "utf8");
const re = new RegExp(`${START.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}[\\s\\S]*?${END}`);
if (!re.test(readme)) {
  console.error("Contributors markers not found in README.md");
  process.exit(1);
}
writeFileSync("README.md", readme.replace(re, `${START}\n${table}${END}`));
console.log("Contributors table regenerated:\n" + table);
