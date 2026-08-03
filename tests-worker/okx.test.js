import assert from "node:assert/strict";
import test from "node:test";

import { OKXClient, operationError } from "../src/okx.js";

test("mutation responses reject top-level and per-order failures", () => {
  assert.match(operationError({ code: "50000", msg: "temporary" }), /temporary/);
  assert.match(operationError({ code: "0", data: [{ sCode: "51000", sMsg: "bad" }] }), /bad/);
  assert.match(operationError({ code: "0", data: [] }, true), /no mutation result/);
  assert.equal(operationError({ code: "0", data: [{ sCode: "0" }] }, true), null);
});

test("private request includes an OKX signature and never retries mutations", async () => {
  let calls = 0;
  let captured;
  const client = new OKXClient({ OKX_API_KEY: "key", OKX_SECRET_KEY: "secret", OKX_PASSPHRASE: "pass" }, async (_url, init) => {
    calls += 1;
    captured = init;
    return new Response(JSON.stringify({ code: "0", data: [{ sCode: "0", ordId: "1" }] }), { status: 200 });
  });
  await client.placeOrder({ instId: "BTC-USDT", side: "sell" });
  assert.equal(calls, 1);
  assert.ok(captured.headers["OK-ACCESS-SIGN"]);
  assert.equal(captured.method, "POST");
});

test("fetch implementation is not called with the OKX client as receiver", async () => {
  let receiver;
  const fetcher = function () {
    receiver = this;
    return Promise.resolve(new Response(JSON.stringify({ code: "0", data: [] }), { status: 200 }));
  };
  const client = new OKXClient({ OKX_API_KEY: "key", OKX_SECRET_KEY: "secret", OKX_PASSPHRASE: "pass" }, fetcher);
  await client.pendingLimits();
  assert.notEqual(receiver, client);
});

test("pending orders paginate past the first 100 rows", async () => {
  const calls = [];
  const client = new OKXClient({ OKX_API_KEY: "key", OKX_SECRET_KEY: "secret", OKX_PASSPHRASE: "pass" }, async (url) => {
    calls.push(url);
    const after = new URL(url).searchParams.get("after");
    const data = after ? [{ ordId: "older", side: "buy" }] : Array.from({ length: 100 }, (_, index) => ({ ordId: String(200 - index), side: "buy" }));
    return new Response(JSON.stringify({ code: "0", data }), { status: 200 });
  });
  const rows = await client.pendingLimits();
  assert.equal(rows.length, 101);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /after=101/);
});

test("fills paginate with billId while retaining the begin fence", async () => {
  const calls = [];
  const client = new OKXClient({ OKX_API_KEY: "key", OKX_SECRET_KEY: "secret", OKX_PASSPHRASE: "pass" }, async (url) => {
    calls.push(url);
    const after = new URL(url).searchParams.get("after");
    const data = after ? [{ billId: "older", tradeId: "older" }] : Array.from({ length: 100 }, (_, index) => ({ billId: String(300 - index), tradeId: String(index) }));
    return new Response(JSON.stringify({ code: "0", data }), { status: 200 });
  });
  const rows = await client.fillsSince(123456);
  assert.equal(rows.length, 101);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => new URL(url).searchParams.get("begin") === "123456"));
  assert.match(calls[1], /after=201/);
});
