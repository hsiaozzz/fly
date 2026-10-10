import { Gamepad2, Loader2, Plus } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";

export default function Explore() {
  const games = trpc.game.explore.useInfiniteQuery(
    { limit: 18 },
    { getNextPageParam: page => page.nextCursor ?? undefined }
  );
  const items = games.data?.pages.flatMap(page => page.items) ?? [];
  return (
    <main className="community-page">
      <header className="community-header">
        <Link href="/" className="community-brand">
          ARCANE
        </Link>
        <Link href="/">
          <Button>
            <Plus size={15} />
            创建游戏
          </Button>
        </Link>
      </header>
      <div className="community-intro">
        <p className="eyebrow">EXPLORE</p>
        <h1>创作者的游戏世界</h1>
        <p>
          直接试玩社区公开作品，喜欢的游戏可以 Remix 成自己的项目，继续创作。
        </p>
      </div>
      {games.isLoading ? (
        <div className="community-empty">
          <Loader2 className="animate-spin" />
          正在加载游戏…
        </div>
      ) : games.error ? (
        <div className="community-empty">
          <p>暂时无法加载公开作品。</p>
          <Button onClick={() => void games.refetch()}>重试</Button>
        </div>
      ) : !items.length ? (
        <div className="community-empty">
          <Gamepad2 size={48} />
          <h2>第一个游戏世界，等你创造</h2>
          <p>创建游戏，通过运行验证和试玩确认后公开发布，即可展示在这里。</p>
          <Link href="/">
            <Button>创建第一个游戏</Button>
          </Link>
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
                <Gamepad2 size={54} />
                <span>即刻试玩</span>
              </div>
              <div className="game-card-body">
                <h2>{game.title || "Untitled game"}</h2>
                <p>{game.description || "探索这款创作者的游戏。"}</p>
                <small>
                  v{game.version} ·{" "}
                  {new Date(game.createdAt).toLocaleDateString()}
                </small>
              </div>
            </Link>
          ))}
        </div>
      )}
      {games.hasNextPage && (
        <Button
          className="community-load-more"
          disabled={games.isFetchingNextPage}
          onClick={() => void games.fetchNextPage()}
        >
          {games.isFetchingNextPage ? "加载中…" : "更多游戏"}
        </Button>
      )}
    </main>
  );
}
