var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/bundle-A9hXSX/checked-fetch.js
var urls = /* @__PURE__ */ new Set();
function checkURL(request, init) {
  const url = request instanceof URL ? request : new URL(
    (typeof request === "string" ? new Request(request, init) : request).url
  );
  if (url.port && url.port !== "443" && url.protocol === "https:") {
    if (!urls.has(url.toString())) {
      urls.add(url.toString());
      console.warn(
        `WARNING: known issue with \`fetch()\` requests to custom HTTPS ports in published Workers:
 - ${url.toString()} - the custom port will be ignored when the Worker is published using the \`wrangler deploy\` command.
`
      );
    }
  }
}
__name(checkURL, "checkURL");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    const [request, init] = argArray;
    checkURL(request, init);
    return Reflect.apply(target, thisArg, argArray);
  }
});

// cloudflare-worker.js
var GITHUB_OWNER = "xucheng2024";
var GITHUB_REPO = "crypto-trading-automation";
var GITHUB_TOKEN = "YOUR_GITHUB_TOKEN";
var cloudflare_worker_default = {
  async scheduled(event, env, ctx) {
    const cron = event.cron;
    console.log(`\u{1F550} Cron triggered: ${cron}`);
    try {
      let scripts = [];
      if (cron.includes("2,7,12,17,22,27,32,37,42,47,52,57")) {
        scripts = ["monitor_delist", "cancel_pending_limits"];
        console.log("\u{1F4C5} 5-minute interval: monitor_delist + cancel_pending_limits");
      } else if (cron.includes("0,15,30,45")) {
        scripts = ["fetch_filled_orders", "auto_sell_orders"];
        console.log("\u{1F4C5} 15-minute interval: fetch_filled_orders + auto_sell_orders");
      } else if (cron.includes("55 23")) {
        scripts = ["cancel_pending_triggers"];
        console.log("\u{1F319} Nightly: cancel_pending_triggers");
      } else if (cron.includes("5 0")) {
        scripts = ["create_algo_triggers"];
        console.log("\u{1F305} Morning: create_algo_triggers");
      }
      const response = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/dispatches`, {
        method: "POST",
        headers: {
          "Authorization": `token ${env.GITHUB_TOKEN || GITHUB_TOKEN}`,
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "Cloudflare-Worker-Cron"
        },
        body: JSON.stringify({
          event_type: "cron",
          client_payload: {
            timestamp: (/* @__PURE__ */ new Date()).toISOString(),
            source: "cloudflare-worker",
            cron_schedule: cron,
            scripts,
            interval: cron.includes("*/5") ? "5min" : cron.includes("*/15") ? "15min" : "daily"
          }
        })
      });
      if (response.ok) {
        console.log(`\u2705 GitHub Actions triggered successfully for: ${scripts.join(", ")}`);
        return new Response("OK", { status: 200 });
      } else {
        const errorText = await response.text();
        console.error(`\u274C Failed to trigger GitHub Actions: ${response.status} - ${errorText}`);
        return new Response(`Error: ${response.status}`, { status: response.status });
      }
    } catch (error) {
      console.error("\u274C Error triggering GitHub Actions:", error);
      return new Response(`Error: ${error.message}`, { status: 500 });
    }
  },
  // 手动测试接口
  async fetch(request, env, ctx) {
    if (request.method === "POST") {
      return this.scheduled({ cron: "manual" }, env, ctx);
    }
    return new Response(`
      <h1>\u{1F680} Crypto Trading Automation Cron Worker</h1>
      <p>Status: Active</p>
      <p>GitHub Repo: ${GITHUB_OWNER}/${GITHUB_REPO}</p>
      <p>POST to this endpoint to manually trigger</p>
      <hr>
      <h2>\u{1F4C5} Cron Schedule:</h2>
      <ul>
        <li><strong>\u6BCF5\u5206\u949F</strong>: monitor_delist.py + cancel_pending_limits.py</li>
        <li><strong>\u6BCF15\u5206\u949F</strong>: fetch_filled_orders.py + auto_sell_orders.py</li>
        <li><strong>\u6BCF\u592923:55</strong>: cancel_pending_triggers.py</li>
        <li><strong>\u6BCF\u592900:05</strong>: create_algo_triggers.py</li>
      </ul>
      <hr>
      <h2>\u{1F527} \u6267\u884C\u903B\u8F91:</h2>
      <ul>
        <li>5\u5206\u949F\u95F4\u9694: \u76D1\u63A7\u548C\u4FDD\u62A4 + \u53D6\u6D88\u9650\u4EF7\u5355</li>
        <li>15\u5206\u949F\u95F4\u9694: \u83B7\u53D6\u5DF2\u5B8C\u6210\u8BA2\u5355 + \u81EA\u52A8\u5356\u51FA</li>
        <li>\u591C\u95F4\u4EFB\u52A1: \u53D6\u6D88\u5F85\u5904\u7406\u89E6\u53D1\u5668</li>
        <li>\u65E9\u6668\u4EFB\u52A1: \u521B\u5EFA\u7B97\u6CD5\u89E6\u53D1\u5668</li>
      </ul>
    `, {
      headers: { "Content-Type": "text/html" }
    });
  }
};

// ../../../.npm-global/lib/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../.npm-global/lib/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-A9hXSX/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = cloudflare_worker_default;

// ../../../.npm-global/lib/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-A9hXSX/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=cloudflare-worker.js.map
