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
  r = { clients: new Set(), messages: [] };
  const f = path.join(DATA_DIR, `${code}.jsonl`);
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (line.trim()) r.messages.push(JSON.parse(line));
    }
  }
  rooms.set(code, r);
  return r;
}

function addMessage(code, text) {
  const msg = { id: room(code).messages.length + 1, text, ts: Date.now() };
  const r = room(code);
  r.messages.push(msg);
  fs.appendFileSync(path.join(DATA_DIR, `${code}.jsonl`), JSON.stringify(msg) + "\n");
  const payload = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of r.clients) res.write(payload);
  return msg;
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

// 이벤트 메타 + 최근 메시지 (초기 로드용)
app.get("/api/:code", (req, res) => {
  const meta = eventMeta(req.params.code);
  if (!meta) return res.status(404).json({ error: "unknown event code" });
  res.json({ ...meta, messages: room(req.params.code).messages });
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
  rooms.delete(code); // 파일에서 다시 로드되는지 확인
  console.assert(room(code).messages.length === 2, "reload from jsonl");
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
