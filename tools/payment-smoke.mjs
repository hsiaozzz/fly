import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { preview } from "vite";
import { chromium } from "playwright-core";
import {
  browserExecutable,
  routeGate,
  within,
} from "./browser-smoke-helpers.mjs";

// Every billing API and checkout is mocked; no Alipay or business DB is reached.
const evidenceDirectory = "docs/ui-payments-2026-10-10/payment";
const packageList = [
  {
    id: "starter",
    name: "测试体验套餐",
    credits: 17,
    amountFen: 1234,
    currency: "CNY",
  },
  {
    id: "creator",
    name: "测试创作者套餐",
    credits: 50,
    amountFen: 4990,
    currency: "CNY",
  },
];
const existingId = "a".repeat(32),
  createdId = "b".repeat(32);
const result = data => ({ result: { data: { json: data } } });
const failure = (procedure, code = "INTERNAL_SERVER_ERROR") => ({
  error: {
    json: {
      message: "MOCK_PRIVATE_PAYMENT_DIAGNOSTIC",
      code: -32603,
      data: {
        code,
        httpStatus: code === "NOT_FOUND" ? 404 : 500,
        path: procedure,
      },
    },
  },
});
const summaries = [];
let browser, server;
const makeOrder = (id = existingId, overrides = {}) => ({
  id,
  packageId: "starter",
  packageName: packageList[0].name,
  credits: packageList[0].credits,
  amountFen: packageList[0].amountFen,
  currency: "CNY",
  environment: "sandbox",
  status: "pending",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  paidAt: null,
  ...overrides,
});

async function run() {
  server = process.env.ARCANE_TEST_BASE_URL
    ? null
    : await preview({
        configFile: fileURLToPath(
          new URL("../vite.config.ts", import.meta.url)
        ),
        logLevel: "warn",
        preview: { host: "127.0.0.1", port: 0, strictPort: true },
      });
  const baseUrl =
    process.env.ARCANE_TEST_BASE_URL ||
    server?.resolvedUrls?.local.find(
      value => new URL(value).hostname === "127.0.0.1"
    );
  assert.ok(baseUrl, "An owned production frontend preview is required.");
  const origin = new URL(baseUrl).origin;
  browser = await chromium.launch({
    executablePath: browserExecutable(),
    headless: true,
    chromiumSandbox: true,
    timeout: 15_000,
  });
  await mkdir(evidenceDirectory, { recursive: true });

  async function scenario(name, initial, exercise) {
    const config = {
      account: 1,
      configured: true,
      pricingConfigured: true,
      enabled: true,
      balanceError: false,
      queryError: false,
      createFailures: 0,
      order: makeOrder(),
      orderOwner: 1,
      checkoutUrl: null,
      balanceByAccount: {
        1: { available: 2, reserved: 0, consumed: 3 },
        2: { available: 7, reserved: 0, consumed: 0 },
      },
      ...initial,
    };
    const context = await browser.newContext({
      viewport: initial.viewport || { width: 1440, height: 1000 },
      serviceWorkers: "block",
      permissions: [],
      acceptDownloads: false,
    });
    const page = await context.newPage();
    const calls = [],
      errors = [],
      forbidden = [],
      checkouts = [],
      popups = [];
    const createGate = routeGate("mock payment creation"),
      orderGate = routeGate("old-account order query");
    const credited = new Set(),
      requestOrders = new Map();
    context.on("page", popup => {
      if (popup !== page) popups.push(popup);
    });
    page.on("pageerror", error => errors.push(error.name));
    await context.route("**/*", route => {
      const url = route.request().url();
      if (/^(?:about:|data:|blob:)/.test(url)) return route.continue();
      if (new URL(url).origin !== origin) {
        forbidden.push("external-network");
        return route.abort();
      }
      return route.fallback();
    });
    await context.route("**/api/capabilities", route => {
      const state = configured => ({
        configured,
        status: configured ? "configured" : "missing",
        verification: "unverified",
      });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          generation: state(false),
          authentication: state(true),
          cloudProjects: state(false),
          browserQa: state(false),
          database: state(true),
          objectStorage: state(false),
        }),
      });
    });
    await context.route("**/api/game/**", route => {
      forbidden.push("model-or-game-api");
      return route.abort();
    });
    await context.route("**/api/payments/**", route => {
      const url = new URL(route.request().url());
      if (
        /^\/api\/payments\/orders\/[a-f0-9]{32}\/checkout$/.test(
          url.pathname
        ) &&
        route.request().method() === "GET"
      ) {
        checkouts.push(url.pathname);
        return route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: '<!doctype html><html><head><meta charset="utf-8"></head><body><h1>模拟付款页面</h1><p>此测试不会提交真实支付宝付款。</p></body></html>',
        });
      }
      forbidden.push("unmocked-payment-request");
      return route.abort();
    });
    await context.route("**/api/trpc/**", async route => {
      const url = new URL(route.request().url()),
        procedures = url.pathname.split("/api/trpc/")[1].split(",");
      const raw =
        route.request().method() === "GET"
          ? JSON.parse(url.searchParams.get("input") || "{}")
          : route.request().postDataJSON();
      const responses = [];
      let creationHeld = false,
        orderHeld = false;
      for (let index = 0; index < procedures.length; index++) {
        const procedure = procedures[index],
          input = raw?.[index]?.json,
          account = config.account;
        calls.push({ procedure, input, account });
        if (procedure === "auth.me")
          responses.push(
            result(
              account
                ? {
                    id: account,
                    name: `Mock account ${account}`,
                    openId: `mock-${account}`,
                    email: null,
                    role: "user",
                    loginMethod: "mock",
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    lastSignedIn: new Date().toISOString(),
                  }
                : null
            )
          );
        else if (procedure === "billing.catalog")
          responses.push(
            result({
              enabled: config.enabled,
              configured: config.configured,
              environment: "sandbox",
              pricingConfigured: config.pricingConfigured,
              packages: packageList,
            })
          );
        else if (procedure === "billing.balance")
          responses.push(
            !account || config.balanceError
              ? failure(procedure)
              : result(structuredClone(config.balanceByAccount[account]))
          );
        else if (procedure === "billing.createOrder") {
          assert.equal(route.request().method(), "POST");
          assert.deepEqual(Object.keys(input).sort(), [
            "packageId",
            "requestId",
          ]);
          assert.match(input.requestId, /^[A-Za-z0-9_-]{8,64}$/);
          const selected = packageList.find(
            item => item.id === input.packageId
          );
          assert.ok(selected);
          if (config.holdCreation) {
            creationHeld = true;
            await createGate.hold();
          }
          if (config.createFailures > 0) {
            config.createFailures--;
            responses.push(failure(procedure));
            continue;
          }
          const key = `${account}:${input.requestId}`;
          const order =
            requestOrders.get(key) ||
            makeOrder(createdId, {
              packageId: selected.id,
              packageName: selected.name,
              credits: selected.credits,
              amountFen: selected.amountFen,
            });
          requestOrders.set(key, order);
          config.order = order;
          config.orderOwner = account;
          responses.push(
            result({
              order,
              checkoutUrl:
                config.checkoutUrl ||
                `/api/payments/orders/${order.id}/checkout`,
            })
          );
        } else if (procedure === "billing.getOrder") {
          assert.deepEqual(Object.keys(input), ["orderId"]);
          assert.match(input.orderId, /^[a-f0-9]{32}$/);
          const value = structuredClone(config.order);
          const failed =
            config.queryError ||
            !account ||
            account !== config.orderOwner ||
            input.orderId !== value.id;
          if (config.holdOrder && account === 1) {
            orderHeld = true;
            await orderGate.hold();
          }
          if (failed)
            responses.push(
              failure(
                procedure,
                account !== config.orderOwner
                  ? "NOT_FOUND"
                  : "INTERNAL_SERVER_ERROR"
              )
            );
          else {
            if (value.status === "paid" && !credited.has(value.id)) {
              credited.add(value.id);
              config.balanceByAccount[account].available += value.credits;
            }
            responses.push(result(value));
          }
        } else if (procedure === "game.listProjects")
          responses.push(result([]));
        else if (procedure === "game.explore")
          responses.push(result({ items: [], nextCursor: null }));
        else {
          forbidden.push(`unmocked-procedure:${procedure}`);
          responses.push(failure(procedure));
        }
      }
      await route
        .fulfill({
          contentType: "application/json",
          body: JSON.stringify(responses),
        })
        .catch(() => {});
      if (creationHeld) createGate.finish();
      if (orderHeld) orderGate.finish();
    });
    const go = async (search = "") => {
      await page.goto(`${origin}/billing${search}`);
      await page.getByTestId("package-starter").waitFor();
    };
    const state = expected =>
      page
        .locator(
          `[data-testid="payment-status"][data-payment-state="${expected}"]`
        )
        .waitFor();
    const waitBalance = value =>
      page.waitForFunction(
        expected =>
          document.querySelector('[data-testid="credit-available"]')
            ?.textContent === String(expected),
        value
      );
    try {
      await exercise({
        config,
        context,
        page,
        calls,
        popups,
        checkouts,
        createGate,
        orderGate,
        go,
        state,
        waitBalance,
      });
      assert.deepEqual(errors, [], `${name}: no uncaught browser errors`);
      assert.deepEqual(
        forbidden,
        [],
        `${name}: all payment/model/external calls remain mocked or blocked`
      );
      assert.equal(
        (await page.locator("body").innerText()).includes(
          "MOCK_PRIVATE_PAYMENT_DIAGNOSTIC"
        ),
        false
      );
      summaries.push({
        name,
        status: "passed",
        createRequests: calls.filter(
          call => call.procedure === "billing.createOrder"
        ).length,
        orderQueries: calls.filter(
          call => call.procedure === "billing.getOrder"
        ).length,
        balanceQueries: calls.filter(
          call => call.procedure === "billing.balance"
        ).length,
      });
    } finally {
      createGate.release();
      orderGate.release();
      await context.close();
    }
  }

  await scenario(
    "guest cannot purchase or query private billing data",
    { account: null },
    async ({ page, calls, go }) => {
      await go();
      assert.equal(
        await page.getByTestId("create-payment-order").isDisabled(),
        true
      );
      await page
        .getByText("登录后购买创作额度，并在账户中查看余额。", { exact: true })
        .waitFor();
      assert.equal(
        calls.some(call =>
          [
            "billing.balance",
            "billing.getOrder",
            "billing.createOrder",
          ].includes(call.procedure)
        ),
        false
      );
    }
  );
  await scenario(
    "unconfigured service and missing balance remain unavailable",
    {
      configured: false,
      pricingConfigured: false,
      enabled: false,
      balanceError: true,
    },
    async ({ page, calls, go }) => {
      await go();
      await page.getByText(/套餐价格尚未发布/).waitFor();
      await page.getByText(/暂时无法查询余额/).waitFor();
      assert.equal(
        await page.getByTestId("create-payment-order").isDisabled(),
        true
      );
      assert.equal(
        await page.getByTestId("credit-available").textContent(),
        "—"
      );
      assert.equal(
        calls.some(call => call.procedure === "billing.createOrder"),
        false
      );
    }
  );
  await scenario(
    "disabled new sales preserve existing balance and order reconciliation",
    {
      enabled: false,
      order: makeOrder(existingId, {
        status: "paid",
        paidAt: new Date().toISOString(),
      }),
    },
    async ({ go, state, page, calls, waitBalance }) => {
      await go(`?orderId=${existingId}`);
      await state("paid");
      await waitBalance(19);
      await page.getByText(/当前套餐暂不可购买/).waitFor();
      assert.equal(
        calls.some(call => call.procedure === "billing.createOrder"),
        false
      );
    }
  );
  await scenario(
    "return URL, local storage and forged messages cannot confirm payment",
    {},
    async ({ page, go, state, waitBalance }) => {
      await page.addInitScript(() =>
        localStorage.setItem("arcane.payment.status", "paid")
      );
      await go(`?orderId=${existingId}&status=paid&credits=999999`);
      await state("pending");
      await waitBalance(2);
      await page.evaluate(
        id =>
          window.postMessage(
            {
              source: "vibe-pay",
              orderId: id,
              status: "paid",
              credits: 999999,
            },
            "*"
          ),
        existingId
      );
      await page.waitForTimeout(150);
      await state("pending");
      await waitBalance(2);
    }
  );
  await scenario(
    "server-priced order, duplicate-click guard, pending then confirmed paid",
    { holdCreation: true },
    async ({
      config,
      page,
      calls,
      popups,
      checkouts,
      createGate,
      go,
      state,
      waitBalance,
    }) => {
      await go();
      await waitBalance(2);
      await page.getByTestId("package-creator").click();
      await page.getByTestId("create-payment-order").click();
      await createGate.waitUntilEntered();
      assert.equal(
        await page.getByTestId("create-payment-order").isDisabled(),
        true
      );
      assert.equal(
        calls.filter(call => call.procedure === "billing.createOrder").length,
        1
      );
      createGate.release();
      await state("pending");
      await waitBalance(2);
      await page.getByText(/50 次创作 · .*49\.90/).waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector('a[href*="/api/payments/orders/"]') !== null
      );
      await within(
        (async () => {
          while (!checkouts.length) await page.waitForTimeout(20);
        })(),
        "mock checkout navigation",
        5000
      );
      assert.equal(popups.length, 1);
      await popups[0]
        .getByRole("heading", { name: "模拟付款页面", exact: true })
        .waitFor();
      assert.equal(
        await popups[0].evaluate(() => window.opener === null),
        true
      );
      config.order = {
        ...config.order,
        status: "paid",
        paidAt: new Date().toISOString(),
      };
      await page
        .getByRole("button", { name: "重新查询付款结果", exact: true })
        .click();
      await state("paid");
      await waitBalance(52);
      await page
        .getByRole("button", { name: "重新查询付款结果", exact: true })
        .click();
      await state("paid");
      await waitBalance(52);
      await page.screenshot({
        path: `${evidenceDirectory}/paid-desktop.png`,
        fullPage: true,
      });
    }
  );
  await scenario(
    "blocked purchase popup offers a protected checkout link",
    {},
    async ({ page, popups, checkouts, go, state, waitBalance }) => {
      await page.addInitScript(() => {
        window.open = () => null;
      });
      await go();
      await waitBalance(2);
      await page.getByTestId("create-payment-order").click();
      await state("pending");
      assert.deepEqual(checkouts, []);
      assert.equal(popups.length, 0);
      const popupReady = page.context().waitForEvent("page");
      await page
        .getByRole("link", { name: "前往支付宝支付", exact: true })
        .click();
      const popup = await popupReady;
      await popup
        .getByRole("heading", { name: "模拟付款页面", exact: true })
        .waitFor();
      assert.equal(checkouts.length, 1);
      assert.equal(await popup.evaluate(() => window.opener === null), true);
    }
  );
  await scenario(
    "creation failures reuse an idempotency key and expose no private detail",
    { createFailures: 1 },
    async ({ page, calls, go, state, waitBalance }) => {
      await go();
      await waitBalance(2);
      await page.getByTestId("create-payment-order").click();
      await page.getByText(/暂时无法创建订单/).waitFor();
      await page.getByTestId("create-payment-order").click();
      await state("pending");
      const creations = calls.filter(
        call => call.procedure === "billing.createOrder"
      );
      assert.equal(creations.length, 2);
      assert.equal(creations[0].input.requestId, creations[1].input.requestId);
    }
  );
  await scenario(
    "closed order never grants credits",
    { order: makeOrder(existingId, { status: "closed" }) },
    async ({ go, state, waitBalance, page }) => {
      await go(`?orderId=${existingId}`);
      await state("closed");
      await waitBalance(2);
      await page
        .getByRole("button", { name: "选择其他套餐", exact: true })
        .click();
      await page.getByTestId("create-payment-order").waitFor();
    }
  );
  await scenario(
    "expired order stops automatic reconciliation and can be rechecked",
    {
      order: makeOrder(existingId, {
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    },
    async ({ go, state, page, calls, waitBalance }) => {
      await go(`?orderId=${existingId}`);
      await state("expired");
      await waitBalance(2);
      const count = calls.filter(
        call => call.procedure === "billing.getOrder"
      ).length;
      await page.waitForTimeout(3300);
      assert.equal(
        calls.filter(call => call.procedure === "billing.getOrder").length,
        count
      );
      await page
        .getByRole("button", { name: "重新查询付款结果", exact: true })
        .click();
      await within(
        (async () => {
          while (
            calls.filter(call => call.procedure === "billing.getOrder")
              .length !==
            count + 1
          )
            await page.waitForTimeout(20);
        })(),
        "expired order manual server recheck",
        5000
      );
      await state("expired");
    }
  );
  await scenario(
    "failed query remains unconfirmed and recovers through server recheck",
    { queryError: true },
    async ({ config, go, state, page, waitBalance }) => {
      await go(`?orderId=${existingId}`);
      await state("query-error");
      await waitBalance(2);
      await page.getByText(/尚未确认到账/).waitFor();
      config.queryError = false;
      await page
        .getByRole("button", { name: "重新查询付款结果", exact: true })
        .click();
      await state("pending");
      await waitBalance(2);
    }
  );
  await scenario(
    "untrusted checkout URL cannot open an external payment page",
    { checkoutUrl: "https://untrusted.invalid/checkout" },
    async ({ page, go, waitBalance, checkouts }) => {
      await go();
      await waitBalance(2);
      await page.getByTestId("create-payment-order").click();
      await page.getByText(/订单信息暂不可用/).waitFor();
      assert.deepEqual(checkouts, []);
      assert.equal(await page.getByTestId("payment-status").count(), 0);
    }
  );
  await scenario(
    "invalid return order id sends no order query",
    {},
    async ({ go, calls, page, waitBalance }) => {
      await go("?orderId=../../forged&status=paid");
      await waitBalance(2);
      assert.equal(
        calls.some(call => call.procedure === "billing.getOrder"),
        false
      );
      assert.equal(await page.getByTestId("payment-status").count(), 0);
    }
  );
  await scenario(
    "account switch rejects late account A order and private cached balance",
    {
      balanceByAccount: {
        1: { available: 999, reserved: 0, consumed: 0 },
        2: { available: 7, reserved: 0, consumed: 0 },
      },
    },
    async ({
      config,
      context,
      page,
      calls,
      go,
      state,
      waitBalance,
      orderGate,
    }) => {
      await go(`?orderId=${existingId}`);
      await state("pending");
      await waitBalance(999);
      config.holdOrder = true;
      config.order = {
        ...config.order,
        status: "paid",
        paidAt: new Date().toISOString(),
      };
      await page
        .getByRole("button", { name: "重新查询付款结果", exact: true })
        .click();
      await orderGate.waitUntilEntered();
      config.account = 2;
      await context.setOffline(true);
      await context.setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await within(
        (async () => {
          while (
            !calls.some(
              call => call.procedure === "auth.me" && call.account === 2
            )
          )
            await page.waitForTimeout(20);
        })(),
        "account B authentication refresh",
        8000
      );
      await waitBalance(7);
      orderGate.release();
      await orderGate.waitUntilFinished();
      await state("query-error");
      await page.waitForTimeout(150);
      await waitBalance(7);
      assert.equal(
        await page.locator('[data-payment-state="paid"]').count(),
        0
      );
      assert.equal(
        (await page.locator("body").innerText()).includes("999"),
        false
      );
    }
  );
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
    { width: 330, height: 430 },
  ])
    await scenario(
      `billing dialog layout and unmount ${viewport.width}x${viewport.height}`,
      { viewport },
      async ({ page, go, calls, config, state, waitBalance }) => {
        await page.goto(origin);
        await page
          .getByRole("button", { name: "创作额度", exact: true })
          .click();
        const dialog = page.getByTestId("billing-dialog");
        await dialog.waitFor();
        await page.getByTestId("package-starter").waitFor();
        await waitBalance(2);
        const box = await dialog.boundingBox();
        assert.ok(
          box &&
            box.x >= -1 &&
            box.y >= -1 &&
            box.x + box.width <= viewport.width + 1 &&
            box.y + box.height <= viewport.height + 1
        );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1
          ),
          true
        );
        await page.keyboard.press("Tab");
        assert.equal(
          await dialog.evaluate(element =>
            element.contains(document.activeElement)
          ),
          true
        );
        await page.screenshot({
          path: `${evidenceDirectory}/dialog-${viewport.width}x${viewport.height}.png`,
          fullPage: false,
        });
        const purchase = page.getByTestId("create-payment-order");
        await purchase.scrollIntoViewIfNeeded();
        assert.equal(await purchase.isDisabled(), false);
        const purchaseBox = await purchase.boundingBox();
        assert.ok(
          purchaseBox &&
            purchaseBox.y >= 0 &&
            purchaseBox.y + purchaseBox.height <= viewport.height
        );
        await purchase.click();
        await state("pending");
        await page.getByTestId("payment-status").scrollIntoViewIfNeeded();
        assert.equal(
          await dialog.evaluate(
            element => element.scrollWidth <= element.clientWidth + 1
          ),
          true,
          "Pending order must not overflow the dialog horizontally."
        );
        await page.screenshot({
          path: `${evidenceDirectory}/pending-${viewport.width}x${viewport.height}.png`,
          fullPage: false,
        });
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        const dialogQueries = calls.filter(
          call => call.procedure === "billing.getOrder"
        ).length;
        await page.waitForTimeout(3300);
        assert.equal(
          calls.filter(call => call.procedure === "billing.getOrder").length,
          dialogQueries,
          "Closing the dialog must stop payment polling."
        );
        config.order = makeOrder();
        await go(`?orderId=${existingId}`);
        await page.locator('[data-payment-state="pending"]').waitFor();
        await page.getByRole("link", { name: "返回创作", exact: true }).click();
        const count = calls.filter(
          call => call.procedure === "billing.getOrder"
        ).length;
        await page.waitForTimeout(3300);
        assert.equal(
          calls.filter(call => call.procedure === "billing.getOrder").length,
          count,
          "Unmount must stop payment polling."
        );
      }
    );
  await writeFile(
    `${evidenceDirectory}/report.json`,
    JSON.stringify(
      {
        schemaVersion: 1,
        status: "passed",
        mode: "mock payment APIs and checkout + real browser",
        realPayments: 0,
        modelCalls: 0,
        chromiumSandbox: true,
        testedAt: new Date().toISOString(),
        scenarios: summaries,
      },
      null,
      2
    )
  );
  console.log(
    `Payment smoke passed: ${summaries.length} mocked scenarios, no real payment or model calls.`
  );
}

try {
  await within(run(), "Payment UI smoke", 180_000);
} finally {
  await browser?.close();
  await server?.close();
}
