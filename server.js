import express from "express";
import qrcode from "qrcode";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const EVENTS_DIR = path.join(__dirname, "events");
const MAX_LEN = 500;
const RATE_MS = 800; // ponytail: IP당 최소 간격. 분산 배포 땐 Redis로 승급.

fs.mkdirSync(DATA_DIR, { recursive: true });

// --- in-memory rooms, jsonl로 영속 ---
const rooms = new Map(); // code -> { clients:Set<res>, messages:[] }

function eventMeta(code) {
  const f = path.join(EVENTS_DIR, `${code}.json`);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

function room(code) {
  let r = rooms.get(code);
  if (r) return r;
  r = { clients: new Set(), messages: [], byId: new Map(), votes: {} };
  const f = path.join(DATA_DIR, `${code}.jsonl`);
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const o = JSON.parse(line);
      if (o.t === "r") {
        // 리액션 라인: 해당 메시지 카운트 증가
        const m = r.byId.get(o.id);
        if (m) m.reactions++;
      } else if (o.t === "v") {
        // 투표 라인: poll별 옵션 카운트
        (r.votes[o.poll] ||= {})[o.opt] = (r.votes[o.poll]?.[o.opt] || 0) + 1;
      } else {
        o.reactions = o.reactions || 0;
        r.messages.push(o);
        r.byId.set(o.id, o);
      }
    }
  }
  rooms.set(code, r);
  return r;
}

// poll의 옵션 개수만큼 카운트 배열로 정규화
function pollCounts(code, poll) {
  const raw = room(code).votes[poll.id] || {};
  return poll.options.map((_, i) => raw[i] || 0);
}

function addVote(code, poll, opt) {
  if (opt < 0 || opt >= poll.options.length) return null;
  const r = room(code);
  (r.votes[poll.id] ||= {})[opt] = (r.votes[poll.id]?.[opt] || 0) + 1;
  append(code, { t: "v", poll: poll.id, opt });
  const counts = pollCounts(code, poll);
  broadcast(code, { kind: "vote", poll: poll.id, counts });
  return counts;
}

function append(code, obj) {
  fs.appendFileSync(path.join(DATA_DIR, `${code}.jsonl`), JSON.stringify(obj) + "\n");
}

function broadcast(code, obj) {
  const payload = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of room(code).clients) res.write(payload);
}

function addMessage(code, text) {
  const r = room(code);
  const msg = { id: r.messages.length + 1, text, ts: Date.now(), reactions: 0 };
  r.messages.push(msg);
  r.byId.set(msg.id, msg);
  append(code, { id: msg.id, text: msg.text, ts: msg.ts });
  broadcast(code, { kind: "msg", ...msg });
  return msg;
}

function addReaction(code, id) {
  const m = room(code).byId.get(id);
  if (!m) return null;
  m.reactions++;
  append(code, { t: "r", id });
  broadcast(code, { kind: "react", id, reactions: m.reactions });
  return m.reactions;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const lastPost = new Map(); // ip -> ts

app.get("/r/:code", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "join.html"))
);
app.get("/present/:code", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "present.html"))
);

// 이벤트 메타 + 최근 메시지 + poll 집계 (초기 로드용)
app.get("/api/:code", (req, res) => {
  const meta = eventMeta(req.params.code);
  if (!meta) return res.status(404).json({ error: "unknown event code" });
  const polls = (meta.polls || []).map((p) => ({ ...p, counts: pollCounts(req.params.code, p) }));
  res.json({ ...meta, polls, messages: room(req.params.code).messages });
});

// SSE stream
app.get("/stream/:code", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // nginx 버퍼링 방지
  });
  res.write(": connected\n\n");
  const r = room(req.params.code);
  r.clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(ping);
    r.clients.delete(res);
  });
});

// 익명 메시지 전송
app.post("/msg/:code", (req, res) => {
  if (!eventMeta(req.params.code))
    return res.status(404).json({ error: "unknown event code" });
  const text = (req.body?.text ?? "").toString().trim();
  if (!text) return res.status(400).json({ error: "empty" });
  if (text.length > MAX_LEN)
    return res.status(400).json({ error: `too long (max ${MAX_LEN})` });
  const ip = req.headers["cf-connecting-ip"] || req.ip;
  const now = Date.now();
  if (now - (lastPost.get(ip) || 0) < RATE_MS)
    return res.status(429).json({ error: "slow down" });
  lastPost.set(ip, now);
  res.json(addMessage(req.params.code, text));
});

// 익명 리액션 (👍) — 계정 없으니 탭 카운터, Slido "반응"과 동일
app.post("/react/:code/:id", (req, res) => {
  if (!eventMeta(req.params.code))
    return res.status(404).json({ error: "unknown event code" });
  const n = addReaction(req.params.code, Number(req.params.id));
  if (n === null) return res.status(404).json({ error: "no such message" });
  res.json({ id: Number(req.params.id), reactions: n });
});

// 익명 투표 (객관식 poll)
app.post("/vote/:code/:poll/:opt", (req, res) => {
  const meta = eventMeta(req.params.code);
  if (!meta) return res.status(404).json({ error: "unknown event code" });
  const poll = (meta.polls || []).find((p) => p.id === req.params.poll);
  if (!poll) return res.status(404).json({ error: "no such poll" });
  const counts = addVote(req.params.code, poll, Number(req.params.opt));
  if (counts === null) return res.status(400).json({ error: "bad option" });
  res.json({ poll: poll.id, counts });
});

// QR (참가 URL 인코딩)
app.get("/qr/:code.svg", async (req, res) => {
  const base = `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`;
  const svg = await qrcode.toString(`${base}/r/${req.params.code}`, {
    type: "svg",
    margin: 1,
  });
  res.type("svg").send(svg);
});

app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

// --- 자체 체크: node server.js --selftest ---
function selftest() {
  const code = "__test__";
  fs.writeFileSync(path.join(EVENTS_DIR, `${code}.json`), JSON.stringify({ code, title: "t" }));
  fs.rmSync(path.join(DATA_DIR, `${code}.jsonl`), { force: true });
  const a = addMessage(code, "hello");
  console.assert(a.id === 1 && a.text === "hello", "first message");
  addMessage(code, "world");
  addReaction(code, 1);
  addReaction(code, 1);
  console.assert(room(code).byId.get(1).reactions === 2, "reactions counted");
  console.assert(addReaction(code, 999) === null, "react to missing msg -> null");
  const poll = { id: "p1", q: "?", options: ["a", "b", "c"] };
  addVote(code, poll, 0);
  addVote(code, poll, 2);
  addVote(code, poll, 2);
  console.assert(addVote(code, poll, 9) === null, "out-of-range option -> null");
  console.assert(JSON.stringify(pollCounts(code, poll)) === "[1,0,2]", "vote counts");
  rooms.delete(code); // 파일에서 다시 로드되는지 확인
  const reloaded = room(code);
  console.assert(reloaded.messages.length === 2, "reload from jsonl");
  console.assert(reloaded.byId.get(1).reactions === 2, "reactions persist across reload");
  console.assert(JSON.stringify(pollCounts(code, poll)) === "[1,0,2]", "votes persist across reload");
  const validate = (t) => {
    t = (t ?? "").toString().trim();
    if (!t) return "empty";
    if (t.length > MAX_LEN) return "too long";
    return null;
  };
  console.assert(validate("") === "empty", "empty rejected");
  console.assert(validate("  ") === "empty", "whitespace rejected");
  console.assert(validate("x".repeat(MAX_LEN + 1)) === "too long", "length rejected");
  console.assert(validate("ok") === null, "valid accepted");
  fs.rmSync(path.join(EVENTS_DIR, `${code}.json`), { force: true });
  fs.rmSync(path.join(DATA_DIR, `${code}.jsonl`), { force: true });
  console.log("selftest ok");
}

if (process.argv.includes("--selftest")) {
  selftest();
} else {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`qr-chat on :${PORT}`));
}
