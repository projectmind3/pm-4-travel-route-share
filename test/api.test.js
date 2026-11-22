"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createServer } = require("../server");

let server, base, tmpDir, owner, ownerAuth;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trips-test-"));
  server = createServer(path.join(tmpDir, "test.db"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await api("POST", "/api/auth/register", {
    email: "owner@example.com", password: "password123", displayName: "旅人甲",
  });
  owner = r.body;
  ownerAuth = { Authorization: "Bearer " + owner.token };
});

after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function api(method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const sample = () => ({
  title: "测试行程",
  destination: "测试城",
  author: "ignored-author",
  summary: "summary",
  transport: "地铁",
  lodging: "酒店",
  tips: "多喝水",
  days: [{ title: "Day 1", spots: [{ name: "A", note: "n" }] }],
  budget: [{ label: "餐饮", amount: 100.5 }, { label: "门票", amount: 50 }],
  photoIds: [],
});

test("three sample trips are seeded once", async () => {
  const r = await api("GET", "/api/trips");
  assert.equal(r.status, 200);
  assert.ok(r.body.trips.length >= 3);
  const count = (db) => db.prepare("SELECT COUNT(*) AS n FROM trips").get().n;
  const before = count(server.db);
  const second = createServer(path.join(tmpDir, "test.db"));
  const after = count(second.db);
  second.db.close();
  assert.equal(after, before);
  const fresh = createServer(":memory:");
  assert.equal(fresh.db.prepare("SELECT COUNT(*) AS n FROM trips").get().n, 3);
  fresh.db.close();
});

test("create, list, get, update, delete", async () => {
  const c = await api("POST", "/api/trips", sample(), ownerAuth);
  assert.equal(c.status, 201);
  assert.equal(c.body.editKey, undefined);
  assert.equal(c.body.author, "旅人甲");
  assert.equal(c.body.userId, owner.user.id);
  const id = c.body.id;

  const list = await api("GET", "/api/trips?q=" + encodeURIComponent("测试"));
  assert.equal(list.status, 200);
  assert.equal(list.body.page, 1);
  assert.equal(list.body.hasMore, false);
  const item = list.body.trips.find((t) => t.id === id);
  assert.equal(item.dayCount, 1);
  assert.equal(item.budgetTotal, 150.5);
  assert.equal(item.coverPhotoId, null);
  assert.equal(item.editKey, undefined);
  assert.equal(item.author, "旅人甲");
  assert.equal(item.userId, owner.user.id);

  const got = await api("GET", `/api/trips/${id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.editKey, undefined);
  assert.deepEqual(got.body.days, [{ title: "Day 1", spots: [{ name: "A", note: "n", lat: null, lng: null }] }]);
  assert.deepEqual(got.body.photoIds, []);

  const body = { ...sample(), title: "改名后" };
  assert.equal((await api("PUT", `/api/trips/${id}`, body)).status, 401);
  const put = await api("PUT", `/api/trips/${id}`, { ...body, author: "冒名" }, ownerAuth);
  assert.equal(put.status, 200);
  assert.equal(put.body.title, "改名后");
  assert.equal(put.body.author, "旅人甲");
  assert.equal(put.body.userId, owner.user.id);

  assert.equal((await api("DELETE", `/api/trips/${id}`)).status, 401);
  const del = await api("DELETE", `/api/trips/${id}`, undefined, ownerAuth);
  assert.deepEqual(del.body, { ok: true });
  assert.equal((await api("GET", `/api/trips/${id}`)).status, 404);
});

test("pagination returns 12 per page", async () => {
  for (let i = 0; i < 13; i++) await api("POST", "/api/trips", { ...sample(), title: `分页${i}` }, ownerAuth);
  const p1 = await api("GET", "/api/trips?q=" + encodeURIComponent("分页"));
  assert.equal(p1.body.trips.length, 12);
  assert.equal(p1.body.hasMore, true);
  const p2 = await api("GET", "/api/trips?page=2&q=" + encodeURIComponent("分页"));
  assert.equal(p2.body.trips.length, 1);
  assert.equal(p2.body.hasMore, false);
});

test("photo upload, download, attach and delete with trip", async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const up = await fetch(base + "/api/photos", {
    method: "POST",
    headers: { "Content-Type": "image/png", ...ownerAuth },
    body: bytes,
  });
  assert.equal(up.status, 201);
  const { id: photoId } = await up.json();

  const dl = await fetch(`${base}/api/photos/${photoId}`);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get("content-type"), "image/png");
  assert.match(dl.headers.get("cache-control"), /public, max-age=86400/);
  assert.deepEqual(Buffer.from(await dl.arrayBuffer()), bytes);

  const c = await api("POST", "/api/trips", { ...sample(), photoIds: [photoId] }, ownerAuth);
  assert.equal(c.status, 201);
  assert.deepEqual(c.body.photoIds, [photoId]);
  const list = await api("GET", "/api/trips?q=" + encodeURIComponent("测试行程"));
  assert.equal(list.body.trips.find((t) => t.id === c.body.id).coverPhotoId, photoId);

  await api("DELETE", `/api/trips/${c.body.id}`, undefined, ownerAuth);
  assert.equal((await fetch(`${base}/api/photos/${photoId}`)).status, 404);
});

test("photo validation", async () => {
  const bad = await fetch(base + "/api/photos", {
    method: "POST",
    headers: { "Content-Type": "text/plain", ...ownerAuth },
    body: "hello",
  });
  assert.equal(bad.status, 400);
  const big = await fetch(base + "/api/photos", {
    method: "POST",
    headers: { "Content-Type": "image/jpeg", ...ownerAuth },
    body: Buffer.alloc(3 * 1024 * 1024 + 1),
  });
  assert.equal(big.status, 413);
  assert.equal((await fetch(base + "/api/photos/999999")).status, 404);
});

test("trip validation errors", async () => {
  const cases = [
    { ...sample(), title: "" },
    { ...sample(), title: "x".repeat(101) },
    { ...sample(), days: Array.from({ length: 61 }, () => ({ title: "d", spots: [] })) },
    { ...sample(), days: [{ title: "d", spots: Array.from({ length: 31 }, () => ({ name: "s" })) }] },
    { ...sample(), budget: [{ label: "a", amount: -1 }] },
    { ...sample(), budget: [{ label: "a", amount: "5" }] },
    { ...sample(), budget: Array.from({ length: 51 }, () => ({ label: "a", amount: 1 })) },
    { ...sample(), photoIds: Array.from({ length: 21 }, (_, i) => i + 1) },
    { ...sample(), photoIds: [987654] },
  ];
  for (const body of cases) {
    const r = await api("POST", "/api/trips", body, ownerAuth);
    assert.equal(r.status, 400);
    assert.equal(typeof r.body.error, "string");
  }
  const res = await fetch(base + "/api/trips", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ownerAuth },
    body: "{bad",
  });
  assert.equal(res.status, 400);
});

test("static serving: missing public is 404, traversal blocked", async () => {
  const r = await fetch(base + "/no-such-file.txt");
  assert.equal(r.status, 404);
  const t = await fetch(base + "/..%2fserver.js");
  assert.equal(t.status, 404);
});

test("spot coordinates: save, order, update, null, validation", async () => {
  const body = sample();
  body.days = [{ title: "D", spots: [
    { name: "B", note: "", lat: 34.9949, lng: 135.785 },
    { name: "A", note: "", lat: -33.5, lng: -70.25 },
    { name: "C", note: "" },
  ] }];
  const c = await api("POST", "/api/trips", body, ownerAuth);
  assert.equal(c.status, 201);
  const g = await api("GET", "/api/trips/" + c.body.id);
  assert.deepEqual(g.body.days[0].spots.map((s) => [s.name, s.lat, s.lng]), [
    ["B", 34.9949, 135.785], ["A", -33.5, -70.25], ["C", null, null],
  ]);

  const upd = sample();
  upd.days = [{ title: "D", spots: [
    { name: "C", lat: null, lng: null }, { name: "A", lat: -33.5, lng: -70.25 }, { name: "B", lat: 1, lng: 2 },
  ] }];
  const p = await api("PUT", "/api/trips/" + c.body.id, upd, ownerAuth);
  assert.equal(p.status, 200);
  const g2 = await api("GET", "/api/trips/" + c.body.id);
  assert.deepEqual(g2.body.days[0].spots.map((s) => s.name), ["C", "A", "B"]);
  assert.equal(g2.body.days[0].spots[0].lat, null);
  assert.equal(g2.body.days[0].spots[2].lng, 2);

  for (const bad of [{ lat: 1 }, { lng: 1 }, { lat: "1", lng: 2 }, { lat: 91, lng: 0 }, { lat: 0, lng: 181 }]) {
    const b = sample();
    b.days = [{ title: "D", spots: [{ name: "X", ...bad }] }];
    const r = await api("POST", "/api/trips", b, ownerAuth);
    assert.equal(r.status, 400);
    assert.ok(r.body.error);
  }

  const old = await api("POST", "/api/trips", sample(), ownerAuth);
  assert.equal(old.status, 201);
  assert.equal(old.body.days[0].spots[0].lat, null);
});

test("legacy stored spots without lat/lng read back as null", async () => {
  const c = await api("POST", "/api/trips", sample(), ownerAuth);
  server.db.prepare("UPDATE trips SET days_json = ? WHERE id = ?")
    .run(JSON.stringify([{ title: "old", spots: [{ name: "Z", note: "" }] }]), c.body.id);
  const g = await api("GET", "/api/trips/" + c.body.id);
  assert.equal(g.body.days[0].spots[0].lat, null);
  assert.equal(g.body.days[0].spots[0].lng, null);
});

test("register, login, me, logout", async () => {
  const reg = await api("POST", "/api/auth/register", {
    email: "  Alice@Example.COM ", password: "secret-pass", displayName: "  爱丽丝 ",
  });
  assert.equal(reg.status, 201);
  assert.match(reg.body.token, /^[0-9a-f]{64}$/);
  assert.deepEqual(reg.body.user, { id: reg.body.user.id, email: "alice@example.com", displayName: "爱丽丝" });

  const row = server.db.prepare("SELECT * FROM users WHERE id = ?").get(reg.body.user.id);
  assert.notEqual(row.password_hash, "secret-pass");
  assert.ok(row.salt);
  const sess = server.db.prepare("SELECT token_hash FROM sessions WHERE user_id = ?").all(row.id);
  assert.ok(sess.every((x) => x.token_hash !== reg.body.token));

  assert.equal((await api("POST", "/api/auth/register", {
    email: "ALICE@example.com", password: "another-pass", displayName: "x",
  })).status, 409);
  for (const bad of [
    { email: "nope", password: "secret-pass", displayName: "x" },
    { email: "a@b.cc", password: "short", displayName: "x" },
    { email: "a@b.cc", password: "p".repeat(73), displayName: "x" },
    { email: "a@b.cc", password: "secret-pass", displayName: "   " },
    { email: "a@b.cc", password: "secret-pass", displayName: "n".repeat(51) },
    { email: "a".repeat(120) + "@b.cc", password: "secret-pass", displayName: "x" },
  ]) {
    assert.equal((await api("POST", "/api/auth/register", bad)).status, 400);
  }

  const login = await api("POST", "/api/auth/login", { email: "Alice@example.com", password: "secret-pass" });
  assert.equal(login.status, 200);
  assert.deepEqual(login.body.user, reg.body.user);
  const wrongPw = await api("POST", "/api/auth/login", { email: "alice@example.com", password: "wrong-pass" });
  const noUser = await api("POST", "/api/auth/login", { email: "ghost@example.com", password: "wrong-pass" });
  assert.equal(wrongPw.status, 401);
  assert.equal(noUser.status, 401);
  assert.equal(wrongPw.body.error, "邮箱或密码不对");
  assert.deepEqual(noUser.body, wrongPw.body);

  const h = { Authorization: "Bearer " + login.body.token };
  assert.deepEqual((await api("GET", "/api/auth/me", undefined, h)).body, { user: reg.body.user });
  assert.equal((await api("GET", "/api/auth/me")).status, 401);
  assert.equal((await api("GET", "/api/auth/me", undefined, { Authorization: "Bearer " + "0".repeat(64) })).status, 401);

  assert.deepEqual((await api("POST", "/api/auth/logout", undefined, h)).body, { ok: true });
  assert.equal((await api("GET", "/api/auth/me", undefined, h)).status, 401);
  assert.equal((await api("POST", "/api/auth/logout")).status, 401);
  // the registration token is a separate session and still works
  assert.equal((await api("GET", "/api/auth/me", undefined, { Authorization: "Bearer " + reg.body.token })).status, 200);
});

test("expired sessions count as logged out", async () => {
  const r = await api("POST", "/api/auth/register", { email: "exp@example.com", password: "password123", displayName: "过期" });
  server.db.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = ?").run("2000-01-01T00:00:00.000Z", r.body.user.id);
  assert.equal((await api("GET", "/api/auth/me", undefined, { Authorization: "Bearer " + r.body.token })).status, 401);
});

test("publishing needs login; author comes from the account", async () => {
  const noTrip = await api("POST", "/api/trips", sample());
  assert.equal(noTrip.status, 401);
  assert.equal(noTrip.body.error, "请先登录");
  const noPhoto = await fetch(base + "/api/photos", {
    method: "POST", headers: { "Content-Type": "image/png" }, body: Buffer.from([1, 2, 3]),
  });
  assert.equal(noPhoto.status, 401);

  const noAuthor = sample();
  delete noAuthor.author;
  const c = await api("POST", "/api/trips", { ...noAuthor, title: "昵称搜索行程" }, ownerAuth);
  assert.equal(c.status, 201);
  assert.equal(c.body.author, "旅人甲");
  assert.equal(c.body.editKey, undefined);
  const stored = server.db.prepare("SELECT author, user_id, edit_key FROM trips WHERE id = ?").get(c.body.id);
  assert.equal(stored.author, "旅人甲");
  assert.equal(stored.user_id, owner.user.id);
  assert.ok(stored.edit_key);

  const found = await api("GET", "/api/trips?q=" + encodeURIComponent("旅人甲"));
  assert.ok(found.body.trips.some((t) => t.id === c.body.id));
  assert.equal((await api("GET", "/api/trips/" + c.body.id)).status, 200);
});

test("only the author can edit or delete an owned trip", async () => {
  const other = await api("POST", "/api/auth/register", { email: "other@example.com", password: "password123", displayName: "旅人乙" });
  const otherAuth = { Authorization: "Bearer " + other.body.token };
  const c = await api("POST", "/api/trips", sample(), ownerAuth);
  const id = c.body.id;
  const stored = server.db.prepare("SELECT edit_key FROM trips WHERE id = ?").get(id);

  const put = await api("PUT", "/api/trips/" + id, sample(), otherAuth);
  assert.equal(put.status, 403);
  assert.equal(put.body.error, "只有作者本人可以修改");
  assert.equal((await api("DELETE", "/api/trips/" + id, undefined, otherAuth)).status, 403);
  // the edit key does not bypass ownership
  assert.equal((await api("DELETE", "/api/trips/" + id, undefined, { "X-Edit-Key": stored.edit_key })).status, 401);

  assert.equal((await api("PUT", "/api/trips/" + id, { ...sample(), title: "本人改" }, ownerAuth)).status, 200);
  assert.equal((await api("DELETE", "/api/trips/" + id, undefined, ownerAuth)).status, 200);
});

test("legacy trips without user_id still use X-Edit-Key", async () => {
  const now = new Date().toISOString();
  const r = server.db.prepare(
    `INSERT INTO trips (title, destination, author, summary, transport, lodging, tips,
       days_json, budget_json, edit_key, created_at, updated_at)
     VALUES ('旧行程', '旧城', '老作者', '', '', '', '', '[]', '[]', 'legacy-key', ?, ?)`
  ).run(now, now);
  const id = Number(r.lastInsertRowid);

  const g = await api("GET", "/api/trips/" + id);
  assert.equal(g.body.author, "老作者");
  assert.equal(g.body.userId, null);
  const list = await api("GET", "/api/trips?q=" + encodeURIComponent("老作者"));
  assert.equal(list.body.trips.find((t) => t.id === id).userId, null);

  assert.equal((await api("PUT", "/api/trips/" + id, sample())).status, 403);
  assert.equal((await api("PUT", "/api/trips/" + id, sample(), ownerAuth)).status, 403);
  const put = await api("PUT", "/api/trips/" + id, { ...sample(), author: "改名", title: "旧行程改" }, { "X-Edit-Key": "legacy-key" });
  assert.equal(put.status, 200);
  assert.equal(put.body.author, "老作者");
  assert.equal(put.body.userId, null);
  assert.equal((await api("DELETE", "/api/trips/" + id, undefined, { "X-Edit-Key": "legacy-key" })).status, 200);
});

test("schema migration to version 2 keeps existing trips", async () => {
  const file = path.join(tmpDir, "old.db");
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE trips (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    destination TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
    transport TEXT NOT NULL DEFAULT '', lodging TEXT NOT NULL DEFAULT '', tips TEXT NOT NULL DEFAULT '',
    days_json TEXT NOT NULL DEFAULT '[]', budget_json TEXT NOT NULL DEFAULT '[]', edit_key TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  old.exec("INSERT INTO trips (title, author, edit_key, created_at, updated_at) VALUES ('t', '老', 'k', 'a', 'a')");
  old.exec("PRAGMA user_version = 1");
  old.close();
  const s2 = createServer(file);
  assert.equal(s2.db.prepare("PRAGMA user_version").get().user_version, 2);
  assert.deepEqual({ ...s2.db.prepare("SELECT author, user_id FROM trips").get() }, { author: "老", user_id: null });
  s2.db.close();
  const s3 = createServer(file);
  assert.equal(s3.db.prepare("PRAGMA user_version").get().user_version, 2);
  s3.db.close();
});
