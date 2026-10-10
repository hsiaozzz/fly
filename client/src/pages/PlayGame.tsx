import { useMemo, useState } from "react";
import {
  Gamepad2,
  Loader2,
  Maximize2,
  RefreshCw,
  Share2,
  Sparkles,
} from "lucide-react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";
import { createGameSandbox } from "@/lib/gamePreview";
import { trpc } from "@/lib/trpc";

const BRAND_LOGO = import.meta.env.VITE_APP_LOGO || "/arcane-avocado.svg";

export default function PlayGame({ publicationId }: { publicationId: string }) {
  const shareToken =
    new URLSearchParams(window.location.search).get("share") ?? undefined;
  const { isAuthenticated, loading } = useAuth();
  const game = trpc.game.publishedVersion.useQuery(
    { publicationId, shareToken },
    { retry: false }
  );
  const remix = trpc.game.remix.useMutation();
  const [reload, setReload] = useState(0);
  const runId = useMemo(() => crypto.randomUUID(), [publicationId, reload]);
  const sandbox = useMemo(
    () => createGameSandbox(game.data?.artifact ?? null, runId),
    [game.data?.artifact, runId]
  );

  async function remixGame() {
    if (loading || remix.isPending) return;
    if (!isAuthenticated) {
      try {
        sessionStorage.setItem(
          "arcane.returnTo",
          window.location.pathname + window.location.search
        );
      } catch {
        /* Login still works without storage. */
      }
      startLogin();
      return;
    }
    try {
      const created = await remix.mutateAsync({ publicationId, shareToken });
      window.location.href = `/?project=${created.project.id}`;
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Remix 失败，请重试。"
      );
    }
  }
  async function share() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success("试玩链接已复制");
    } catch {
      toast.info("请复制浏览器地址栏的试玩链接。");
    }
  }

  return (
    <main className="play-page">
      <header className="community-header">
        <Link href="/" className="community-brand" aria-label="ARCANE 首页">
          <img src={BRAND_LOGO} alt="" />
          <span>
            arcane<span className="brand-period">.</span>
          </span>
        </Link>
        <nav>
          <Link href="/explore">探索更多游戏</Link>
          <Button
            size="sm"
            variant="outline"
            disabled={!game.data || loading || remix.isPending}
            onClick={() => void remixGame()}
          >
            <Sparkles size={15} />
            {remix.isPending ? "创建项目中…" : "Remix"}
          </Button>
          {game.data && game.data.publication.visibility !== "private" && (
            <Button size="sm" variant="ghost" onClick={() => void share()}>
              <Share2 size={15} />
              分享
            </Button>
          )}
        </nav>
      </header>
      {game.isLoading ? (
        <div className="community-empty" role="status">
          <Loader2 className="animate-spin" />
          正在打开游戏…
        </div>
      ) : game.error || !game.data ? (
        <div className="community-empty">
          <Gamepad2 size={48} />
          <h1>暂时无法打开这个游戏</h1>
          <p>链接可能已撤销，或此作品需要作者的分享链接或登录访问。</p>
          <Button asChild>
            <Link href="/explore">探索公开游戏</Link>
          </Button>
        </div>
      ) : (
        <>
          <div className="play-heading">
            <div>
              <p className="eyebrow">创作者的游戏世界</p>
              <h1>{game.data.artifact.title}</h1>
              <p>{game.data.artifact.description}</p>
            </div>
            <div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setReload(value => value + 1)}
              >
                <RefreshCw size={15} />
                重新开始
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void document
                    .querySelector(".published-preview")
                    ?.requestFullscreen()
                    .catch(() => toast.info("此浏览器暂不支持全屏。"))
                }
              >
                <Maximize2 size={15} />
                全屏
              </Button>
            </div>
          </div>
          <div className="published-preview">
            <iframe
              key={runId}
              title={`${game.data.artifact.title} 试玩`}
              sandbox="allow-scripts"
              srcDoc={sandbox}
            />
          </div>
          <div className="play-controls">
            {game.data.artifact.controls.map((control, index) => (
              <span className="control-chip" key={index}>
                {control}
              </span>
            ))}
          </div>
          <p className="play-version">
            v{game.data.version.version} · 已通过独立运行检查 · 玩法由创作者确认
          </p>
        </>
      )}
    </main>
  );
}
