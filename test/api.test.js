"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createServer } = require("../server");

let server, base, tmpDir;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trips-test-"));
  server = createServer(path.join(tmpDir, "test.db"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
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
  author: "tester",
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
  const c = await api("POST", "/api/trips", sample());
  assert.equal(c.status, 201);
  assert.match(c.body.editKey, /^[0-9a-f]{24,}$/);
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

  const got = await api("GET", `/api/trips/${id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.editKey, undefined);
  assert.deepEqual(got.body.days, sample().days);
  assert.deepEqual(got.body.photoIds, []);

  const body = { ...sample(), title: "改名后" };
  assert.equal((await api("PUT", `/api/trips/${id}`, body)).status, 403);
  assert.equal((await api("PUT", `/api/trips/${id}`, body, { "X-Edit-Key": "nope" })).status, 403);
  const put = await api("PUT", `/api/trips/${id}`, body, { "X-Edit-Key": c.body.editKey });
  assert.equal(put.status, 200);
  assert.equal(put.body.title, "改名后");

  assert.equal((await api("DELETE", `/api/trips/${id}`)).status, 403);
  const del = await api("DELETE", `/api/trips/${id}`, undefined, { "X-Edit-Key": c.body.editKey });
  assert.deepEqual(del.body, { ok: true });
  assert.equal((await api("GET", `/api/trips/${id}`)).status, 404);
});

test("pagination returns 12 per page", async () => {
  for (let i = 0; i < 13; i++) await api("POST", "/api/trips", { ...sample(), title: `分页${i}` });
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
    headers: { "Content-Type": "image/png" },
    body: bytes,
  });
  assert.equal(up.status, 201);
  const { id: photoId } = await up.json();

  const dl = await fetch(`${base}/api/photos/${photoId}`);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get("content-type"), "image/png");
  assert.match(dl.headers.get("cache-control"), /public, max-age=86400/);
  assert.deepEqual(Buffer.from(await dl.arrayBuffer()), bytes);

  const c = await api("POST", "/api/trips", { ...sample(), photoIds: [photoId] });
  assert.equal(c.status, 201);
  assert.deepEqual(c.body.photoIds, [photoId]);
  const list = await api("GET", "/api/trips?q=" + encodeURIComponent("测试行程"));
  assert.equal(list.body.trips.find((t) => t.id === c.body.id).coverPhotoId, photoId);

  await api("DELETE", `/api/trips/${c.body.id}`, undefined, { "X-Edit-Key": c.body.editKey });
  assert.equal((await fetch(`${base}/api/photos/${photoId}`)).status, 404);
});

test("photo validation", async () => {
  const bad = await fetch(base + "/api/photos", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "hello",
  });
  assert.equal(bad.status, 400);
  const big = await fetch(base + "/api/photos", {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
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
    const r = await api("POST", "/api/trips", body);
    assert.equal(r.status, 400);
    assert.equal(typeof r.body.error, "string");
  }
  const res = await fetch(base + "/api/trips", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
