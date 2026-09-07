import express from "express";
import qrcode from "qrcode";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const EVENTS_DIR = path.join(__dirname, "events");
const MAX_LEN = 500;
const RATE_MS = 800; // ponytail: IP당 최소 간격. 분산 배포 땐 Redis로 승급.
// 남용 방지용 상한(자원 한계가 아님). 이벤트 1개 ≈ 15KB라 수천 개도 부담 없다.
// MAX_EVENTS=0 이면 무제한. 환경변수로 조절.
const MAX_EVENTS = Number(process.env.MAX_EVENTS ?? 500);
const MAX_TITLE = 80;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_POLL_TITLE = 160;
const MAX_OPTIONS = 8;
const MAX_OPTION_LEN = 80;
const QA_ID = "qa";

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(EVENTS_DIR, { recursive: true });

// --- in-memory rooms, jsonl로 영속 ---
const rooms = new Map(); // code -> { clients:Set<res>, messages:[] }

function eventMeta(code) {
  const f = path.join(EVENTS_DIR, `${code}.json`);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

function normalizePoll(p, i) {
  const type = p.type === "text" ? "text" : "choice";
  return {
    ...p,
    id: String(p.id),
    type,
    q: String(p.q || "").trim().slice(0, MAX_POLL_TITLE),
    ...(type === "choice" ? { options: (p.options || []).map(String).slice(0, MAX_OPTIONS) } : { options: [] }),
    sort: p.sort === "top" ? "top" : "recent",
    order: Number.isInteger(p.order) ? p.order : i,
  };
}

function normalizeMeta(meta) {
  const polls = (meta.polls || []).map(normalizePoll);
  polls.forEach((p, i) => { p.order = i; });
  return { ...meta, polls, qaSort: meta.qaSort === "top" ? "top" : "recent" };
}

function saveMeta(code, meta) {
  const clean = normalizeMeta(meta);
  fs.writeFileSync(path.join(EVENTS_DIR, `${code}.json`), JSON.stringify(clean, null, 2) + "\n");
  return clean;
}

function eventCount() {
  return fs.readdirSync(EVENTS_DIR).filter((f) => f.endsWith(".json")).length;
}

// 7자리 숫자 코드 생성 (충돌 회피)
function newCode() {
  for (let i = 0; i < 50; i++) {
    const code = String(crypto.randomInt(1000000, 10000000));
    if (!eventMeta(code)) return code;
  }
  return null;
}

function room(code) {
  let r = rooms.get(code);
  if (r) return r;
  // stage: 강사가 프로젝터에 무엇을 어떻게 띄울지 (라이브 상태, 영속 안 함)
  const meta = eventMeta(code);
  r = { clients: new Set(), messages: [], byId: new Map(), reactors: new Map(), votes: {}, voters: {}, stage: { focus: QA_ID, sort: meta?.qaSort || "recent" } };
  const f = path.join(DATA_DIR, `${code}.jsonl`);
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const o = JSON.parse(line);
      if (o.t === "r") {
        // 리액션 라인: 해당 메시지 카운트 증가
        const m = r.byId.get(o.id);
        if (m) {
          if (o.token) {
            const tokens = r.reactors.get(o.id) || new Set();
            r.reactors.set(o.id, tokens);
            if (tokens.has(o.token)) continue;
            tokens.add(o.token);
          }
          m.reactions++;
        }
      } else if (o.t === "v") {
        // 투표 라인: poll별 옵션 카운트
        if (o.token) {
          const voters = (r.voters[o.poll] ||= {});
          if (voters[o.token] !== undefined) continue;
          voters[o.token] = Number(o.opt);
        }
        (r.votes[o.poll] ||= {})[o.opt] = (r.votes[o.poll]?.[o.opt] || 0) + 1;
      } else if (o.t === "uv") {
        const voters = r.voters[o.poll] || {};
        const opt = voters[o.token];
        if (opt === undefined) continue;
        delete voters[o.token];
        if (r.votes[o.poll]?.[opt] > 0) r.votes[o.poll][opt]--;
      } else if (o.t === "d") {
        const m = r.byId.get(o.id);
        if (m) m.deleted = true;
      } else if (o.t === "u") {
        const m = r.byId.get(o.id);
        if (m) m.deleted = false;
      } else if (o.t === "p") {
        const m = r.byId.get(o.id);
        if (m) m.pinned = o.on;
      } else {
        o.pollId = o.pollId || QA_ID;
        o.reactions = o.reactions || 0;
        o.deleted = false;
        o.pinned = false;
        r.messages.push(o);
        r.byId.set(o.id, o);
      }
    }
  }
  rooms.set(code, r);
  return r;
}

// 삭제 안 된 메시지만 (모든 화면 공통 노출 집합)
function visibleMessages(code) {
  return room(code).messages.filter((m) => !m.deleted);
}

function delMessage(code, id) {
  const m = room(code).byId.get(id);
  if (!m || m.deleted) return false;
  m.deleted = true;
  append(code, { t: "d", id });
  broadcast(code, { kind: "del", id });
  return true;
}

function restoreMessage(code, id) {
  const m = room(code).byId.get(id);
  if (!m || !m.deleted) return false;
  m.deleted = false;
  append(code, { t: "u", id });
  broadcast(code, { kind: "restore", id });
  return true;
}

function pinMessage(code, id, on) {
  const m = room(code).byId.get(id);
  if (!m) return false;
  m.pinned = !!on;
  append(code, { t: "p", id, on: m.pinned });
  broadcast(code, { kind: "pin", id, on: m.pinned });
  return true;
}

function setStage(code, focus, sort) {
  const r = room(code);
  r.stage = { focus, sort };
  const meta = normalizeMeta(eventMeta(code));
  if (focus === QA_ID) meta.qaSort = sort;
  else {
    const p = meta.polls.find((item) => item.id === focus);
    if (p) p.sort = sort;
  }
  saveMeta(code, meta);
  broadcast(code, { kind: "stage", ...r.stage });
  return r.stage;
}

// poll의 옵션 개수만큼 카운트 배열로 정규화
function pollCounts(code, poll) {
  const raw = room(code).votes[poll.id] || {};
  return poll.options.map((_, i) => raw[i] || 0);
}

// polls 브로드캐스트용: 객관식은 현재 집계(counts)까지 실어 보낸다 (편집 후 막대가 0으로 보이지 않게)
function pollsPayload(code, meta) {
  return normalizeMeta(meta).polls.map((p) => ({
    ...p,
    counts: p.type === "choice" ? pollCounts(code, p) : undefined,
  }));
}

function addVote(code, poll, opt, token = "") {
  if (opt < 0 || opt >= poll.options.length) return null;
  const r = room(code);
  if (token) {
    const voters = (r.voters[poll.id] ||= {});
    if (voters[token] !== undefined) {
      const previous = voters[token];
      if (previous === opt) return pollCounts(code, poll);
      if (r.votes[poll.id]?.[previous] > 0) r.votes[poll.id][previous]--;
      append(code, { t: "uv", poll: poll.id, token });
    }
    voters[token] = opt;
  }
  (r.votes[poll.id] ||= {})[opt] = (r.votes[poll.id]?.[opt] || 0) + 1;
  append(code, { t: "v", poll: poll.id, opt, ...(token ? { token } : {}) });
  const counts = pollCounts(code, poll);
  broadcast(code, { kind: "vote", poll: poll.id, counts });
  return counts;
}

function removeVote(code, poll, token) {
  if (!token) return null;
  const r = room(code);
  const voters = r.voters[poll.id] || {};
  const opt = voters[token];
  if (opt === undefined) return pollCounts(code, poll);
  delete voters[token];
  if (r.votes[poll.id]?.[opt] > 0) r.votes[poll.id][opt]--;
  append(code, { t: "uv", poll: poll.id, token });
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

function addMessage(code, text, pollId = QA_ID) {
  const r = room(code);
  const msg = { id: r.messages.length + 1, pollId, text, ts: Date.now(), reactions: 0, deleted: false, pinned: false };
  r.messages.push(msg);
  r.byId.set(msg.id, msg);
  append(code, { id: msg.id, pollId: msg.pollId, text: msg.text, ts: msg.ts });
  broadcast(code, { kind: "msg", ...msg });
  return msg;
}

function addReaction(code, id, token = "") {
  const m = room(code).byId.get(id);
  if (!m) return null;
  if (token) {
    const reactors = room(code).reactors;
    const tokens = reactors.get(id) || new Set();
    reactors.set(id, tokens);
    if (tokens.has(token)) return m.reactions;
    tokens.add(token);
  }
  m.reactions++;
  append(code, { t: "r", id, ...(token ? { token } : {}) });
  broadcast(code, { kind: "react", id, reactions: m.reactions });
  return m.reactions;
}

const app = express();
app.use(express.json());
// no-cache: Cloudflare가 JS/CSS를 굳혀서 낡은 번들을 서빙하지 않도록 (매 요청 재검증)
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  })
);
// 빌드 리포트 (docs/) 를 /report 로 공개. /report/ → qr-poll-build-report.html, 이미지는 /report/img/*
app.use(
  "/report",
  express.static(path.join(__dirname, "docs"), {
    index: "qr-poll-build-report.html",
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  })
);

const lastPost = new Map(); // ip -> ts (메시지)
const lastNew = new Map(); // ip -> ts (이벤트 생성)

// 새 이벤트 생성 (누구나 만들 수 있으나 총 MAX_EVENTS 개로 제한)
app.post("/new", (req, res) => {
  const ip = req.headers["cf-connecting-ip"] || req.ip;
  if (Date.now() - (lastNew.get(ip) || 0) < 5000)
    return res.status(429).json({ error: "Please try again in a moment." });
  const title = (req.body?.title ?? "").toString().trim().slice(0, MAX_TITLE);
  const presenterEmail = String(req.body?.presenterEmail || "").trim().toLowerCase();
  if (!title) return res.status(400).json({ error: "Please enter an event title." });
  if (!EMAIL_RE.test(presenterEmail)) return res.status(400).json({ error: "Please enter a valid presenter email." });
  if (MAX_EVENTS > 0 && eventCount() >= MAX_EVENTS)
    return res.status(403).json({ error: `Event limit reached (maximum ${MAX_EVENTS}).` });
  const code = newCode();
  if (!code) return res.status(500).json({ error: "Could not generate an event code." });
  const key = crypto.randomBytes(6).toString("hex"); // 관리자 비밀키
  fs.writeFileSync(path.join(EVENTS_DIR, `${code}.json`), JSON.stringify({ code, title, presenterEmail, adminKey: key }, null, 2));
  lastNew.set(ip, Date.now());
  res.json({ code, key });
});

// --- 발표자 매직링크 로그인 ---
// 이메일로 1회용 링크를 보내고, 그 링크로 들어와야 본인 이벤트 목록(관리자 링크)을 볼 수 있다.
const MAGIC_TTL_MS = 15 * 60 * 1000;
const magicTokens = new Map(); // token -> { email, exp, used }
const lastLogin = new Map(); // ip -> ts

function eventsForEmail(email) {
  return fs.readdirSync(EVENTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(EVENTS_DIR, f), "utf8")); } catch { return null; } })
    .filter((m) => m && String(m.presenterEmail || "").toLowerCase() === email)
    .map((m) => ({
      code: m.code,
      title: m.title,
      polls: (m.polls || []).length,
      accessUrl: `/admin/${encodeURIComponent(m.code)}?key=${encodeURIComponent(m.adminKey)}`,
    }));
}

function baseUrl(req) {
  return `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`;
}

async function sendMagicLink(to, link) {
  const user = process.env.GMAIL_ADDRESS;
  const pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s/g, "");
  if (!user || !pass) throw new Error("mail not configured");
  const { default: nodemailer } = await import("nodemailer");
  const tx = nodemailer.createTransport({
    host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass },
  });
  await tx.sendMail({
    from: `QR Poll <${user}>`,
    to,
    subject: "QR Poll — your presenter sign-in link",
    text: `Open your presenter console (valid 15 minutes, one-time):\n\n${link}\n\nIf you didn't request this, ignore this email.`,
    html: `<p>Open your presenter console — valid for 15 minutes, one-time use.</p>
<p><a href="${link}" style="display:inline-block;padding:11px 18px;background:#e0442e;color:#fff;border-radius:10px;text-decoration:none;font-weight:700">Open presenter console</a></p>
<p style="color:#888;font-size:12px">If you didn't request this, ignore this email.</p>`,
  });
}

app.post("/presenter/login", async (req, res) => {
  const ip = req.headers["cf-connecting-ip"] || req.ip;
  if (Date.now() - (lastLogin.get(ip) || 0) < 3000)
    return res.status(429).json({ error: "Please try again in a moment." });
  lastLogin.set(ip, Date.now());
  const email = String(req.body?.presenterEmail || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Please enter a valid presenter email." });
  // 이벤트가 없어도 동일하게 응답한다 (계정 존재 여부를 노출하지 않음)
  if (eventsForEmail(email).length) {
    const token = crypto.randomBytes(24).toString("hex");
    magicTokens.set(token, { email, exp: Date.now() + MAGIC_TTL_MS, used: false });
    try {
      await sendMagicLink(email, `${baseUrl(req)}/presenter/verify?token=${token}`);
    } catch (e) {
      magicTokens.delete(token);
      console.error("magic link send failed:", e.message);
      return res.status(500).json({ error: "Could not send the email. Try again later." });
    }
  }
  res.json({ ok: true });
});

app.get("/presenter/verify", (req, res) => {
  const token = String(req.query.token || "");
  const rec = magicTokens.get(token);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const page = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>QR Poll · Presenter</title><link rel="stylesheet" href="/style.css?v=12" /></head>
<body><div class="center"><div class="card">${body}</div></div></body></html>`;
  if (!rec || rec.used || rec.exp < Date.now()) {
    magicTokens.delete(token);
    return res.status(400).send(page(`<h1>Link expired</h1><p class="hint-sm">This sign-in link is invalid, already used, or older than 15 minutes.</p><p><a href="/">← Back to QR Poll</a></p>`));
  }
  rec.used = true;
  magicTokens.delete(token);
  const events = eventsForEmail(rec.email);
  const list = events.map((e) => `<a class="session" href="${esc(e.accessUrl)}"><b>${esc(e.title || "(untitled)")}</b><span>code ${esc(e.code)} · ${e.polls} poll${e.polls === 1 ? "" : "s"}</span></a>`).join("");
  res.send(page(`<h1>💬 QR Poll</h1>
<p class="count">🔐 Signed in as <b>${esc(rec.email)}</b></p>
<div class="sessions">${list || "<p class='hint-sm'>No events found.</p>"}</div>
<p class="hint-sm">Bookmark a console link to get back without email next time.</p>`));
});

// 관리자 키 검증 (query.key 또는 body.key)
function keyOk(meta, req) {
  const k = req.query.key || req.body?.key;
  return !!meta.adminKey && k === meta.adminKey;
}

app.get("/r/:code", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "join.html"))
);
app.get("/r/:code/chat", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "join.html"))
);
app.get("/present/:code", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "present.html"))
);
app.get("/admin/:code", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "admin.html"))
);

// 이벤트 메타 + 최근 메시지 + poll 집계 + stage (초기 로드용)
app.get("/api/:code", (req, res) => {
  const meta = eventMeta(req.params.code);
  if (!meta) return res.status(404).json({ error: "unknown event code" });
  const normalized = normalizeMeta(meta);
  const { adminKey, presenterEmail, ...pub } = normalized; // private access fields are never exposed
  const polls = normalized.polls.map((p) => ({ ...p, counts: p.type === "choice" ? pollCounts(req.params.code, p) : undefined }));
  const messages = visibleMessages(req.params.code);
  const currentStage = room(req.params.code).stage;
  // qa: Chat Room 채널 메타(제목/정렬)만. 메시지는 messages에 이미 있어 중복 전송 안 함.
  res.json({ ...pub, polls, qa: { id: QA_ID, q: "Chat Room", sort: normalized.qaSort }, messages, stage: currentStage });
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
  const meta = normalizeMeta(eventMeta(req.params.code));
  const pollId = (req.body?.pollId || QA_ID).toString();
  if (pollId !== QA_ID) {
    const poll = meta.polls.find((p) => p.id === pollId);
    if (!poll || poll.type !== "text") return res.status(400).json({ error: "bad text poll" });
  }
  lastPost.set(ip, now);
  res.json(addMessage(req.params.code, text, pollId));
});

// 익명 리액션 (👍) — 계정 없으니 탭 카운터, Slido "반응"과 동일
app.post("/react/:code/:id", (req, res) => {
  if (!eventMeta(req.params.code))
    return res.status(404).json({ error: "unknown event code" });
  const token = String(req.body?.token || "").slice(0, 128);
  const n = addReaction(req.params.code, Number(req.params.id), token);
  if (n === null) return res.status(404).json({ error: "no such message" });
  res.json({ id: Number(req.params.id), reactions: n });
});

// 익명 투표 (객관식 poll)
app.post("/vote/:code/:poll/:opt", (req, res) => {
  const meta = eventMeta(req.params.code);
  if (!meta) return res.status(404).json({ error: "unknown event code" });
  const poll = (meta.polls || []).find((p) => p.id === req.params.poll);
  if (!poll) return res.status(404).json({ error: "no such poll" });
  const token = String(req.body?.token || "").slice(0, 128);
  const counts = req.body?.undo
    ? removeVote(req.params.code, poll, token)
    : addVote(req.params.code, poll, Number(req.params.opt), token);
  if (counts === null) return res.status(400).json({ error: "bad option" });
  res.json({ poll: poll.id, counts });
});

// --- 관리자 전용 (adminKey 필요) ---
app.get("/admin/:code/messages", (req, res) => {
  const meta = eventMeta(req.params.code);
  if (!meta) return res.status(404).json({ error: "unknown event code" });
  if (!keyOk(meta, req)) return res.status(403).json({ error: "An admin key is required." });
  // key로 보호되므로 export용 전체 메타(presenterEmail 등)까지 포함
  res.json({ messages: room(req.params.code).messages, meta: normalizeMeta(meta) });
});

app.post("/admin/:code/archive/:id", (req, res) => {
  const meta = eventMeta(req.params.code);
  if (!meta) return res.status(404).json({ error: "unknown event code" });
  if (!keyOk(meta, req)) return res.status(403).json({ error: "An admin key is required." });
  const ok = delMessage(req.params.code, Number(req.params.id));
  res.json({ ok });
});

app.post("/admin/:code/restore/:id", (req, res) => {
  const meta = eventMeta(req.params.code);
  if (!meta) return res.status(404).json({ error: "unknown event code" });
  if (!keyOk(meta, req)) return res.status(403).json({ error: "An admin key is required." });
  const ok = restoreMessage(req.params.code, Number(req.params.id));
  res.json({ ok });
});

app.post("/admin/:code/pin/:id", (req, res) => {
  const meta = eventMeta(req.params.code);
  if (!meta) return res.status(404).json({ error: "unknown event code" });
  if (!keyOk(meta, req)) return res.status(403).json({ error: "An admin key is required." });
  const ok = pinMessage(req.params.code, Number(req.params.id), req.body?.on);
  res.json({ ok });
});

app.post("/admin/:code/stage", (req, res) => {
  const meta = eventMeta(req.params.code);
  if (!meta) return res.status(404).json({ error: "unknown event code" });
  if (!keyOk(meta, req)) return res.status(403).json({ error: "An admin key is required." });
  const focus = (req.body?.focus ?? QA_ID).toString();
  const sort = req.body?.sort === "top" ? "top" : "recent";
  if (focus !== QA_ID && !(meta.polls || []).some((p) => p.id === focus))
    return res.status(400).json({ error: "bad focus" });
  res.json(setStage(req.params.code, focus, sort));
});

function validPollInput(body, existingId = null) {
  const type = body?.type === "text" ? "text" : "choice";
  const id = String(existingId || body?.id || "").trim();
  const q = String(body?.q || "").trim().slice(0, MAX_POLL_TITLE);
  if ((existingId && (!/^[a-z0-9][a-z0-9_-]{1,80}$/i.test(id) || id === QA_ID)) || !q) return null;
  const options = type === "choice"
    ? (Array.isArray(body.options) ? body.options : []).map((x) => String(x).trim().slice(0, MAX_OPTION_LEN)).filter(Boolean).slice(0, MAX_OPTIONS)
    : [];
  if (type === "choice" && options.length < 2) return null;
  return { id, type, q, options, sort: body.sort === "top" ? "top" : "recent" };
}

function adminMeta(req, res) {
  const meta = eventMeta(req.params.code);
  if (!meta) { res.status(404).json({ error: "unknown event code" }); return null; }
  if (!keyOk(meta, req)) { res.status(403).json({ error: "An admin key is required." }); return null; }
  return normalizeMeta(meta);
}

app.post("/admin/:code/poll/create", (req, res) => {
  const meta = adminMeta(req, res); if (!meta) return;
  const poll = validPollInput(req.body);
  if (!poll) return res.status(400).json({ error: "bad poll" });
  poll.id = `poll-${Date.now()}-${crypto.randomInt(1000, 10000)}`;
  meta.polls.push({ ...poll, order: meta.polls.length });
  saveMeta(req.params.code, meta);
  broadcast(req.params.code, { kind: "polls", polls: pollsPayload(req.params.code, meta) });
  res.json({ ok: true, poll });
});

app.post("/admin/:code/poll/:id/update", (req, res) => {
  const meta = adminMeta(req, res); if (!meta) return;
  const i = meta.polls.findIndex((p) => p.id === req.params.id);
  const poll = validPollInput(req.body, req.params.id);
  if (i < 0 || !poll || (poll.id !== req.params.id && meta.polls.some((p) => p.id === poll.id))) return res.status(400).json({ error: "bad poll" });
  meta.polls[i] = { ...meta.polls[i], ...poll };
  saveMeta(req.params.code, meta);
  broadcast(req.params.code, { kind: "polls", polls: pollsPayload(req.params.code, meta) });
  res.json({ ok: true, poll: meta.polls[i] });
});

app.post("/admin/:code/poll/:id/delete", (req, res) => {
  const meta = adminMeta(req, res); if (!meta) return;
  const i = meta.polls.findIndex((p) => p.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: "no such poll" });
  meta.polls.splice(i, 1);
  if (room(req.params.code).stage.focus === req.params.id) setStage(req.params.code, QA_ID, meta.qaSort);
  saveMeta(req.params.code, meta);
  broadcast(req.params.code, { kind: "polls", polls: pollsPayload(req.params.code, meta) });
  res.json({ ok: true });
});

app.post("/admin/:code/poll/:id/move/:direction", (req, res) => {
  const meta = adminMeta(req, res); if (!meta) return;
  const i = meta.polls.findIndex((p) => p.id === req.params.id);
  const d = req.params.direction === "up" ? -1 : req.params.direction === "down" ? 1 : 0;
  const j = i + d;
  if (i < 0 || !d || j < 0 || j >= meta.polls.length) return res.status(400).json({ error: "cannot move poll" });
  [meta.polls[i], meta.polls[j]] = [meta.polls[j], meta.polls[i]];
  saveMeta(req.params.code, meta);
  broadcast(req.params.code, { kind: "polls", polls: pollsPayload(req.params.code, meta) });
  res.json({ ok: true, polls: normalizeMeta(meta).polls });
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
  console.assert(addReaction(code, 1, "device-1") === 3, "first device reaction");
  console.assert(addReaction(code, 1, "device-1") === 3, "duplicate device reaction ignored");
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
  console.assert(reloaded.byId.get(1).reactions === 3, "reactions persist across reload");
  console.assert(JSON.stringify(pollCounts(code, poll)) === "[1,0,2]", "votes persist across reload");
  // 삭제/고정/stage
  addMessage(code, "삭제될 메시지");
  console.assert(visibleMessages(code).length === 3, "3 visible before delete");
  delMessage(code, 3);
  console.assert(visibleMessages(code).length === 2, "hidden after delete");
  pinMessage(code, 1, true);
  console.assert(room(code).byId.get(1).pinned === true, "pinned");
  rooms.delete(code);
  const r2 = room(code);
  console.assert(visibleMessages(code).length === 2, "delete persists across reload");
  console.assert(r2.byId.get(1).pinned === true, "pin persists across reload");
  console.assert(setStage(code, QA_ID, "top").sort === "top", "stage set");

  const nc = newCode();
  console.assert(/^\d{7}$/.test(nc) && !eventMeta(nc), "newCode: 7-digit, unused");
  console.assert(typeof eventCount() === "number", "eventCount");
  const cleanTitle = "  ".concat("x".repeat(200)).trim().slice(0, MAX_TITLE);
  console.assert(cleanTitle.length === MAX_TITLE, "title clamped to MAX_TITLE");
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
  app.listen(PORT, () => console.log(`qr-poll on :${PORT}`));
}
