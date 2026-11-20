// Online rooms for Tune In. One serverless function, state kept in Redis (Upstash REST API).
// GET  /api/room?code=ABCD&pid=...   -> the room as that player may see it
// POST /api/room {action, pid, ...}  -> perform an action, returns the updated view
const CARDS = require("../cards.js");

const TTL = 60 * 60 * 24;            // rooms expire after a day of inactivity
const BAND = 7;                      // must match the page's scoring bands
const ROUND_OPTIONS = [6, 8, 10, 12, 16];
// Vercel's Upstash integration names these KV_REST_API_*, optionally with a custom prefix (e.g. TUNE_IN_).
const env = suffix => process.env[Object.keys(process.env).find(k => k === suffix || k.endsWith("_" + suffix)) || ""];
const DB_URL = env("KV_REST_API_URL") || env("UPSTASH_REDIS_REST_URL");
const DB_TOKEN = env("KV_REST_API_TOKEN") || env("UPSTASH_REDIS_REST_TOKEN");

// ---------- storage ----------
const mem = new Map(); // only used for local testing (TUNE_IN_DEV=1)
async function redis(cmd) {
  if (!DB_URL) {
    if (process.env.TUNE_IN_DEV) {
      const [op, key, val, ...opts] = cmd;
      if (op === "GET") return mem.has(key) ? mem.get(key) : null;
      if (op === "SET") {
        if (opts.includes("NX") && mem.has(key)) return null;
        mem.set(key, val); return "OK";
      }
    }
    throw httpError(503, "The game database isn't connected yet. Connect an Upstash Redis store to this Vercel project.");
  }
  const r = await fetch(DB_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${DB_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error("Database error: " + j.error);
  return j.result;
}
const roomKey = code => `tunein:room:${code}`;
async function load(code) {
  code = String(code || "").toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) throw httpError(400, "Room codes are 4 letters.");
  const raw = await redis(["GET", roomKey(code)]);
  if (!raw) throw httpError(404, `There's no room ${code}. It may have expired, so check the code or create a new room.`);
  return JSON.parse(raw);
}
async function save(room) {
  room.v++;
  await redis(["SET", roomKey(room.code), JSON.stringify(room), "EX", TTL]);
}
// Lets exactly one of two simultaneous clicks win (e.g. both players pressing "Next round").
const claim = key => redis(["SET", `tunein:once:${key}`, "1", "NX", "EX", 120]).then(r => r === "OK");

// ---------- game rules ----------
function httpError(status, message) { return Object.assign(new Error(message), { status }); }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function score(target, guess) {
  const d = Math.abs(target - guess);
  return d <= BAND / 2 ? 4 : d <= BAND * 1.5 ? 3 : d <= BAND * 2.5 ? 2 : 0;
}
function shuffledDeck() {
  const a = CARDS.map((_, i) => i);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function drawCard(room) {
  if (!room.deck.length) room.deck = shuffledDeck();
  room.card = CARDS[room.deck.pop()];
}
function startRound(room) {
  drawCard(room);
  room.target = 8 + Math.random() * 164;
  room.clue = "";
  room.guess = 90;
  room.phase = "clue";
}
const cleanName = n => String(n || "").trim().slice(0, 20);
const seat = (room, pid) => room.players.findIndex(p => p.pid === pid);
const psychicSeat = room => room.round % 2;

function view(room, pid) {
  const you = seat(room, pid);
  const psy = psychicSeat(room);
  const canSeeTarget = room.phase === "reveal" || room.phase === "end" ||
    (you === psy && (room.phase === "clue" || room.phase === "guess"));
  return {
    code: room.code, v: room.v, game: room.game, phase: room.phase,
    round: room.round, rounds: room.rounds,
    players: room.players.map(p => p.name), you, psychic: psy,
    card: room.card, clue: room.clue, guess: room.guess,
    target: canSeeTarget ? room.target : null,
    history: room.history,
  };
}

async function act(b) {
  const pid = String(b.pid || "");
  if (pid.length < 8 || pid.length > 64) throw httpError(400, "Missing player id. Reload the page and try again.");

  if (b.action === "create") {
    const name = cleanName(b.name) || "Player 1";
    const rounds = ROUND_OPTIONS.includes(+b.rounds) ? +b.rounds : 10;
    const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O, they look like 1 and 0
    for (let tries = 0; tries < 20; tries++) {
      const code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
      const room = { code, v: 1, game: 1, rounds, round: 0, phase: "lobby", players: [{ pid, name }],
        deck: [], card: null, target: null, clue: "", guess: 90, history: [] };
      const ok = await redis(["SET", roomKey(code), JSON.stringify(room), "NX", "EX", TTL]);
      if (ok === "OK") return view(room, pid);
    }
    throw httpError(503, "Couldn't find a free room code. Try again.");
  }

  const room = await load(b.code);
  const you = seat(room, pid);

  if (b.action === "join") {
    if (you >= 0) return view(room, pid);              // already in: just rejoin
    if (room.players.length >= 2) throw httpError(409, "This room already has two players.");
    room.players.push({ pid, name: cleanName(b.name) || "Player 2" });
    startRound(room);
    await save(room);
    return view(room, pid);
  }

  if (you < 0) throw httpError(403, "You're not a player in this room.");
  const isPsychic = you === psychicSeat(room);

  switch (b.action) {
    case "reroll":
      if (room.phase !== "clue" || !isPsychic) throw httpError(409, "Only the clue-giver can change the spectrum, before giving a clue.");
      drawCard(room);
      break;
    case "clue":
      if (room.phase !== "clue" || !isPsychic) throw httpError(409, "It's not your turn to give a clue.");
      room.clue = String(b.clue || "").trim().slice(0, 60);
      room.phase = "guess";
      break;
    case "move":
      if (room.phase !== "guess" || isPsychic) return view(room, pid); // stale drag after lock-in: ignore quietly
      room.guess = clamp(+b.guess || 0, 0, 180);
      break;
    case "lock": {
      if (room.phase !== "guess" || isPsychic) throw httpError(409, "It's not your turn to guess.");
      room.guess = clamp(+b.guess || 0, 0, 180);
      const points = score(room.target, room.guess);
      room.history.push({ psychic: psychicSeat(room), card: room.card, clue: room.clue,
        target: room.target, guess: room.guess, points });
      room.phase = "reveal";
      break;
    }
    case "next":
      if (room.phase !== "reveal" || +b.round !== room.round) return view(room, pid); // the other player already moved on
      if (!(await claim(`${room.code}:${room.game}:next:${room.round}`))) return view(await load(room.code), pid);
      room.round++;
      if (room.round >= room.rounds) room.phase = "end"; else startRound(room);
      break;
    case "again":
      if (room.phase !== "end" || +b.game !== room.game) return view(room, pid);
      if (!(await claim(`${room.code}:again:${room.game}`))) return view(await load(room.code), pid);
      room.game++; room.round = 0; room.history = [];
      startRound(room);
      break;
    default:
      throw httpError(400, "Unknown action.");
  }
  await save(room);
  return view(room, pid);
}

// ---------- HTTP ----------
module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  try {
    let out;
    if (req.method === "GET") {
      const q = new URL(req.url, "http://localhost").searchParams;
      out = view(await load(q.get("code")), q.get("pid") || "");
    } else if (req.method === "POST") {
      const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      out = await act(b);
    } else {
      throw httpError(405, "Use GET or POST.");
    }
    res.statusCode = 200;
    res.end(JSON.stringify(out));
  } catch (e) {
    res.statusCode = e.status || 500;
    res.end(JSON.stringify({ error: e.status ? e.message : "Something went wrong on the server: " + e.message }));
  }
};
