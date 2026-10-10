import { ArrowUpRight, Gamepad2, Loader2, Plus } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";

const BRAND_LOGO = import.meta.env.VITE_APP_LOGO || "/arcane-avocado.svg";

function GameArtwork({ index }: { index: number }) {
  const colors = [
    ["#a4ba85", "#78985c", "#c9d7b4"],
    ["#b7a484", "#927651", "#d9cdb9"],
    ["#90aab6", "#657f90", "#c2d2d8"],
    ["#b0a0ba", "#8d7598", "#d8cadd"],
  ][index % 4];
  return (
    <svg viewBox="0 0 360 210" fill="none" aria-hidden="true">
      <path d="M31 152h298M58 181h244" stroke={colors[2]} strokeWidth="2" />
      <rect x="77" y="115" width="62" height="37" rx="5" fill={colors[2]} />
      <rect x="213" y="88" width="65" height="64" rx="5" fill={colors[2]} />
      <path
        d="M138 111c31-52 65-52 94-18"
        stroke={colors[0]}
        strokeWidth="2"
        strokeDasharray="4 6"
      />
      <rect x="150" y="65" width="41" height="41" rx="11" fill={colors[1]} />
      <path
        d="M161 86h19m-9-9v18"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="264" cy="57" r="9" stroke={colors[1]} strokeWidth="3" />
      <path
        d="M73 73h14m-7-7v14M302 108h10m-5-5v10"
        stroke={colors[0]}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="112" cy="43" r="3" fill={colors[0]} />
      <circle cx="193" cy="171" r="3" fill={colors[0]} />
    </svg>
  );
}

export default function Explore() {
  const games = trpc.game.explore.useInfiniteQuery(
    { limit: 18 },
    { getNextPageParam: page => page.nextCursor ?? undefined }
  );
  const items = games.data?.pages.flatMap(page => page.items) ?? [];
  return (
    <main className="community-page">
      <header className="community-header">
        <Link href="/" className="community-brand" aria-label="ARCANE 首页">
          <img src={BRAND_LOGO} alt="" />
          <span>
            arcane<span className="brand-period">.</span>
          </span>
        </Link>
        <Button asChild className="create-link">
          <Link href="/">
            <Plus size={15} />
            创建游戏
          </Link>
        </Button>
      </header>
      <div className="community-intro">
        <p className="eyebrow">由创意生长的世界</p>
        <h1>来玩点不一样的。</h1>
        <p>
          探索创作者公开发布的游戏。遇见喜欢的作品，试玩它，再 Remix
          成你的新想法。
        </p>
      </div>
      {games.isLoading ? (
        <div className="community-empty" role="status">
          <Loader2 className="animate-spin" size={24} />
          <p>正在寻找可以一起玩的世界…</p>
        </div>
      ) : games.error ? (
        <div className="community-empty">
          <Gamepad2 size={35} />
          <h2>游戏列表暂时无法加载</h2>
          <p>请稍后再试，或回到工作台继续自己的创作。</p>
          <Button variant="outline" onClick={() => void games.refetch()}>
            重新加载
          </Button>
        </div>
      ) : !items.length ? (
        <div className="community-empty">
          <Gamepad2 size={42} />
          <h2>第一个游戏世界，等你创造</h2>
          <p>创建游戏，通过运行验证和试玩确认后公开发布，即可展示在这里。</p>
          <Button asChild>
            <Link href="/">
              创建第一个游戏
              <ArrowUpRight size={15} />
            </Link>
          </Button>
        </div>
      ) : (
        <div className="game-card-grid">
          {items.map((game, index) => (
            <Link
              className="community-game-card"
              href={`/play/${game.publicationId}`}
              key={game.publicationId}
            >
              <div className={`game-card-art palette-${index % 4}`}>
                <GameArtwork index={index} />
                <span>作品示意</span>
              </div>
              <div className="game-card-body">
                <h2>{game.title || "未命名游戏"}</h2>
                <p>{game.description || "打开这款游戏，探索创作者的想法。"}</p>
                <small>
                  v{game.version} ·{" "}
                  {new Date(game.createdAt).toLocaleDateString("zh-CN")}{" "}
                  <span aria-hidden="true">↗</span>
                </small>
              </div>
            </Link>
          ))}
        </div>
      )}
      {games.hasNextPage && (
        <Button
          variant="outline"
          className="community-load-more"
          disabled={games.isFetchingNextPage}
          onClick={() => void games.fetchNextPage()}
        >
          {games.isFetchingNextPage ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              正在加载
            </>
          ) : (
            "探索更多游戏"
          )}
        </Button>
      )}
      <footer className="explore-footer">
        <span>每个小世界，都从一个想法开始。</span>
        <span>ARCANE GAME STUDIO</span>
      </footer>
    </main>
  );
}
