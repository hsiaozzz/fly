import { useEffect, useRef, useState } from "react";
import { Loader2, ShieldCheck, Share2, X } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import type { GameArtifact } from "@shared/game/types";
import type { ValidationReport } from "@shared/game/validation";

type Publication = {
  publicationId: string;
  projectVersionId: number;
  title: string;
  visibility: "private" | "unlisted" | "public";
  url: string;
};
const publicationSchema = z.object({
  publicationId: z.string(),
  projectVersionId: z.number(),
  title: z.string(),
  visibility: z.enum(["private", "unlisted", "public"]),
  url: z.string(),
});

export default function GamePublishPanel({
  artifact,
  userId,
  disabled,
  onSave,
  onSignIn,
  onClose,
}: {
  artifact: GameArtifact | null;
  userId?: number;
  disabled: boolean;
  onSave: (receipt: string) => Promise<number | null>;
  onSignIn: () => void;
  onClose: () => void;
}) {
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [visibility, setVisibility] =
    useState<Publication["visibility"]>("unlisted");
  const [confirmedGameplay, setConfirmedGameplay] = useState(false);
  const [publications, setPublications] = useState<Publication[]>([]);
  const [publishing, setPublishing] = useState(false);
  const sourceRef = useRef(artifact);
  sourceRef.current = artifact;
  const validationSequence = useRef(0);
  const validation = trpc.game.validateArtifact.useMutation();
  const publish = trpc.game.publishVersion.useMutation();
  const revoke = trpc.game.revokePublication.useMutation();
  const utils = trpc.useUtils();
  const storageKey = `arcane.publications.v1.${userId ?? "guest"}`;

  useEffect(() => {
    validationSequence.current += 1;
    setReport(null);
    setReceipt(null);
    setConfirmedGameplay(false);
  }, [artifact]);
  useEffect(() => {
    try {
      setPublications(
        z
          .array(publicationSchema)
          .parse(JSON.parse(localStorage.getItem(storageKey) ?? "[]"))
      );
    } catch {
      setPublications([]);
    }
  }, [storageKey]);
  function storePublications(next: Publication[]) {
    setPublications(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* Publication stays usable in this session. */
    }
  }
  async function validate() {
    if (!artifact || disabled || validation.isPending) return;
    if (!userId) return onSignIn();
    const snapshot = artifact,
      sequence = ++validationSequence.current;
    setReceipt(null);
    setConfirmedGameplay(false);
    try {
      const result = await validation.mutateAsync({ artifact: snapshot });
      if (
        sequence !== validationSequence.current ||
        sourceRef.current !== snapshot
      )
        return;
      setReport(result.report);
      setReceipt(result.receipt ?? null);
      if (result.report.status === "passed")
        toast.success("实际浏览器构建和输入检查通过，请亲自确认玩法。");
      else
        toast.info(
          result.report.status === "unverified"
            ? "运行环境尚不能完成验证，请查看具体原因。"
            : "验证发现问题，请修复后再发布。"
        );
    } catch (error) {
      if (sequence === validationSequence.current)
        toast.error(error instanceof Error ? error.message : "验证失败。");
    }
  }
  async function publishGame() {
    if (
      !artifact ||
      !receipt ||
      report?.status !== "passed" ||
      !confirmedGameplay ||
      disabled ||
      publishing
    )
      return;
    const snapshot = artifact;
    setPublishing(true);
    try {
      const projectVersionId = await onSave(receipt);
      if (!projectVersionId) return;
      if (sourceRef.current !== snapshot)
        throw new Error("草稿在保存时发生变化，请重新验证当前版本。");
      const result = await publish.mutateAsync({
        projectVersionId,
        visibility,
        validationReceipt: receipt,
        confirmedGameplay,
      });
      storePublications([
        {
          publicationId: result.publicationId,
          projectVersionId,
          title: snapshot.title,
          visibility,
          url: result.url,
        },
        ...publications.filter(
          item => item.publicationId !== result.publicationId
        ),
      ]);
      await utils.game.explore.invalidate();
      toast.success(
        visibility === "private"
          ? "已发布为私有作品"
          : "游戏已发布，可以分享试玩链接"
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "发布失败。");
    } finally {
      setPublishing(false);
    }
  }
  async function revokeGame(item: Publication) {
    try {
      await revoke.mutateAsync({ publicationId: item.publicationId });
      storePublications(
        publications.filter(
          publication => publication.publicationId !== item.publicationId
        )
      );
      await utils.game.explore.invalidate();
      toast.success("发布已撤销，原试玩链接已失效");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "撤销失败。");
    }
  }
  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(
        new URL(url, window.location.origin).href
      );
      toast.success("试玩链接已复制");
    } catch {
      toast.info("此浏览器无法自动复制，请使用下方完整链接。");
    }
  }

  return (
    <section className="publish-panel" aria-label="验证与发布">
      <div className="history-heading">
        <strong>
          <ShieldCheck size={15} />
          验证与发布
        </strong>
        <span>独立浏览器运行检查与创作者试玩确认</span>
        <button aria-label="关闭发布面板" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <p>
        发布前会在独立浏览器中构建并操作当前游戏。游戏是否好玩、规则是否符合预期，仍需创作者亲自试玩确认。
      </p>
      {!userId ? (
        <Button onClick={onSignIn}>登录后验证与发布</Button>
      ) : (
        <div className="publish-controls">
          <Button
            disabled={
              !artifact || disabled || validation.isPending || publishing
            }
            onClick={() => void validate()}
          >
            {validation.isPending ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <ShieldCheck size={15} />
            )}
            {validation.isPending ? "正在独立试玩…" : "验证当前游戏"}
          </Button>
          <label>
            可见范围
            <select
              aria-label="发布可见范围"
              value={visibility}
              onChange={event =>
                setVisibility(event.target.value as Publication["visibility"])
              }
              disabled={publishing}
            >
              <option value="private">私有 · 仅自己可玩</option>
              <option value="unlisted">链接分享 · 持链接可玩</option>
              <option value="public">公开 · 展示在探索页</option>
            </select>
          </label>
          <label className="gameplay-confirmation">
            <input
              type="checkbox"
              checked={confirmedGameplay}
              onChange={event => setConfirmedGameplay(event.target.checked)}
              disabled={!receipt || publishing}
            />
            我已亲自试玩，确认操作、规则和胜负流程符合预期（创作者确认）
          </label>
          <Button
            disabled={
              !receipt ||
              !confirmedGameplay ||
              report?.status !== "passed" ||
              disabled ||
              publishing
            }
            onClick={() => void publishGame()}
          >
            <Share2 size={15} />
            {publishing ? "保存并发布中…" : "保存并发布"}
          </Button>
        </div>
      )}
      {report && (
        <div className="verification-report">
          <div className={`verification-verdict ${report.status}`}>
            <b>
              {report.status === "passed"
                ? "构建与实际输入检查通过"
                : report.status === "unverified"
                  ? "尚未完成验证"
                  : "检查发现问题"}
            </b>
            <span>
              {report.environment.viewport.width} ×{" "}
              {report.environment.viewport.height} ·{" "}
              {Math.round(report.durationMs / 1000)} 秒
            </span>
          </div>
          <div className="verification-checks">
            {report.checks.map(check => (
              <div className={`gate-row ${check.status}`} key={check.id}>
                <span className="verification-check-mark">
                  {check.status === "pass"
                    ? "✓"
                    : check.status === "fail"
                      ? "×"
                      : "?"}
                </span>
                <div className="gate-body">
                  <b>{check.label}</b>
                  <p>{check.detail}</p>
                </div>
              </div>
            ))}
          </div>
          {report.errors.length > 0 && (
            <pre className="gates-errors">{report.errors.join("\n")}</pre>
          )}
          {report.evidence?.screenshotDataUrl && (
            <img
              className="verification-screenshot"
              src={report.evidence.screenshotDataUrl}
              alt="独立浏览器验证时的游戏画面"
            />
          )}
        </div>
      )}
      {publications.length > 0 && (
        <div className="published-links">
          <strong>已发布的作品</strong>
          {publications.map(item => (
            <div className="published-entry" key={item.publicationId}>
              <span>
                {item.title} ·{" "}
                {item.visibility === "public"
                  ? "公开"
                  : item.visibility === "private"
                    ? "私有"
                    : "链接分享"}
              </span>
              <a href={item.url} target="_blank" rel="noreferrer">
                打开试玩
              </a>
              {item.visibility !== "private" && (
                <button onClick={() => void copyLink(item.url)}>
                  复制链接
                </button>
              )}
              <button
                disabled={revoke.isPending}
                onClick={() => void revokeGame(item)}
              >
                撤销发布
              </button>
              <input
                readOnly
                aria-label={`${item.title} 试玩链接`}
                value={new URL(item.url, window.location.origin).href}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
