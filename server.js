"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PUBLIC_DIR = path.join(__dirname, "public");
const PAGE_SIZE = 12;
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ---------- database ---------- */

function openDatabase(dbPath) {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS trips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      destination TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      transport TEXT NOT NULL DEFAULT '',
      lodging TEXT NOT NULL DEFAULT '',
      tips TEXT NOT NULL DEFAULT '',
      days_json TEXT NOT NULL DEFAULT '[]',
      budget_json TEXT NOT NULL DEFAULT '[]',
      edit_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER REFERENCES trips(id) ON DELETE CASCADE,
      mime TEXT NOT NULL,
      data BLOB NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_photos_trip ON photos(trip_id);
    CREATE INDEX IF NOT EXISTS idx_trips_created ON trips(created_at, id);
  `);
  // Later schema changes: add guarded ALTER TABLE steps keyed on user_version.
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version < 1) db.exec("PRAGMA user_version = 1");
  return db;
}

/* ---------- validation ---------- */

function str(body, key, max, required) {
  let v = body[key];
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") throw new HttpError(400, `${key} must be a string`);
  v = v.trim();
  if (required && !v) throw new HttpError(400, `${key} is required`);
  if (v.length > max) throw new HttpError(400, `${key} is too long (max ${max})`);
  return v;
}

function isObj(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function validateTrip(body) {
  if (!isObj(body)) throw new HttpError(400, "body must be a JSON object");
  const trip = {
    title: str(body, "title", 100, true),
    destination: str(body, "destination", 100),
    author: str(body, "author", 50),
    summary: str(body, "summary", 1000),
    transport: str(body, "transport", 2000),
    lodging: str(body, "lodging", 2000),
    tips: str(body, "tips", 5000),
  };

  const days = body.days === undefined || body.days === null ? [] : body.days;
  if (!Array.isArray(days)) throw new HttpError(400, "days must be an array");
  if (days.length > 60) throw new HttpError(400, "at most 60 days");
  trip.days = days.map((d) => {
    if (!isObj(d)) throw new HttpError(400, "each day must be an object");
    const spots = d.spots === undefined || d.spots === null ? [] : d.spots;
    if (!Array.isArray(spots)) throw new HttpError(400, "spots must be an array");
    if (spots.length > 30) throw new HttpError(400, "at most 30 spots per day");
    return {
      title: str(d, "title", 100),
      spots: spots.map((s) => {
        if (!isObj(s)) throw new HttpError(400, "each spot must be an object");
        return { name: str(s, "name", 100), note: str(s, "note", 500) };
      }),
    };
  });

  const budget = body.budget === undefined || body.budget === null ? [] : body.budget;
  if (!Array.isArray(budget)) throw new HttpError(400, "budget must be an array");
  if (budget.length > 50) throw new HttpError(400, "at most 50 budget lines");
  trip.budget = budget.map((b) => {
    if (!isObj(b)) throw new HttpError(400, "each budget line must be an object");
    const amount = b.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 1e9) {
      throw new HttpError(400, "amount must be a non-negative number");
    }
    return { label: str(b, "label", 50), amount };
  });

  const ids = body.photoIds === undefined || body.photoIds === null ? [] : body.photoIds;
  if (!Array.isArray(ids)) throw new HttpError(400, "photoIds must be an array");
  if (ids.length > 20) throw new HttpError(400, "at most 20 photos");
  if (!ids.every((i) => Number.isInteger(i) && i > 0)) {
    throw new HttpError(400, "photoIds must be positive integers");
  }
  trip.photoIds = [...new Set(ids)];
  return trip;
}

/* ---------- sample data ---------- */

const SAMPLE_TRIPS = [
  {
    title: "京都三日慢游：古寺、抹茶与枫叶小径",
    destination: "日本·京都",
    author: "小满",
    summary: "不赶行程的三天，把清水寺、伏见稻荷和岚山慢慢走完，傍晚在鸭川边吃一份团子。",
    transport: "关西机场乘 JR 特急 HARUKA 直达京都站约 80 分钟；市内以公交一日券和步行为主，岚山段搭嵯峨野线。",
    lodging: "住在京都站附近的商务酒店，出行方便；第二晚体验了一次河原町的町家民宿。",
    tips: "清水寺和伏见稻荷尽量早上 8 点前到，人少光线好；寺院多在 17 点前关门；随身带现金，小店常不支持刷卡。",
    days: [
      { title: "第一天 东山古寺巡礼", spots: [
        { name: "清水寺", note: "早起避开人潮，舞台上看京都全景" },
        { name: "二年坂·三年坂", note: "沿途买抹茶冰淇淋和八桥" },
        { name: "八坂神社", note: "傍晚点灯后很有氛围" },
        { name: "祇园花见小路", note: "运气好能遇见艺伎" } ] },
      { title: "第二天 千本鸟居与锦市场", spots: [
        { name: "伏见稻荷大社", note: "爬到四辻看风景，来回约 2 小时" },
        { name: "锦市场", note: "边走边吃，玉子烧和豆乳甜甜圈推荐" },
        { name: "鸭川河畔", note: "坐在河边发呆看夕阳" } ] },
      { title: "第三天 岚山竹林漫步", spots: [
        { name: "竹林小径", note: "清晨最安静" },
        { name: "天龙寺", note: "庭院是世界遗产，值得进去坐坐" },
        { name: "渡月桥", note: "桥边咖啡馆适合歇脚" },
        { name: "嵯峨野小火车", note: "秋天沿线红叶很美，需提前订票" } ] },
    ],
    budget: [
      { label: "往返机票", amount: 3200 },
      { label: "住宿（3 晚）", amount: 2400 },
      { label: "餐饮", amount: 1500 },
      { label: "市内交通", amount: 300 },
      { label: "门票与体验", amount: 400 },
    ],
  },
  {
    title: "成都四天吃货之旅：火锅、串串与茶馆",
    destination: "中国·成都",
    author: "阿辣",
    summary: "四天吃遍成都：早上盖碗茶，中午担担面，晚上火锅串串，中间顺路看看熊猫。",
    transport: "双流机场坐地铁 10 号线转 1 号线进市区；市内以地铁和打车为主，景点之间距离不远。",
    lodging: "住在春熙路/太古里附近，夜宵方便；预算有限可选宽窄巷子周边的青旅。",
    tips: "不能吃辣可以点鸳鸯锅或微辣；熊猫基地要早上去，熊猫上午最活跃；热门火锅店提前线上取号。",
    days: [
      { title: "第一天 市井烟火", spots: [
        { name: "宽窄巷子", note: "逛逛小院，尝三大炮和糖油果子" },
        { name: "人民公园鹤鸣茶社", note: "点一杯盖碗茶，体验掏耳朵" },
        { name: "小龙坎火锅", note: "牛油锅底配毛肚和鸭肠" } ] },
      { title: "第二天 看熊猫与吃面", spots: [
        { name: "成都大熊猫繁育研究基地", note: "早上 8 点入园，看熊猫吃竹子" },
        { name: "陈麻婆豆腐", note: "地道麻辣鲜香" },
        { name: "九眼桥酒吧街", note: "夜晚河边散步" } ] },
      { title: "第三天 古镇一日", spots: [
        { name: "洛带古镇", note: "客家文化，尝伤心凉粉" },
        { name: "锦里", note: "晚上灯笼亮起，拍照很出片" },
        { name: "钢管厂五区小郡肝串串", note: "签子数着吃，口味很过瘾" } ] },
      { title: "第四天 慢节奏收尾", spots: [
        { name: "杜甫草堂", note: "安静的园林，适合散步" },
        { name: "太古里", note: "买点伴手礼，喝杯咖啡" },
        { name: "蜀九香火锅", note: "最后一顿，送别成都" } ] },
    ],
    budget: [
      { label: "往返交通", amount: 1800 },
      { label: "住宿（4 晚）", amount: 1400 },
      { label: "餐饮", amount: 1600 },
      { label: "门票", amount: 250 },
      { label: "市内交通", amount: 200 },
    ],
  },
  {
    title: "杭州西湖两日：断桥、龙井与湖畔夜色",
    destination: "中国·杭州",
    author: "阿宁",
    summary: "周末说走就走的两天，环湖骑行、茶山喝茶，把西湖的晨昏都看了一遍。",
    transport: "高铁到杭州东站后换乘地铁 1 号线至龙翔桥；环湖可借助公共自行车和步行，苏堤段建议骑行。",
    lodging: "住在湖滨商圈的酒店，走几分钟就到湖边；旺季周末房价偏高，建议提前预订。",
    tips: "周末和节假日断桥人很多，建议早起；春秋两季最舒服；雷峰塔看日落要提前占位；龙井村茶价差异大，先试喝再买。",
    days: [
      { title: "第一天 西湖经典环线", spots: [
        { name: "断桥残雪", note: "从断桥出发沿白堤走" },
        { name: "平湖秋月", note: "湖边长椅坐坐，拍湖景" },
        { name: "苏堤春晓", note: "租自行车骑完全程，约 1 小时" },
        { name: "雷峰塔", note: "傍晚登塔看日落" } ] },
      { title: "第二天 茶山与灵隐", spots: [
        { name: "灵隐寺", note: "上午去，空气清幽" },
        { name: "龙井村", note: "在茶园里喝一杯明前龙井" },
        { name: "河坊街", note: "尝定胜糕和片儿川，买点伴手礼" } ] },
    ],
    budget: [
      { label: "往返高铁", amount: 600 },
      { label: "住宿（1 晚）", amount: 700 },
      { label: "餐饮", amount: 500 },
      { label: "门票与茶", amount: 300 },
    ],
  },
];

function seedSamples(db) {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM trips").get();
  if (n > 0) return;
  const ins = db.prepare(
    `INSERT INTO trips (title, destination, author, summary, transport, lodging, tips,
       days_json, budget_json, edit_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const base = Date.now();
  db.exec("BEGIN");
  try {
    SAMPLE_TRIPS.forEach((t, i) => {
      const ts = new Date(base - (SAMPLE_TRIPS.length - i) * 1000).toISOString();
      ins.run(
        t.title, t.destination, t.author, t.summary, t.transport, t.lodging, t.tips,
        JSON.stringify(t.days), JSON.stringify(t.budget),
        crypto.randomBytes(16).toString("hex"), ts, ts
      );
    });
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/* ---------- http helpers ---------- */

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, "request body too large"));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (c) => {
      if (failed) return;
      size += c.length;
      if (size > limit) {
        failed = true;
        chunks.length = 0;
        reject(new HttpError(413, "request body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on("error", (e) => { if (!failed) { failed = true; reject(e); } });
  });
}

async function readJson(req) {
  const buf = await readBody(req, MAX_JSON_BYTES);
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

function parseId(s) {
  if (!/^\d{1,15}$/.test(s)) throw new HttpError(404, "not found");
  return Number(s);
}

function keyMatches(stored, given) {
  if (typeof given !== "string" || !given) return false;
  const a = crypto.createHash("sha256").update(stored).digest();
  const b = crypto.createHash("sha256").update(given).digest();
  return crypto.timingSafeEqual(a, b);
}

/* ---------- server ---------- */

function createServer(dbPath) {
  const db = openDatabase(dbPath);
  seedSamples(db);

  const q = {
    insertTrip: db.prepare(
      `INSERT INTO trips (title, destination, author, summary, transport, lodging, tips,
         days_json, budget_json, edit_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    updateTrip: db.prepare(
      `UPDATE trips SET title = ?, destination = ?, author = ?, summary = ?, transport = ?,
         lodging = ?, tips = ?, days_json = ?, budget_json = ?, updated_at = ? WHERE id = ?`
    ),
    getTrip: db.prepare("SELECT * FROM trips WHERE id = ?"),
    deleteTrip: db.prepare("DELETE FROM trips WHERE id = ?"),
    tripPhotoIds: db.prepare("SELECT id FROM photos WHERE trip_id = ? ORDER BY id"),
    detachPhotos: db.prepare("UPDATE photos SET trip_id = NULL WHERE trip_id = ?"),
    attachPhoto: db.prepare(
      "UPDATE photos SET trip_id = ? WHERE id = ? AND (trip_id IS NULL OR trip_id = ?)"
    ),
    deleteTripPhotos: db.prepare("DELETE FROM photos WHERE trip_id = ?"),
    insertPhoto: db.prepare("INSERT INTO photos (trip_id, mime, data, created_at) VALUES (NULL, ?, ?, ?)"),
    getPhoto: db.prepare("SELECT mime, data FROM photos WHERE id = ?"),
    list: db.prepare(
      `SELECT t.id, t.title, t.destination, t.author, t.summary, t.days_json, t.budget_json,
         t.created_at, (SELECT MIN(p.id) FROM photos p WHERE p.trip_id = t.id) AS cover
       FROM trips t
       WHERE (? = '' OR t.title LIKE ? ESCAPE '\\' OR t.destination LIKE ? ESCAPE '\\'
              OR t.author LIKE ? ESCAPE '\\')
       ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`
    ),
  };

  function fullTrip(row) {
    return {
      id: row.id,
      title: row.title,
      destination: row.destination,
      author: row.author,
      summary: row.summary,
      transport: row.transport,
      lodging: row.lodging,
      tips: row.tips,
      days: JSON.parse(row.days_json),
      budget: JSON.parse(row.budget_json),
      photoIds: q.tripPhotoIds.all(row.id).map((r) => Number(r.id)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function attachPhotos(tripId, photoIds) {
    q.detachPhotos.run(tripId);
    for (const pid of photoIds) {
      const r = q.attachPhoto.run(tripId, pid, tripId);
      if (r.changes !== 1) throw new HttpError(400, `photo ${pid} not found or already used`);
    }
  }

  function tx(fn) {
    db.exec("BEGIN");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  function listTrips(url) {
    const search = (url.searchParams.get("q") || "").trim().slice(0, 100);
    let page = parseInt(url.searchParams.get("page") || "1", 10);
    if (!Number.isFinite(page) || page < 1) page = 1;
    const like = "%" + search.replace(/[\\%_]/g, "\\$&") + "%";
    const rows = q.list.all(search, like, like, like, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE);
    const trips = rows.slice(0, PAGE_SIZE).map((r) => {
      const budget = JSON.parse(r.budget_json);
      return {
        id: r.id,
        title: r.title,
        destination: r.destination,
        author: r.author,
        summary: r.summary,
        dayCount: JSON.parse(r.days_json).length,
        budgetTotal: budget.reduce((s, b) => s + b.amount, 0),
        coverPhotoId: r.cover === null ? null : Number(r.cover),
        createdAt: r.created_at,
      };
    });
    return { trips, page, hasMore: rows.length > PAGE_SIZE };
  }

  function requireTrip(id) {
    const row = q.getTrip.get(id);
    if (!row) throw new HttpError(404, "trip not found");
    return row;
  }

  async function handleApi(req, res, url) {
    const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
    const method = req.method;
    const resource = parts[1];

    if (resource === "trips" && parts.length === 2) {
      if (method === "GET") return sendJson(res, 200, listTrips(url));
      if (method === "POST") {
        const t = validateTrip(await readJson(req));
        const key = crypto.randomBytes(16).toString("hex");
        const now = new Date().toISOString();
        const id = tx(() => {
          const r = q.insertTrip.run(
            t.title, t.destination, t.author, t.summary, t.transport, t.lodging, t.tips,
            JSON.stringify(t.days), JSON.stringify(t.budget), key, now, now
          );
          const tid = Number(r.lastInsertRowid);
          attachPhotos(tid, t.photoIds);
          return tid;
        });
        return sendJson(res, 201, { ...fullTrip(q.getTrip.get(id)), editKey: key });
      }
      throw new HttpError(405, "method not allowed");
    }

    if (resource === "trips" && parts.length === 3) {
      const id = parseId(parts[2]);
      if (method === "GET") return sendJson(res, 200, fullTrip(requireTrip(id)));
      if (method === "PUT" || method === "DELETE") {
        const row = requireTrip(id);
        if (!keyMatches(row.edit_key, req.headers["x-edit-key"])) {
          req.resume();
          throw new HttpError(403, "wrong edit key");
        }
        if (method === "DELETE") {
          tx(() => {
            q.deleteTripPhotos.run(id);
            q.deleteTrip.run(id);
          });
          return sendJson(res, 200, { ok: true });
        }
        const t = validateTrip(await readJson(req));
        tx(() => {
          q.updateTrip.run(
            t.title, t.destination, t.author, t.summary, t.transport, t.lodging, t.tips,
            JSON.stringify(t.days), JSON.stringify(t.budget), new Date().toISOString(), id
          );
          attachPhotos(id, t.photoIds);
        });
        return sendJson(res, 200, fullTrip(q.getTrip.get(id)));
      }
      throw new HttpError(405, "method not allowed");
    }

    if (resource === "photos" && parts.length === 2 && method === "POST") {
      const mime = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (!PHOTO_TYPES.includes(mime)) {
        req.resume();
        throw new HttpError(400, "Content-Type must be image/jpeg, image/png or image/webp");
      }
      const data = await readBody(req, MAX_PHOTO_BYTES);
      if (data.length === 0) throw new HttpError(400, "empty body");
      const r = q.insertPhoto.run(mime, data, new Date().toISOString());
      return sendJson(res, 201, { id: Number(r.lastInsertRowid) });
    }

    if (resource === "photos" && parts.length === 3 && method === "GET") {
      const row = q.getPhoto.get(parseId(parts[2]));
      if (!row) throw new HttpError(404, "photo not found");
      const data = Buffer.from(row.data);
      res.writeHead(200, {
        "Content-Type": row.mime,
        "Content-Length": data.length,
        "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      });
      return res.end(data);
    }

    throw new HttpError(404, "not found");
  }

  function serveStatic(req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(404, "not found");
    }
    if (rel.includes("\0")) throw new HttpError(404, "not found");
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(PUBLIC_DIR, rel);
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
      throw new HttpError(404, "not found");
    }
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      throw new HttpError(404, "not found");
    }
    if (!st.isFile()) throw new HttpError(404, "not found");
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": st.size,
    });
    if (req.method === "HEAD") return res.end();
    const stream = fs.createReadStream(file);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
      } else {
        serveStatic(req, res, url);
      }
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (res.headersSent) return res.destroy();
      if (status === 404 && !(req.url || "").startsWith("/api")) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Not found");
      }
      sendJson(res, status, { error: status === 500 ? "internal server error" : e.message });
    }
  });
  server.db = db;
  server.on("close", () => { try { db.close(); } catch {} });
  return server;
}

if (require.main === module) {
  const dbPath = process.env.DATABASE_FILE || path.join(__dirname, "data", "app.db");
  const port = Number(process.env.PORT) || 3000;
  createServer(dbPath).listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
}

module.exports = { createServer };
