// Phase 4 data migration: legacy wall messages become the permanent Q&A stream.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const eventsDir = path.join(root, "events");
const dataDir = path.join(root, "data");
let changed = 0;

for (const name of fs.readdirSync(eventsDir).filter((x) => x.endsWith(".json"))) {
  const file = path.join(eventsDir, name);
  const meta = JSON.parse(fs.readFileSync(file, "utf8"));
  meta.qaSort = meta.qaSort === "top" ? "top" : "recent";
  meta.polls = (meta.polls || []).map((p, i) => ({
    ...p,
    id: String(p.id),
    type: p.type === "text" ? "text" : "choice",
    sort: p.sort === "top" ? "top" : "recent",
    order: i,
  }));
  fs.writeFileSync(file, JSON.stringify(meta, null, 2) + "\n");
  changed++;

  const dataFile = path.join(dataDir, name.replace(/\.json$/, ".jsonl"));
  if (!fs.existsSync(dataFile)) continue;
  const lines = fs.readFileSync(dataFile, "utf8").split("\n");
  const migrated = lines.map((line) => {
    if (!line.trim()) return line;
    const item = JSON.parse(line);
    if (!item.t && !item.pollId) item.pollId = "qa";
    return JSON.stringify(item);
  });
  fs.writeFileSync(dataFile, migrated.join("\n"));
}
console.log(`migrated ${changed} event(s); legacy messages assigned to qa`);
