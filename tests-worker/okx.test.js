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
