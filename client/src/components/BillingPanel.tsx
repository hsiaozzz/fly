import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  CreditCard,
  ExternalLink,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { hasLoginConfiguration, startLogin } from "@/const";
import { trpc } from "@/lib/trpc";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { appCapabilitiesSchema } from "@shared/appCapabilities";
import type { CreditBalance, PaymentOrder } from "@shared/payments/types";

const maximumPollingMs = 15 * 60_000;
const money = (amountFen: number) =>
  new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(
    amountFen / 100
  );
const safeOrderId = (value: string | null | undefined): string | null =>
  value && /^[a-f0-9]{32}$/.test(value) ? value : null;

function checkoutAddress(value: string, orderId: string): string | null {
  try {
    const address = new URL(value, window.location.origin);
    return address.origin === window.location.origin &&
      !address.username &&
      !address.password &&
      !address.search &&
      !address.hash &&
      address.pathname ===
        `/api/payments/orders/${encodeURIComponent(orderId)}/checkout`
      ? address.href
      : null;
  } catch {
    return null;
  }
}

const primaryButton =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[#28765b] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#215f49] disabled:cursor-not-allowed disabled:opacity-45";
const secondaryButton =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[#d6ddd4] bg-white px-4 py-2 text-sm font-medium text-[#202720] transition hover:bg-[#eef2eb] disabled:cursor-not-allowed disabled:opacity-45";

/** Payment status and balances always come from authenticated server queries. */
export function BillingContent({
  initialOrderId,
}: {
  initialOrderId?: string | null;
}) {
  const { user, isAuthenticated, loading: authLoading } = useAuth();
  const accountId = isAuthenticated ? (user?.id ?? null) : null;
  return (
    <BillingAccountContent
      key={accountId === null ? "guest" : accountId}
      accountId={accountId}
      authLoading={authLoading}
      initialOrderId={initialOrderId}
    />
  );
}

/** Remounting on account changes discards every private local snapshot. */
function BillingAccountContent({
  accountId,
  authLoading,
  initialOrderId,
}: {
  accountId: number | null;
  authLoading: boolean;
  initialOrderId?: string | null;
}) {
  const isAuthenticated = accountId !== null;
  const utils = trpc.useUtils();
  const catalog = trpc.billing.catalog.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [accountReady, setAccountReady] = useState(false);
  const [balanceData, setBalanceData] = useState<CreditBalance | null>(null);
  const [balanceFetching, setBalanceFetching] = useState(false);
  const [balanceError, setBalanceError] = useState(false);
  const createOrder = trpc.billing.createOrder.useMutation();
  const capabilities = useQuery({
    queryKey: ["app-capabilities"],
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/capabilities", {
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      });
      if (!response.ok) throw new Error("在线功能状态暂不可用。");
      const parsed = appCapabilitiesSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("在线功能状态暂不可用。");
      return parsed.data;
    },
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(() =>
    safeOrderId(initialOrderId)
  );
  const [createdOrder, setCreatedOrder] = useState<PaymentOrder | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const [queriedOrder, setQueriedOrder] = useState<PaymentOrder | null>(null);
  const [orderFetching, setOrderFetching] = useState(false);
  const [orderError, setOrderError] = useState(false);
  const [orderRevision, setOrderRevision] = useState(0);
  const alive = useRef(true),
    creating = useRef(false);
  const request = useRef<{ packageId: string; requestId: string } | null>(null);
  const pollingStarted = useRef(Date.now());
  const refreshedPaidOrders = useRef(new Set<string>());
  const balanceRequest = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      void utils.billing.balance.cancel();
      void utils.billing.getOrder.cancel();
      void utils.billing.balance.reset();
      void utils.billing.getOrder.reset();
    };
  }, []);
  useEffect(() => {
    if (!isAuthenticated) return;
    void (async () => {
      await Promise.all([
        utils.billing.balance.cancel(),
        utils.billing.getOrder.cancel(),
      ]);
      await Promise.all([
        utils.billing.balance.reset(),
        utils.billing.getOrder.reset(),
      ]);
      if (alive.current) setAccountReady(true);
    })();
  }, [accountId]);
  async function refreshBalance() {
    if (!isAuthenticated || !accountReady) return;
    const version = ++balanceRequest.current;
    setBalanceFetching(true);
    setBalanceError(false);
    try {
      await utils.billing.balance.cancel();
      if (!alive.current || version !== balanceRequest.current) return;
      const result = await utils.billing.balance.fetch(undefined, {
        staleTime: 0,
        retry: false,
      });
      if (alive.current && version === balanceRequest.current)
        setBalanceData(result);
    } catch {
      if (alive.current && version === balanceRequest.current) {
        setBalanceData(null);
        setBalanceError(true);
      }
    } finally {
      if (alive.current && version === balanceRequest.current)
        setBalanceFetching(false);
    }
  }
  useEffect(() => {
    if (accountReady) void refreshBalance();
  }, [accountReady]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (
      catalog.data?.packages.length &&
      !catalog.data.packages.some(item => item.id === selectedId)
    )
      setSelectedId(catalog.data.packages[0].id);
  }, [catalog.data, selectedId]);
  useEffect(() => {
    pollingStarted.current = Date.now();
  }, [orderId]);

  useEffect(() => {
    setQueriedOrder(null);
    setOrderError(false);
    if (!accountReady || !orderId) return;
    let cancelled = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (cancelled || !alive.current) return;
      setOrderFetching(true);
      try {
        const result = await utils.billing.getOrder.fetch(
          { orderId },
          { staleTime: 0, retry: false }
        );
        if (cancelled || !alive.current) return;
        if (result.id !== orderId) {
          setOrderError(true);
          return;
        }
        setQueriedOrder(result);
        setOrderError(false);
        if (
          result.status === "pending" &&
          Number.isFinite(Date.parse(result.expiresAt)) &&
          Date.parse(result.expiresAt) > Date.now() &&
          Date.now() - pollingStarted.current < maximumPollingMs
        )
          timer = setTimeout(() => void poll(), 3000);
      } catch {
        if (!cancelled && alive.current) setOrderError(true);
      } finally {
        if (!cancelled && alive.current) setOrderFetching(false);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      void utils.billing.getOrder.cancel({ orderId });
    };
  }, [accountReady, orderId, orderRevision]);
  const currentOrder =
    isAuthenticated && orderId
      ? queriedOrder?.id === orderId
        ? queriedOrder
        : createdOrder?.id === orderId
          ? createdOrder
          : null
      : null;
  useEffect(() => {
    if (
      !currentOrder ||
      currentOrder.status !== "paid" ||
      refreshedPaidOrders.current.has(currentOrder.id)
    )
      return;
    refreshedPaidOrders.current.add(currentOrder.id);
    void refreshBalance();
  }, [currentOrder, utils]);

  const packages = catalog.data?.packages ?? [];
  const selected = packages.find(item => item.id === selectedId);
  const configured =
    catalog.data?.configured === true &&
    catalog.data.enabled === true &&
    catalog.data.pricingConfigured === true;
  const canLogin =
    capabilities.data?.authentication.configured === true &&
    hasLoginConfiguration();
  const expiresAt = currentOrder ? Date.parse(currentOrder.expiresAt) : NaN;
  const expired =
    currentOrder?.status === "pending" &&
    (!Number.isFinite(expiresAt) || expiresAt <= now);
  const pollingPaused = now - pollingStarted.current >= maximumPollingMs;
  const pending = currentOrder?.status === "pending" && !expired;
  const canPurchase =
    configured &&
    isAuthenticated &&
    accountReady &&
    Boolean(selected) &&
    !creating.current &&
    !createOrder.isPending &&
    !pending;
  const state =
    orderId && orderError
      ? "query-error"
      : currentOrder?.status === "paid"
        ? "paid"
        : currentOrder?.status === "closed"
          ? "closed"
          : expired
            ? "expired"
            : currentOrder
              ? "pending"
              : orderId
                ? "checking"
                : "idle";

  async function purchase() {
    if (!canPurchase || !selected || creating.current) return;
    creating.current = true;
    setMessage(null);
    if (request.current?.packageId !== selected.id)
      request.current = {
        packageId: selected.id,
        requestId: crypto.randomUUID(),
      };
    // A user gesture opens only an empty same-origin page. Navigation is allowed
    // after the server returns the exact protected checkout path for this order.
    let checkoutWindow: Window | null = null;
    try {
      checkoutWindow = window.open("about:blank", "_blank");
    } catch {
      /* A direct checkout link is shown after creation. */
    }
    try {
      if (checkoutWindow) checkoutWindow.opener = null;
    } catch {
      /* Link fallback remains available. */
    }
    try {
      const result = await createOrder.mutateAsync(request.current);
      if (!alive.current) {
        checkoutWindow?.close();
        return;
      }
      const id = safeOrderId(result.order.id),
        address = id ? checkoutAddress(result.checkoutUrl, id) : null;
      if (!id || !address || result.order.packageId !== selected.id) {
        checkoutWindow?.close();
        setMessage("订单信息暂不可用，请重新查询账户后再试。");
        return;
      }
      setCreatedOrder(result.order);
      setOrderId(id);
      setCheckoutUrl(address);
      if (
        result.order.status === "pending" &&
        Date.parse(result.order.expiresAt) > Date.now()
      ) {
        try {
          if (checkoutWindow && !checkoutWindow.closed)
            checkoutWindow.location.replace(address);
        } catch {
          setMessage("请点击“前往支付宝支付”打开付款页面。");
        }
      } else checkoutWindow?.close();
    } catch {
      checkoutWindow?.close();
      if (alive.current)
        setMessage(
          "暂时无法创建订单。你可以重试，同一次购买不会重复创建订单。"
        );
    } finally {
      creating.current = false;
    }
  }

  function chooseAnother() {
    if (pending || createOrder.isPending) return;
    setOrderId(null);
    setCreatedOrder(null);
    setCheckoutUrl(null);
    setMessage(null);
    request.current = null;
  }

  const available =
    isAuthenticated && !balanceFetching && !balanceError ? balanceData : null;
  return (
    <section
      className="billing-content min-w-0 space-y-5"
      data-testid="billing-content"
      aria-label="套餐与支付"
    >
      <div
        className="billing-balance grid grid-cols-3 gap-3 rounded-2xl border border-[#dce4d8] bg-[#eef4eb] p-4"
        aria-label="账户创作额度"
      >
        {[
          ["可用额度", available?.available],
          ["进行中", available?.reserved],
          ["已使用", available?.consumed],
        ].map(([label, value]) => (
          <div key={String(label)}>
            <p className="text-xs text-[#637060]">{label}</p>
            <p
              className="mt-1 text-2xl font-semibold tabular-nums"
              data-testid={
                label === "可用额度" ? "credit-available" : undefined
              }
            >
              {typeof value === "number" ? value : "—"}
            </p>
          </div>
        ))}
      </div>
      <p className="text-sm leading-6 text-[#65715f]">
        每日免费额度优先使用；用完后再使用购买额度。每次成功生成或修改消耗 1
        次，失败、取消和需求澄清不扣购买额度。
      </p>
      {authLoading || catalog.isLoading ? (
        <p role="status" className="flex items-center gap-2 text-sm">
          <Loader2 className="animate-spin" size={16} />
          正在确认账户与套餐…
        </p>
      ) : null}
      {!authLoading && !isAuthenticated && (
        <div className="rounded-xl border border-[#e4dcc8] bg-[#fff8e8] p-3 text-sm">
          <p>登录后购买创作额度，并在账户中查看余额。</p>
          <button
            className={`${secondaryButton} mt-3`}
            disabled={!canLogin}
            onClick={() => startLogin()}
          >
            {canLogin ? "登录后购买" : "账号登录尚未开启"}
          </button>
        </div>
      )}
      {catalog.isError && (
        <div
          role="alert"
          className="rounded-xl border border-[#eed9d0] bg-[#fff3ee] p-3 text-sm"
        >
          <p>暂时无法加载套餐，请稍后重试。</p>
          <button
            className={`${secondaryButton} mt-2`}
            onClick={() => void catalog.refetch()}
          >
            重新加载套餐
          </button>
        </div>
      )}
      {catalog.data && !configured && (
        <p
          role="status"
          className="rounded-xl border border-[#e4dcc8] bg-[#fff8e8] p-3 text-sm"
        >
          {catalog.data.pricingConfigured
            ? "支付宝支付尚未开放，当前套餐暂不可购买。"
            : "套餐价格尚未发布，下方仅为建议方案，尚未开放售卖。"}
        </p>
      )}
      {catalog.data?.environment === "sandbox" && configured && (
        <p className="rounded-xl bg-[#eaf1f5] p-3 text-sm text-[#4d6571]">
          支付宝沙箱环境，仅用于测试付款。
        </p>
      )}
      <div
        className="billing-packages grid gap-3 sm:grid-cols-2"
        aria-label="创作套餐"
      >
        {packages.map(item => (
          <button
            key={item.id}
            type="button"
            data-testid={`package-${item.id}`}
            aria-pressed={selectedId === item.id}
            disabled={pending || createOrder.isPending}
            onClick={() => setSelectedId(item.id)}
            className={`billing-package rounded-2xl border-2 p-4 text-left transition ${selectedId === item.id ? "border-[#28765b] bg-[#f1f6ef]" : "border-[#e0e5dc] bg-white"} disabled:cursor-not-allowed`}
          >
            <span className="block text-sm font-semibold">{item.name}</span>
            <span className="mt-2 block text-2xl font-semibold">
              {money(item.amountFen)}
            </span>
            <span className="mt-1 block text-sm text-[#637060]">
              {item.credits} 次创作额度
            </span>
            {!catalog.data?.pricingConfigured && (
              <span className="mt-2 block text-xs text-[#8d7651]">
                建议价格 · 尚未售卖
              </span>
            )}
          </button>
        ))}
      </div>
      {isAuthenticated && balanceError && (
        <p role="alert" className="text-sm text-[#8b5140]">
          暂时无法查询余额。
          <button
            className="ml-2 underline"
            onClick={() => void refreshBalance()}
          >
            重新查询余额
          </button>
        </p>
      )}
      {currentOrder || orderId ? (
        <div
          className="billing-order min-w-0 space-y-3 rounded-2xl border border-[#dce4d8] bg-white p-4"
          data-testid="billing-order"
        >
          {currentOrder && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 break-words">
                <p className="font-semibold">{currentOrder.packageName}</p>
                <p className="mt-1 text-sm text-[#637060]">
                  {currentOrder.credits} 次创作 ·{" "}
                  {money(currentOrder.amountFen)}
                </p>
              </div>
              <span className="min-w-0 max-w-full break-all text-xs text-[#74816e]">
                订单 {currentOrder.id}
              </span>
            </div>
          )}
          <div
            className="billing-status text-sm leading-6"
            role="status"
            aria-live="polite"
            data-testid="payment-status"
            data-payment-state={state}
          >
            {state === "paid" ? (
              <p className="flex items-center gap-2 font-semibold text-[#28765b]">
                <CheckCircle2 size={18} />
                付款已确认，创作额度已到账。
              </p>
            ) : state === "closed" ? (
              <p>订单已关闭，未确认付款。你可以重新选择套餐。</p>
            ) : state === "expired" ? (
              <p>订单已过期，请重新选择套餐。若已付款，可重新查询确认结果。</p>
            ) : state === "query-error" ? (
              <p>暂时无法查询付款结果，尚未确认到账。请重新查询。</p>
            ) : state === "checking" ? (
              <p>正在查询订单，尚未确认付款。</p>
            ) : (
              <p>
                等待支付宝付款确认。
                {pollingPaused
                  ? "自动查询已暂停，请手动重新查询。"
                  : "付款后会自动刷新结果。"}
              </p>
            )}
          </div>
          {pending && Number.isFinite(expiresAt) && (
            <p className="text-xs text-[#74816e]">
              剩余 {Math.max(0, Math.ceil((expiresAt - now) / 60_000))}{" "}
              分钟，请在有效期内完成付款。
            </p>
          )}
          <div className="billing-actions flex flex-wrap gap-2">
            {pending && checkoutUrl && (
              <a
                className={primaryButton}
                href={checkoutUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                前往支付宝支付
                <ExternalLink size={15} />
              </a>
            )}
            <button
              className={secondaryButton}
              disabled={!isAuthenticated || orderFetching}
              onClick={() => setOrderRevision(value => value + 1)}
            >
              <RefreshCw
                size={15}
                className={orderFetching ? "animate-spin" : ""}
              />
              重新查询付款结果
            </button>
            {(currentOrder || orderError) && !pending && (
              <button className={secondaryButton} onClick={chooseAnother}>
                选择其他套餐
              </button>
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={`${primaryButton} w-full`}
          data-testid="create-payment-order"
          disabled={!canPurchase}
          onClick={() => void purchase()}
        >
          {createOrder.isPending ? (
            <Loader2 size={17} className="animate-spin" />
          ) : (
            <CreditCard size={17} />
          )}
          {createOrder.isPending ? "正在创建订单…" : "使用支付宝购买"}
        </button>
      )}
      {message && (
        <p
          role="alert"
          className="rounded-xl bg-[#fff3ee] p-3 text-sm text-[#8b5140]"
        >
          {message}
        </p>
      )}
      <p className="text-xs leading-5 text-[#74816e]">
        支付完成后请返回这里确认结果。额度以账户查询结果为准；关闭支付窗口不会确认付款。
      </p>
    </section>
  );
}

export function BillingPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={value => {
        if (!value) onClose();
      }}
    >
      <DialogContent
        className="billing-panel max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[720px]"
        style={{ background: "#f7f8f5", color: "#202720" }}
        data-testid="billing-dialog"
      >
        <DialogHeader className="billing-header">
          <DialogTitle className="text-2xl">让下一个想法继续生长</DialogTitle>
          <DialogDescription className="text-[#637060]">
            选一份创作额度，用支付宝完成付款。
          </DialogDescription>
        </DialogHeader>
        {open && <BillingContent />}
      </DialogContent>
    </Dialog>
  );
}
