import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";
import { BillingContent } from "@/components/BillingPanel";

export default function Billing() {
  const orderId = new URLSearchParams(window.location.search).get("orderId");
  return (
    <main
      className="billing-page min-h-screen px-4 py-6 sm:px-8"
      style={{ background: "#f7f8f5", color: "#202720" }}
    >
      <div className="mx-auto max-w-[820px]">
        <header className="billing-header mb-8 flex flex-wrap items-center justify-between gap-4">
          <Link href="/" className="text-lg font-bold tracking-wide">
            ARCANE
          </Link>
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-xl border border-[#d6ddd4] bg-white px-4 py-2 text-sm"
          >
            <ArrowLeft size={16} />
            返回创作
          </Link>
        </header>
        <div className="mb-6">
          <p className="mb-2 text-xs font-semibold tracking-[.18em] text-[#28765b]">
            CREATION CREDITS
          </p>
          <h1 className="text-3xl font-semibold">为下一个灵感，留一些空间</h1>
          <p className="mt-3 text-sm text-[#637060]">
            购买 ARCANE 创作额度，继续生成与修改自己的游戏。
          </p>
        </div>
        <BillingContent initialOrderId={orderId} />
      </div>
    </main>
  );
}
