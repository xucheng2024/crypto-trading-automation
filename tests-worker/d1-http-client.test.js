import assert from "node:assert/strict";
import test from "node:test";

import { D1HttpDatabase } from "../scripts/d1-http-client.mjs";

test("D1 HTTP adapter preserves Worker D1 statement semantics", async () => {
  const requests = [];
  const db = new D1HttpDatabase({
    accountId: "account",
    databaseId: "database",
    apiToken: "token",
    fetcher: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ success: true, result: [{ success: true, results: [{ value: 7 }], meta: { changes: 1 } }] });
    },
  });

  assert.deepEqual(await db.prepare("SELECT ?").bind("value").first(), { value: 7 });
  assert.deepEqual((await db.prepare("UPDATE t SET x=?").bind(1).run()).meta, { changes: 1 });
  assert.deepEqual(JSON.parse(requests[0].options.body), { sql: "SELECT ?", params: ["value"] });
  assert.match(requests[0].url, /accounts\/account\/d1\/database\/database\/query$/);
});
