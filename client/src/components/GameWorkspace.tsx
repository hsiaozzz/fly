import JSZip from "jszip";
import {
  Fragment,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Download,
  FileCode2,
  Folder,
  FolderOpen,
  Gamepad2,
  History,
  Loader2,
  Maximize2,
  Monitor,
  PanelBottom,
  Play,
  Plus,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Square,
  Terminal,
  Undo2,
  UserRound,
  Wrench,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/_core/hooks/useAuth";
import { hasLoginConfiguration, startLogin } from "@/const";
import { appCapabilitiesSchema } from "@shared/appCapabilities";
import { trpc } from "@/lib/trpc";
import { createGameSandbox } from "@/lib/gamePreview";
import { readGameStream } from "@/lib/gameStream";
import { useWorkspaceDrafts } from "@/hooks/useWorkspaceDrafts";
import {
  acknowledgeSave,
  applyGeneratedResult,
  editWorkspaceFile,
  emptyWorkspace,
  isCurrentTask,
  resultSchema,
  summarizeChanges,
  undoWorkspaceChange,
  type TaskContext,
  type WorkspaceState,
} from "@/lib/workspaceState";
import { z } from "zod";
import { BillingPanel } from "@/components/BillingPanel";
import GamePublishPanel from "@/components/GamePublishPanel";
import GameParametersPanel from "@/components/GameParametersPanel";
import ChatMarkdown from "@/components/ChatMarkdown";
import { readGameDesign } from "@shared/game/design";
import { createExampleArtifact } from "@shared/game/exampleArtifact";
import { bundleGameArtifact } from "@shared/game/bundle";
import {
  isProbeMessage,
  type RuntimeProbeReport,
} from "../../../shared/game/runtimeProbe";
import type {
  BuildReport,
  ClarifyQuestion,
  FreeGenResult,
  GameArtifact,
  GameFile,
  GateCheck,
  TraceStep,
} from "../../../shared/game/types";

type DockTab = "files" | "console" | "spec" | "run" | "gates" | "parameters";
type PreviewMode = "desktop" | "mobile";

const SAMPLE_PROMPT = "做一个跑酷小游戏，主角跳跃躲避障碍物并收集金币";
const BRAND_LOGO = import.meta.env.VITE_APP_LOGO || "/arcane-avocado.svg";
const Editor = lazy(() => import("@/components/LocalCodeEditor"));

function language(file?: GameFile) {
  if (!file) return "plaintext";
  if (file.path.endsWith(".js") || file.path.endsWith(".mjs"))
    return "javascript";
  if (file.path.endsWith(".css")) return "css";
  return file.language === "typescript"
    ? "typescript"
    : file.language === "json"
      ? "json"
      : file.language === "markdown"
        ? "markdown"
        : file.language === "html"
          ? "html"
          : "plaintext";
}

function Tree({
  files,
  activePath,
  onSelect,
}: {
  files: GameFile[];
  activePath: string;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({
    src: true,
    assets: true,
  });
  const paths = useMemo(() => {
    const folders = new Set<string>();
    files.forEach(file => {
      const parts = file.path.split("/");
      parts.slice(0, -1).reduce((acc, part) => {
        const next = acc ? `${acc}/${part}` : part;
        folders.add(next);
        return next;
      }, "");
    });
    return {
      folders: Array.from(folders).sort(),
      rootFiles: files.filter(file => !file.path.includes("/")),
    };
  }, [files]);
  const renderFolder = (folder: string, depth: number) => {
    const name = folder.split("/").at(-1) ?? folder;
    const children = files.filter(
      file =>
        file.path.startsWith(`${folder}/`) &&
        file.path.slice(folder.length + 1).split("/").length === 1
    );
    const childFolders = paths.folders.filter(
      path =>
        path.startsWith(`${folder}/`) &&
        path.slice(folder.length + 1).split("/").length === 1
    );
    const isOpen = open[folder] ?? false;
    return (
      <div key={folder}>
        <button
          className="tree-row"
          style={{ paddingLeft: `${10 + depth * 13}px` }}
          onClick={() =>
            setOpen(current => ({ ...current, [folder]: !isOpen }))
          }
        >
          {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {isOpen ? (
            <FolderOpen size={14} className="text-sky-300" />
          ) : (
            <Folder size={14} className="text-sky-300" />
          )}
          <span>{name}</span>
        </button>
        {isOpen && (
          <>
            {childFolders.map(item => renderFolder(item, depth + 1))}
            {children.map(item => (
              <button
                key={item.path}
                onClick={() => onSelect(item.path)}
                className={`tree-row file-row ${activePath === item.path ? "active" : ""}`}
                style={{ paddingLeft: `${36 + depth * 13}px` }}
              >
                <FileCode2 size={13} />
                <span>{item.path.split("/").at(-1)}</span>
              </button>
            ))}
          </>
        )}
      </div>
    );
  };
  return (
    <div className="file-tree">
      <div className="tree-heading">
        <FolderOpen size={14} />
        game-project
      </div>
      {paths.rootFiles.map(item => (
        <button
          key={item.path}
          onClick={() => onSelect(item.path)}
          className={`tree-row file-row ${activePath === item.path ? "active" : ""}`}
        >
          <FileCode2 size={13} />
          <span>{item.path}</span>
        </button>
      ))}
      {paths.folders
        .filter(path => !path.includes("/"))
        .map(folder => renderFolder(folder, 0))}
    </div>
  );
}

function ProjectPicker({
  projects,
  activeProjectId,
  onNew,
  onSelect,
  cloudEnabled,
}: {
  projects: Array<{ id: number; name: string }>;
  activeProjectId: number | null;
  onNew: () => void;
  onSelect: (id: number) => void;
  cloudEnabled: boolean;
}) {
  const [opened, setOpened] = useState(false);
  const active = projects.find(project => project.id === activeProjectId);
  return (
    <div className="project-picker">
      <button
        className="project-current"
        aria-expanded={opened}
        aria-label="选择游戏项目"
        onClick={() => setOpened(value => !value)}
      >
        <span className="project-mark">
          <Gamepad2 size={15} />
        </span>
        <span>{active?.name ?? "新游戏项目"}</span>
        <ChevronDown size={14} />
      </button>
      {opened && (
        <div className="project-popover">
          <button
            disabled={!cloudEnabled}
            onClick={() => {
              onNew();
              setOpened(false);
            }}
          >
            <Plus size={14} />
            New game project
          </button>
          {projects.map(project => (
            <button
              key={project.id}
              disabled={!cloudEnabled}
              onClick={() => {
                onSelect(project.id);
                setOpened(false);
              }}
            >
              <History size={14} />
              {project.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One gate result. Rendered identically whether it came from the static
 * source checks or the in-browser runtime probe, so the two read as one
 * report instead of two systems.
 */
function GateRow({ check }: { check: GateCheck }) {
  return (
    <div className={`gate-row ${check.status}`}>
      <span className="gate-mark">
        {check.status === "pass" ? (
          <Check size={12} />
        ) : check.status === "warn" ? (
          <i className="gate-dot" />
        ) : (
          <X size={12} />
        )}
      </span>
      <div className="gate-body">
        <b>{check.label}</b>
        <p>{check.detail}</p>
        {check.hint && <small>建议：{check.hint}</small>}
      </div>
    </div>
  );
}

const clarificationSchema = z.object({
  intent: z.string(),
  questions: z
    .array(
      z.object({
        id: z.string(),
        question: z.string(),
        hint: z.string().optional(),
      })
    )
    .min(1)
    .max(8),
});
const statusSchema = z.object({
  agent: z.string().optional(),
  stage: z.string().optional(),
  detail: z.string(),
  status: z
    .enum(["running", "failed", "done", "repaired", "fallback", "clarify"])
    .optional(),
});
const UNCHECKED_BUILD: BuildReport = {
  status: "pending",
  attempts: 1,
  repairApplied: false,
  logs: ["当前源码尚未进行构建验证。"],
};

export default function GameWorkspace() {
  const { user, isAuthenticated, loading: authLoading, logout } = useAuth();
  const capabilityQuery = useQuery({
    queryKey: ["app-capabilities"],
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/capabilities", {
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      });
      if (!response.ok) throw new Error("暂时无法确认在线功能。");
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error("暂时无法确认在线功能。");
      }
      const result = appCapabilitiesSchema.safeParse(body);
      if (!result.success) throw new Error("暂时无法确认在线功能。");
      return result.data;
    },
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
  const checkingCapabilities =
    capabilityQuery.isPending || capabilityQuery.isFetching;
  const capabilityResult = appCapabilitiesSchema.safeParse(
    capabilityQuery.data
  );
  const capabilities =
    !checkingCapabilities &&
    !capabilityQuery.isError &&
    capabilityResult.success
      ? capabilityResult.data
      : null;
  const canGenerate = Boolean(capabilities?.generation.configured);
  const canLogin = Boolean(
    capabilities?.authentication.configured && hasLoginConfiguration()
  );
  const canUseCloud = Boolean(
    capabilities?.cloudProjects.configured &&
      capabilities.authentication.configured &&
      (isAuthenticated || hasLoginConfiguration())
  );
  const unavailableMessage = checkingCapabilities
    ? "正在确认在线功能，请稍候。"
    : !capabilities
      ? "暂时无法确认在线功能，请重试。"
      : "此站点尚未开启这项在线功能。";
  const {
    workspace,
    workspaceRef,
    libraryRef,
    commitWorkspace,
    updateStoredDocument,
    flushDrafts,
    prepareLogin,
    storageStatus,
    ready,
  } = useWorkspaceDrafts(user?.id, authLoading);
  const {
    artifact,
    build,
    validation,
    trace,
    intent: intentText,
    messages,
    projectId: activeProjectId,
  } = workspace;
  const files = artifact?.files ?? [];
  const [prompt, setPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isLoadingProject, setIsLoadingProject] = useState(false);
  const [savingDocumentId, setSavingDocumentId] = useState<string | null>(null);
  const [status, setStatus] = useState("描述一个游戏创意");
  const [selectedPath, setSelectedPath] = useState("index.html");
  const [tab, setTab] = useState<DockTab>("run");
  const [previewMode, setPreviewMode] = useState<PreviewMode>("desktop");
  const [previewKey, setPreviewKey] = useState(0);
  const [clarifyQuestions, setClarifyQuestions] = useState<
    ClarifyQuestion[] | null
  >(null);
  const [clarifyIntent, setClarifyIntent] = useState("");
  const [clarifyAnswers, setClarifyAnswers] = useState<Record<string, string>>(
    {}
  );
  const [probe, setProbe] = useState<RuntimeProbeReport | null>(null);
  const [probeTimedOut, setProbeTimedOut] = useState(false);
  const [openTrace, setOpenTrace] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyPreview, setHistoryPreview] = useState<{
    artifact: GameArtifact;
    versionId: number;
    version: number;
  } | null>(null);
  const [changesOpen, setChangesOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [billingOpen, setBillingOpen] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const routeProjectRef = useRef(false);
  const savingRef = useRef(false);
  const taskRef = useRef<{
    context: TaskContext;
    controller: AbortController;
    messageId: string;
  } | null>(null);
  const clarifyRef = useRef<{
    prompt: string;
    mode: "generate" | "patch";
    answers: Record<string, string>;
    documentId: string;
  } | null>(null);
  const navigationRef = useRef(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const utils = trpc.useUtils();
  const projectsQuery = trpc.game.listProjects.useQuery(undefined, {
    enabled: isAuthenticated && canUseCloud,
  });
  const versionsQuery = trpc.game.versions.useQuery(
    { projectId: activeProjectId ?? -1, cursor: historyCursor ?? undefined },
    {
      enabled: Boolean(
        activeProjectId && isAuthenticated && canUseCloud && historyOpen
      ),
    }
  );
  const createProject = trpc.game.createProject.useMutation();
  const saveVersion = trpc.game.saveVersion.useMutation();
  const loadVersion = trpc.game.loadVersion.useMutation();
  const downloadVersion = trpc.game.downloadVersion.useMutation();
  const displayedArtifact = historyPreview?.artifact ?? artifact;
  const displayedFiles = displayedArtifact?.files ?? [];
  const gameDesign = useMemo(
    () => readGameDesign(displayedFiles),
    [displayedArtifact]
  );
  const selectedFile =
    displayedFiles.find(file => file.path === selectedPath) ??
    displayedFiles[0];
  const previewRunId = useMemo(
    () => crypto.randomUUID(),
    [workspace.documentId, workspace.revision, previewKey, historyPreview]
  );
  const sandbox = useMemo(
    () => createGameSandbox(displayedArtifact, previewRunId),
    [displayedArtifact, previewRunId]
  );
  const changes = summarizeChanges(
    workspace.undo.at(-1)?.artifact ?? null,
    artifact
  );
  const isSaving = savingDocumentId !== null;
  const busy = !ready || isGenerating || isLoadingProject || isSaving;
  const canPatch = Boolean(artifact?.files.length);
  const currentValidation = historyPreview ? null : validation;
  const logs = historyPreview
    ? ["正在只读预览历史版本，当前草稿已保留。"]
    : (build?.logs ?? [
        "当前草稿尚未验证。",
        "编辑后自动刷新预览，静态检查需要重新执行。",
      ]);

  function setMessages(
    next: (current: WorkspaceState["messages"]) => WorkspaceState["messages"]
  ) {
    commitWorkspace(current => ({
      ...current,
      messages: next(current.messages),
    }));
  }

  function cancelTask() {
    const task = taskRef.current;
    taskRef.current = null;
    task?.controller.abort();
    setIsGenerating(false);
    if (task && workspaceRef.current.documentId === task.context.documentId) {
      setMessages(current =>
        current.map(message =>
          message.id === task.messageId
            ? {
                ...message,
                content:
                  `${message.content}\n\n创作已停止，原有草稿已保留。`.trim(),
              }
            : message
        )
      );
      setStatus("创作已停止 · 草稿已保留");
    }
  }

  function clearTransient() {
    cancelTask();
    clarifyRef.current = null;
    setClarifyQuestions(null);
    setClarifyAnswers({});
    setClarifyIntent("");
    setHistoryPreview(null);
    setProbe(null);
    setOpenTrace(null);
    setPrompt("");
    setSelectedPath("index.html");
    setChangesOpen(false);
    setHistoryCursor(null);
    setPublishOpen(false);
  }

  useEffect(
    () => () => {
      taskRef.current?.controller.abort();
      taskRef.current = null;
      navigationRef.current += 1;
    },
    []
  );
  useEffect(() => {
    if (!ready || !isAuthenticated || !canUseCloud || routeProjectRef.current)
      return;
    routeProjectRef.current = true;
    const projectId = Number(
      new URLSearchParams(window.location.search).get("project")
    );
    if (Number.isSafeInteger(projectId) && projectId > 0)
      void selectProject(projectId);
  }, [ready, isAuthenticated, canUseCloud]);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages]);
  useEffect(() => {
    setProbe(null);
    setProbeTimedOut(false);
    const timeout = setTimeout(() => setProbeTimedOut(true), 8000);
    return () => clearTimeout(timeout);
  }, [previewRunId]);
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (
        event.source !== iframeRef.current?.contentWindow ||
        !isProbeMessage(event.data) ||
        event.data.runId !== previewRunId
      )
        return;
      setProbe(event.data.report);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [previewRunId]);

  function signIn() {
    if (!canLogin)
      return toast.info(
        capabilities
          ? "此站点尚未开启账号登录。你可以继续使用本地草稿。"
          : unavailableMessage
      );
    prepareLogin();
    startLogin();
  }

  async function persist(
    snapshot: WorkspaceState,
    assistantMessage?: string,
    userPrompt?: string,
    validationReceipt?: string
  ) {
    if (!snapshot.artifact) return null;
    if (!canUseCloud) {
      flushDrafts();
      setStatus("云端保存暂不可用 · 本地草稿已保留");
      return null;
    }
    if (!isAuthenticated) {
      setStatus("草稿已保存在此浏览器 · 登录后可保存项目版本");
      return null;
    }
    if (savingRef.current) throw new Error("已有版本正在保存，请稍后重试。");
    savingRef.current = true;
    setSavingDocumentId(snapshot.documentId);
    let target = snapshot;
    try {
      if (!target.projectId) {
        const project = await createProject.mutateAsync({
          name: target.artifact!.title,
          description: target.artifact!.description,
        });
        target = { ...target, projectId: project.id };
        const current = libraryRef.current.documents[target.documentId];
        if (current)
          updateStoredDocument({ ...current, projectId: project.id });
        await utils.game.listProjects.invalidate();
      }
      const context: TaskContext = {
        documentId: target.documentId,
        projectId: target.projectId,
        baseVersionId: target.baseVersionId,
        revision: target.revision,
        runId: crypto.randomUUID(),
      };
      const saved = await saveVersion.mutateAsync({
        projectId: target.projectId!,
        artifact: target.artifact!,
        build: target.build ?? UNCHECKED_BUILD,
        baseVersionId: target.baseVersionId,
        requestId: context.runId,
        assistantMessage,
        userPrompt,
        validationReceipt,
      });
      const current = libraryRef.current.documents[target.documentId];
      if (current)
        updateStoredDocument(
          acknowledgeSave(current, context, saved.projectVersionId)
        );
      await Promise.all([
        utils.game.versions.invalidate({ projectId: target.projectId! }),
        utils.game.listProjects.invalidate(),
      ]);
      if (workspaceRef.current.documentId === target.documentId)
        setStatus(
          `版本 v${saved.version} 已保存${workspaceRef.current.dirty ? " · 后续编辑仍未保存" : ""}`
        );
      toast.success(`版本 v${saved.version} 已保存`);
      flushDrafts();
      return saved;
    } catch (error) {
      if (workspaceRef.current.documentId === target.documentId)
        setStatus("项目保存失败 · 本地草稿已保留");
      throw error;
    } finally {
      savingRef.current = false;
      setSavingDocumentId(null);
    }
  }

  async function startGeneration(
    request: string,
    mode: "generate" | "patch",
    answers: Record<string, string> = {},
    answerMessage?: string
  ) {
    request = request.trim();
    if (!request || busy || taskRef.current) return;
    if (!canGenerate)
      return toast.info(
        capabilities
          ? "此站点尚未开启 AI 创作。已有草稿可继续编辑、试玩和下载。"
          : unavailableMessage
      );
    if (request.length > 2000)
      return toast.info("请将每次创作或修改描述控制在 2000 字以内。");
    if (historyPreview) return toast.info("请先返回当前草稿，再继续修改。");
    const source = workspaceRef.current;
    const context: TaskContext = {
      documentId: source.documentId,
      projectId: source.projectId,
      baseVersionId: source.baseVersionId,
      revision: source.revision,
      runId: crypto.randomUUID(),
    };
    const controller = new AbortController();
    const messageId = `ai-${context.runId}`;
    taskRef.current = { context, controller, messageId };
    clarifyRef.current = {
      prompt: request,
      mode,
      answers,
      documentId: source.documentId,
    };
    setMessages(current => [
      ...current,
      {
        id: `user-${context.runId}`,
        role: "user",
        content: answerMessage ?? request,
      },
      { id: messageId, role: "assistant", content: "" },
    ]);
    commitWorkspace(current => ({ ...current, trace: [] }));
    setPrompt("");
    setIsGenerating(true);
    setClarifyQuestions(null);
    setClarifyAnswers({});
    setStatus(
      mode === "patch" ? "正在理解修改并更新游戏…" : "正在理解你的游戏创意…"
    );
    let completed: FreeGenResult | null = null;
    let applied: WorkspaceState | null = null;
    try {
      await readGameStream(
        {
          mode,
          prompt: request,
          answers,
          existing: mode === "patch" ? source.artifact?.files : undefined,
          artifact: mode === "patch" ? source.artifact : undefined,
          projectId: context.projectId,
          baseVersionId: context.baseVersionId,
          runId: context.runId,
        },
        controller.signal,
        event => {
          if (
            taskRef.current?.context.runId !== context.runId ||
            !isCurrentTask(workspaceRef.current, context)
          )
            return;
          if (event.event === "status") {
            const step = statusSchema.parse(event.data);
            setStatus(`${step.agent ?? step.stage ?? "创作"} · ${step.detail}`);
            if (step.agent && step.status)
              commitWorkspace(current => ({
                ...current,
                trace: [...current.trace, step as TraceStep],
              }));
          } else if (event.event === "token") {
            const token = z.string().parse(event.data);
            setMessages(current =>
              current.map(message =>
                message.id === messageId
                  ? { ...message, content: message.content + token }
                  : message
              )
            );
          } else if (event.event === "clarify") {
            const clarification = clarificationSchema.parse(event.data);
            setClarifyQuestions(clarification.questions);
            setClarifyIntent(clarification.intent);
            setStatus("请确认细节后继续创作");
            setMessages(current =>
              current.map(message =>
                message.id === messageId
                  ? {
                      ...message,
                      content: message.content || "创作前请确认几个细节：",
                    }
                  : message
              )
            );
          } else if (event.event === "complete") {
            completed = resultSchema.parse(event.data) as FreeGenResult;
            applied = applyGeneratedResult(workspaceRef.current, completed);
            applied.messages = applied.messages.map(message =>
              message.id === messageId
                ? { ...message, content: completed!.assistantMessage }
                : message
            );
            commitWorkspace(applied);
            setSelectedPath("index.html");
            setTab("run");
            setChangesOpen(mode === "patch");
            setStatus(
              completed.build.status === "failed"
                ? "已生成草稿 · 检查发现问题，请查看 QA"
                : completed.build.status === "pending"
                  ? "草稿已生成 · 等待实际运行验证"
                  : "静态检查通过 · 预览已更新"
            );
            clarifyRef.current = null;
          } else if (event.event === "error") {
            const data = z.object({ message: z.string() }).parse(event.data);
            throw new Error(data.message);
          }
        }
      );
      if (
        completed &&
        applied &&
        taskRef.current?.context.runId === context.runId
      ) {
        try {
          await persist(
            applied,
            (completed as FreeGenResult).assistantMessage,
            request
          );
        } catch (error) {
          toast.error(
            error instanceof Error ? error.message : "保存失败，草稿已保留。"
          );
        }
      }
    } catch (error) {
      if (taskRef.current?.context.runId !== context.runId) return;
      const cancelled =
        controller.signal.aborted || (error as Error).name === "AbortError";
      const text = cancelled
        ? "创作已停止，草稿已保留。"
        : error instanceof Error
          ? error.message
          : "创作失败，请重试。";
      setMessages(current =>
        current.map(message =>
          message.id === messageId ? { ...message, content: text } : message
        )
      );
      setStatus(cancelled ? "创作已停止" : "创作失败 · 原有草稿已保留");
      if (!cancelled) toast.error(text);
    } finally {
      if (taskRef.current?.context.runId === context.runId) {
        taskRef.current = null;
        setIsGenerating(false);
      }
    }
  }

  function handleSend(forcedPrompt?: string) {
    clarifyRef.current = null;
    void startGeneration(
      forcedPrompt ?? prompt,
      forcedPrompt ? "generate" : canPatch ? "patch" : "generate"
    );
  }
  function submitClarifyAnswers() {
    const pending = clarifyRef.current;
    if (
      !pending ||
      pending.documentId !== workspaceRef.current.documentId ||
      busy
    )
      return;
    const filled = Object.fromEntries(
      Object.entries(clarifyAnswers).filter(([, value]) => value.trim())
    );
    if (!Object.keys(filled).length) return toast.info("请至少回答一个问题。");
    void startGeneration(
      pending.prompt,
      pending.mode,
      { ...pending.answers, ...filled },
      clarifyQuestions
        ?.filter(question => filled[question.id])
        .map(question => `${question.question}\n${filled[question.id]}`)
        .join("\n\n")
    );
  }
  function cancelClarify() {
    clarifyRef.current = null;
    setClarifyQuestions(null);
    setClarifyAnswers({});
    setStatus("已取消 · 可以重新描述游戏创意");
  }

  function newGame() {
    navigationRef.current += 1;
    clearTransient();
    setIsLoadingProject(false);
    commitWorkspace(emptyWorkspace(crypto.randomUUID()));
    setTab("run");
    setStatus("新游戏草稿已就绪 · 可从历史面板恢复原有草稿");
  }

  function openExample() {
    if (busy) return;
    flushDrafts();
    navigationRef.current += 1;
    clearTransient();
    setIsLoadingProject(false);
    setHistoryOpen(false);
    const document = emptyWorkspace(crypto.randomUUID());
    commitWorkspace({
      ...document,
      artifact: createExampleArtifact(),
      build: UNCHECKED_BUILD,
      revision: 1,
      dirty: true,
      lastChange: "manual",
      intent: "试玩和编辑预置的接苹果示例。",
      messages: [
        {
          id: `${document.documentId}-example`,
          role: "system",
          content:
            "预置示例 · 无需模型服务。这是随工作台提供的本地游戏，没有调用 AI 生成。可以试玩、编辑源码并下载 ZIP；你的其他草稿仍保留在历史面板。",
        },
      ],
    });
    flushDrafts();
    setTab("run");
    setStatus("预置示例已打开 · 无需模型服务 · 可编辑、试玩和下载");
  }

  function selectLocalDraft(documentId: string) {
    const document = libraryRef.current.documents[documentId];
    if (!document) return;
    navigationRef.current += 1;
    clearTransient();
    setIsLoadingProject(false);
    commitWorkspace(document);
    setStatus("已恢复所选本地草稿");
  }

  async function saveForPublish(receipt: string) {
    const snapshot = workspaceRef.current;
    if (!snapshot.dirty && snapshot.baseVersionId)
      return snapshot.baseVersionId;
    const saved = await persist(
      snapshot,
      "保存经过浏览器验证的发布版本",
      undefined,
      receipt
    );
    return saved?.projectVersionId ?? null;
  }

  async function selectProject(projectId: number) {
    if (!canUseCloud) return toast.info(unavailableMessage);
    const navigation = ++navigationRef.current;
    clearTransient();
    setHistoryOpen(false);
    const cached = Object.values(libraryRef.current.documents).find(
      document => document.projectId === projectId
    );
    const target = cached ?? emptyWorkspace(crypto.randomUUID(), projectId);
    commitWorkspace(target);
    setIsLoadingProject(false);
    if (target.dirty && target.artifact) {
      setStatus("已恢复该项目的未保存草稿");
      return;
    }
    setIsLoadingProject(true);
    setStatus("正在加载项目最新版本…");
    try {
      const latest = await utils.game.latestVersion.fetch({ projectId });
      if (
        navigation !== navigationRef.current ||
        workspaceRef.current.documentId !== target.documentId
      )
        return;
      if (!latest) {
        setStatus("项目还没有版本 · 描述游戏开始创作");
        return;
      }
      const loadedArtifact = {
        ...(latest.artifact ?? {
          title: `游戏 v${latest.version.version}`,
          description: "",
          controls: [],
        }),
        files: latest.files,
      } as GameArtifact;
      const next = {
        ...target,
        artifact: loadedArtifact,
        build: latest.build ?? null,
        baseVersionId: latest.version.id,
        revision: target.revision + 1,
        savedRevision: target.revision + 1,
        dirty: false,
        validation: null,
        trace: [],
        undo: [],
        lastChange: null,
      } satisfies WorkspaceState;
      commitWorkspace(next);
      setStatus(`已加载项目最新版本 v${latest.version.version}`);
    } catch (error) {
      if (navigation === navigationRef.current) {
        setStatus("项目加载失败 · 可以重试切换项目");
        toast.error(error instanceof Error ? error.message : "项目加载失败。");
      }
    } finally {
      if (navigation === navigationRef.current) setIsLoadingProject(false);
    }
  }

  async function createEmptyProject() {
    if (!canUseCloud) return toast.info(unavailableMessage);
    if (!isAuthenticated) return signIn();
    newGame();
    const documentId = workspaceRef.current.documentId;
    setIsLoadingProject(true);
    try {
      const project = await createProject.mutateAsync({
        name: "Untitled game",
        description: "A new AI game project",
      });
      const document = libraryRef.current.documents[documentId];
      if (document)
        updateStoredDocument({ ...document, projectId: project.id });
      await utils.game.listProjects.invalidate();
      if (workspaceRef.current.documentId === documentId)
        setStatus("项目已创建 · 描述游戏开始创作");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "项目创建失败。");
    } finally {
      if (workspaceRef.current.documentId === documentId)
        setIsLoadingProject(false);
    }
  }

  async function saveFile() {
    if (!artifact || busy || historyPreview) return;
    if (!canUseCloud) {
      flushDrafts();
      return toast.info("云端保存暂不可用，本地草稿已保留。");
    }
    if (!isAuthenticated) {
      flushDrafts();
      toast.info("本地草稿已保留，登录后可保存云端版本。");
      signIn();
      return;
    }
    try {
      await persist(
        workspaceRef.current,
        `保存编辑：${selectedFile?.path ?? "游戏草稿"}`
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败。");
    }
  }

  function updateFile(content: string) {
    if (!selectedFile || busy || historyPreview) return;
    commitWorkspace(current =>
      editWorkspaceFile(current, selectedFile.path, content)
    );
    setStatus(`已编辑 ${selectedFile.path} · 预览已更新，质量检查需重新运行`);
  }
  function updateParameter(path: string, content: string) {
    if (busy || historyPreview) return;
    commitWorkspace(current => editWorkspaceFile(current, path, content));
    setStatus("游戏参数已更新 · 预览已刷新，保存后生成新版本");
  }
  function undoChange() {
    if (busy || historyPreview) return;
    commitWorkspace(undoWorkspaceChange);
    setStatus("已撤回上一次修改 · 保存后生成新版本");
  }
  function restartPreview() {
    setPreviewKey(key => key + 1);
    setStatus("已重新运行当前草稿");
  }
  async function downloadZip() {
    if (!displayedArtifact) return toast.info("请先生成游戏。");
    try {
      const snapshot = displayedArtifact;
      const playable = bundleGameArtifact(snapshot).html;
      const zip = new JSZip();
      snapshot.files.forEach(file => zip.file(file.path, file.content));
      zip.file("__arcane__/play.html", playable);
      zip.file("__arcane__/artifact.json", JSON.stringify(snapshot, null, 2));
      zip.file(
        "__arcane__/README.txt",
        "ARCANE game export\n\n解压后打开 __arcane__/play.html 即可离线试玩。\n根目录保留原始源码，__arcane__/artifact.json 保存完整游戏文档。\n修改源码后需重新打包 play.html，或使用本地 HTTP 服务运行源码。\n"
      );
      const output = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(output);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${
        snapshot.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "game-project"
      }.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success("游戏源码与离线试玩入口已下载");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "下载失败。");
    }
  }

  async function loadHistoricalVersion(versionId: number, restore: boolean) {
    if (!canUseCloud) return toast.info(unavailableMessage);
    const source = workspaceRef.current;
    if (!source.projectId || busy) return;
    const navigation = navigationRef.current;
    setIsLoadingProject(true);
    try {
      const data = await loadVersion.mutateAsync({
        projectId: source.projectId,
        versionId,
      });
      if (
        navigation !== navigationRef.current ||
        workspaceRef.current.documentId !== source.documentId
      )
        return;
      const historical = {
        ...(data.artifact ?? {
          title: `游戏 v${data.version.version}`,
          description: "",
          controls: [],
        }),
        files: data.files,
      } as GameArtifact;
      if (!restore) {
        setHistoryPreview({
          artifact: historical,
          versionId,
          version: data.version.version,
        });
        setStatus(`正在只读预览 v${data.version.version} · 当前草稿已保留`);
        return;
      }
      const restored = applyGeneratedResult(source, {
        artifact: historical,
        build: data.build ?? UNCHECKED_BUILD,
        trace: [],
        assistantMessage: `恢复 v${data.version.version}`,
      });
      // Do not replace the current draft until the server has confirmed the restored version.
      const saved = await persist(
        restored,
        `恢复 v${data.version.version} 为新版本`
      );
      if (
        !saved ||
        navigation !== navigationRef.current ||
        workspaceRef.current.documentId !== source.documentId
      )
        return;
      commitWorkspace({
        ...restored,
        baseVersionId: saved.projectVersionId,
        savedRevision: restored.revision,
        dirty: false,
      });
      setHistoryPreview(null);
      setStatus(`已恢复 v${data.version.version} 并保存为 v${saved.version}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "历史版本加载失败。"
      );
    } finally {
      if (navigation === navigationRef.current) setIsLoadingProject(false);
    }
  }
  async function downloadSavedVersion(versionId: number) {
    if (!canUseCloud) return toast.info(unavailableMessage);
    if (!activeProjectId) return;
    try {
      const archive = await downloadVersion.mutateAsync({
        projectId: activeProjectId,
        versionId,
      });
      const link = document.createElement("a");
      link.href = archive.url;
      link.download = archive.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "下载失败。");
    }
  }

  return (
    <div
      className={`builder-shell ${displayedArtifact ? "is-project" : "is-empty"} mode-${tab}`}
    >
      <header className="app-header">
        <a href="/" className="brand" aria-label="ARCANE 首页">
          <span className="brand-orb brand-logo-frame">
            <img src={BRAND_LOGO} alt="" />
          </span>
          <strong>
            arcane<span className="brand-period">.</span>
          </strong>
          <small>游戏创作空间</small>
        </a>
        <div className="header-actions">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={openExample}
            title="预置示例 · 无需模型服务"
          >
            <Gamepad2 size={15} />
            <span>体验示例</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setBillingOpen(true)}
          >
            <Sparkles size={15} />
            <span>创作额度</span>
          </Button>
          {authLoading ? (
            <Loader2 className="animate-spin" size={17} />
          ) : isAuthenticated ? (
            <button
              className="user-chip"
              title="退出登录"
              onClick={() => {
                flushDrafts();
                void logout();
              }}
            >
              <UserRound size={14} />
              {user?.name ?? "Creator"}
            </button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={signIn}
              disabled={!canLogin}
            >
              登录
            </Button>
          )}
          <Button size="sm" className="new-game" onClick={newGame}>
            <Plus size={15} />
            <span>New Game</span>
          </Button>
        </div>
      </header>
      <div className="studio-body">
        <aside className="studio-rail" aria-label="主导航">
          <div className="rail-main">
            <button
              className="rail-item active"
              onClick={() => {
                setTab("run");
                document
                  .querySelector(".composer textarea")
                  ?.scrollIntoView({ block: "nearest" });
              }}
              title="创作工作台"
            >
              <Sparkles size={19} />
              <span>创作</span>
            </button>
            <a className="rail-item" href="/explore" title="探索游戏">
              <Gamepad2 size={19} />
              <span>探索</span>
            </a>
            <button
              className={`rail-item ${historyOpen ? "open" : ""}`}
              onClick={() => setHistoryOpen(value => !value)}
              title="历史"
            >
              <History size={19} />
              <span>历史</span>
            </button>
          </div>
          <div className="rail-bottom">
            <span className="rail-monogram">a.</span>
            <small>MAKE / PLAY</small>
          </div>
        </aside>
        <div className="studio-main">
          {(!canGenerate || !canLogin || !canUseCloud) && (
            <section
              className="capability-notice"
              aria-label="站点功能状态"
              role="status"
            >
              <div>
                <strong>
                  {checkingCapabilities
                    ? "正在确认在线功能"
                    : !capabilities
                      ? "暂时无法确认在线功能"
                      : "本地工作台可用"}
                </strong>
                <p>
                  {!capabilities
                    ? "在线功能确认后才能使用。已有草稿仍可编辑、试玩和下载。"
                    : [
                        !canGenerate && "AI 创作尚未开启",
                        !canLogin && "账号登录尚未开启",
                        !canUseCloud && "云端项目暂不可用",
                      ]
                        .filter(Boolean)
                        .join("；") + "。已有草稿可继续编辑、试玩和下载。"}
                </p>
              </div>
              <div className="capability-actions">
                {!capabilities && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={checkingCapabilities}
                    onClick={() => void capabilityQuery.refetch()}
                  >
                    重新检查
                  </Button>
                )}
                <a
                  href="https://github.com/hsiaozzz/fly#本地开发"
                  target="_blank"
                  rel="noreferrer"
                >
                  站点设置帮助
                </a>
              </div>
            </section>
          )}
          {!displayedArtifact && (
            <div className="home-project-access">
              <span>云端项目</span>
              <ProjectPicker
                projects={(projectsQuery.data ?? []).map(project => ({
                  id: project.id,
                  name: project.name,
                }))}
                activeProjectId={activeProjectId}
                onNew={() => void createEmptyProject()}
                onSelect={id => void selectProject(id)}
                cloudEnabled={canUseCloud}
              />
            </div>
          )}
          {displayedArtifact && (
            <div className="project-heading">
              <div className="project-heading-info">
                <p className="eyebrow">我的创作</p>
                <ProjectPicker
                  projects={(projectsQuery.data ?? []).map(project => ({
                    id: project.id,
                    name: project.name,
                  }))}
                  activeProjectId={activeProjectId}
                  onNew={() => void createEmptyProject()}
                  onSelect={id => void selectProject(id)}
                  cloudEnabled={canUseCloud}
                />
              </div>
              <div className="project-heading-actions">
                <span className="project-save-state">
                  <span className="status-dot" />
                  {historyPreview
                    ? `历史 v${historyPreview.version}`
                    : workspace.dirty
                      ? "本地草稿"
                      : "已保存版本"}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={saveFile}
                  disabled={
                    !artifact || busy || Boolean(historyPreview) || !canUseCloud
                  }
                  aria-label="保存当前版本"
                >
                  <Save size={14} />
                  保存
                </Button>
                <Button
                  size="sm"
                  disabled={!canUseCloud}
                  onClick={() => setPublishOpen(value => !value)}
                >
                  <ShieldCheck size={15} />
                  发布
                </Button>
              </div>
            </div>
          )}
          {publishOpen && (
            <GamePublishPanel
              artifact={artifact}
              userId={user?.id}
              disabled={busy || Boolean(historyPreview) || !canUseCloud}
              loginEnabled={canLogin}
              onSave={saveForPublish}
              onSignIn={signIn}
              onClose={() => setPublishOpen(false)}
            />
          )}
          {historyOpen && (
            <section className="history-panel" aria-label="项目版本历史">
              <div className="history-heading">
                <strong>项目历史</strong>
                <span>
                  {workspace.dirty
                    ? "当前草稿尚未保存为项目版本"
                    : "当前草稿已保存"}
                </span>
                <Button
                  size="sm"
                  onClick={saveFile}
                  disabled={
                    !artifact || busy || Boolean(historyPreview) || !canUseCloud
                  }
                >
                  <Save size={14} />
                  保存版本
                </Button>
                <button
                  aria-label="关闭历史"
                  onClick={() => setHistoryOpen(false)}
                >
                  <X size={16} />
                </button>
              </div>
              {!canUseCloud ? (
                <p>云端版本暂不可用。你可以从下方继续打开本地草稿。</p>
              ) : !isAuthenticated ? (
                <p>
                  登录后可保存、预览和恢复项目版本。
                  <button onClick={signIn} disabled={!canLogin}>
                    登录
                  </button>
                </p>
              ) : !activeProjectId ? (
                <p>保存当前草稿后自动创建项目。也可以从项目菜单创建新项目。</p>
              ) : versionsQuery.isLoading ? (
                <p>正在加载版本…</p>
              ) : versionsQuery.error ? (
                <p>
                  历史加载失败。
                  <button onClick={() => void versionsQuery.refetch()}>
                    重试
                  </button>
                </p>
              ) : !versionsQuery.data?.items.length ? (
                <p>项目还没有已保存版本。</p>
              ) : (
                <div className="version-list">
                  {versionsQuery.data.items.map(version => (
                    <div key={version.id} className="version-entry">
                      <div>
                        <strong>v{version.version}</strong>
                        <small>
                          {new Date(version.createdAt).toLocaleString()}
                        </small>
                      </div>
                      <div className="version-actions">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void loadHistoricalVersion(version.id, false)
                          }
                        >
                          预览
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void loadHistoricalVersion(version.id, true)
                          }
                        >
                          恢复为新版本
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void downloadSavedVersion(version.id)}
                        >
                          <Download size={13} />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {activeProjectId && canUseCloud && (
                <div className="history-pagination">
                  <button
                    className="history-refresh"
                    onClick={() => {
                      setHistoryCursor(null);
                      void versionsQuery.refetch();
                    }}
                  >
                    最新版本
                  </button>
                  {versionsQuery.data?.nextCursor && (
                    <button
                      className="history-refresh"
                      onClick={() =>
                        setHistoryCursor(versionsQuery.data!.nextCursor)
                      }
                    >
                      更早版本
                    </button>
                  )}
                </div>
              )}
              <div className="local-drafts">
                <strong>本地草稿</strong>
                {Object.values(libraryRef.current.documents)
                  .filter(
                    document =>
                      document.artifact ||
                      document.documentId === workspace.documentId
                  )
                  .map(document => (
                    <button
                      className={
                        document.documentId === workspace.documentId
                          ? "active"
                          : ""
                      }
                      key={document.documentId}
                      onClick={() => selectLocalDraft(document.documentId)}
                    >
                      {document.artifact?.title ?? "新游戏"}
                      {document.dirty ? " · 未保存" : ""}
                    </button>
                  ))}
              </div>
            </section>
          )}
          {historyPreview && (
            <div className="history-preview-banner">
              正在只读预览 v{historyPreview.version} ·
              编辑器、预览和下载均指向此历史版本
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setHistoryPreview(null);
                  setStatus("已返回当前草稿");
                }}
              >
                返回当前草稿
              </Button>
              <Button
                size="sm"
                disabled={busy || !canUseCloud}
                onClick={() =>
                  void loadHistoricalVersion(historyPreview.versionId, true)
                }
              >
                恢复为新版本
              </Button>
            </div>
          )}
          {displayedArtifact && (
            <nav className="dock-tabs workspace-modes" aria-label="工作区模式">
              <button
                className={tab === "run" ? "selected" : ""}
                onClick={() => setTab("run")}
                aria-pressed={tab === "run"}
              >
                <Play size={15} />
                试玩
              </button>

              <button
                className={tab === "files" ? "selected" : ""}
                aria-pressed={tab === "files"}
                onClick={() => setTab("files")}
              >
                <Code2 size={15} />
                Files <span>{displayedFiles.length || "—"}</span>
              </button>
              <button
                className={tab === "console" ? "selected" : ""}
                aria-pressed={tab === "console"}
                onClick={() => setTab("console")}
              >
                <Terminal size={15} />
                Console{" "}
                {build?.status === "passed" && !historyPreview && (
                  <i className="pass-dot" />
                )}
              </button>
              <button
                className={tab === "spec" ? "selected" : ""}
                aria-pressed={tab === "spec"}
                onClick={() => setTab("spec")}
              >
                <PanelBottom size={15} />
                游戏文档
              </button>
              <button
                className={tab === "parameters" ? "selected" : ""}
                aria-pressed={tab === "parameters"}
                onClick={() => setTab("parameters")}
              >
                <Wrench size={15} />
                参数
              </button>
              <button
                className={tab === "gates" ? "selected" : ""}
                aria-pressed={tab === "gates"}
                onClick={() => setTab("gates")}
              >
                <ShieldCheck size={15} />
                QA
                {currentValidation?.failures.length ||
                probe?.checks.some(check => check.status === "fail") ? (
                  <i className="qa-dot bad" />
                ) : currentValidation || probe ? (
                  <i className="qa-dot ok" />
                ) : null}
              </button>
              <span className="dock-spacer" />
              <button
                onClick={undoChange}
                disabled={
                  !workspace.undo.length || busy || Boolean(historyPreview)
                }
                title="撤回上一次修改"
              >
                <Undo2 size={15} />
                撤回
              </button>
              <button
                onClick={() => setChangesOpen(value => !value)}
                disabled={!artifact}
              >
                修改摘要
              </button>
              <button
                className="download-button"
                onClick={() => void downloadZip()}
                disabled={!displayedArtifact}
              >
                <Download size={15} />
                Download ZIP
              </button>
            </nav>
          )}
          <main
            className="workbench"
            aria-label={displayedArtifact ? "游戏创作工作台" : "开始游戏创作"}
          >
            <section className="chat-panel">
              {!displayedArtifact ? (
                <div className="home-heading">
                  <span className="home-kicker">
                    <Sparkles size={15} /> 从一个想法开始
                  </span>
                  <h1>
                    你的下一个游戏，
                    <br />
                    <em>由你想象。</em>
                  </h1>
                  <p>描述你想玩的世界，把它变成可以试玩、修改和分享的游戏。</p>
                </div>
              ) : (
                <div className="panel-top">
                  <div>
                    <span className="eyebrow">创作助手</span>
                    <h2>让想法继续生长</h2>
                  </div>
                  <span className="draft-badge">
                    {workspace.dirty ? "未保存" : "已保存"}
                  </span>
                </div>
              )}
              <div className="agent-status" role="status">
                <span
                  className={isGenerating ? "status-dot busy" : "status-dot"}
                />
                {status}
              </div>
              <div className="draft-storage" title={storageStatus}>
                {storageStatus}
              </div>
              {intentText && (
                <div className="intent-card">
                  <Sparkles size={13} />
                  <span>
                    <b>已理解：</b>
                    {intentText}
                  </span>
                </div>
              )}
              <div className="messages" aria-label="创作记录">
                {messages
                  .filter(
                    message =>
                      displayedArtifact || !message.id.endsWith("-intro")
                  )
                  .map(message => (
                    <article
                      key={message.id}
                      className={`message ${message.role}`}
                    >
                      <div className="avatar">
                        {message.role === "user" ? (
                          <UserRound size={15} />
                        ) : message.role === "system" ? (
                          <Gamepad2 size={16} />
                        ) : (
                          <Bot size={16} />
                        )}
                      </div>
                      <div className="bubble">
                        {message.role === "assistant" ? (
                          <ChatMarkdown>
                            {message.content || "正在思考…"}
                          </ChatMarkdown>
                        ) : (
                          message.content
                        )}
                      </div>
                    </article>
                  ))}
                <div ref={messagesEndRef} />
              </div>
              {trace.length > 0 && (
                <div className="trace-panel">
                  <div className="trace-head">
                    <Wrench size={12} />
                    创作进度
                  </div>
                  {trace.map((step, index) => {
                    const hasChecks = Boolean(step.checks?.length);
                    const failed =
                      step.checks?.filter(check => check.status === "fail")
                        .length ?? 0;
                    const warned =
                      step.checks?.filter(check => check.status === "warn")
                        .length ?? 0;
                    return (
                      <div
                        key={`${step.agent}-${index}`}
                        className={`trace-step ${step.status}`}
                      >
                        <button
                          className="trace-row"
                          onClick={() =>
                            hasChecks &&
                            setOpenTrace(openTrace === index ? null : index)
                          }
                          disabled={!hasChecks}
                        >
                          <span className="trace-mark">
                            {step.status === "repaired" ? (
                              <Wrench size={11} />
                            ) : step.status === "running" ? (
                              <Loader2 size={11} className="animate-spin" />
                            ) : step.status === "fallback" ||
                              step.status === "failed" ? (
                              <X size={11} />
                            ) : (
                              <Check size={11} />
                            )}
                          </span>
                          <b>{step.agent}</b>
                          <span className="trace-detail">{step.detail}</span>
                          {hasChecks && (
                            <span
                              className={`trace-badge ${failed ? "bad" : warned ? "soft" : "good"}`}
                            >
                              {failed
                                ? `${failed} 项未过`
                                : warned
                                  ? `${warned} 项建议`
                                  : "检查通过"}
                            </span>
                          )}
                        </button>
                        {hasChecks && openTrace === index && (
                          <div className="trace-checks">
                            {step.checks!.map(check => (
                              <GateRow key={check.name} check={check} />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {clarifyQuestions && (
                <div className="clarify-card">
                  <div className="clarify-head">
                    <Sparkles size={15} />
                    创作前确认 · {clarifyIntent}
                  </div>
                  {clarifyQuestions.map(question => (
                    <div key={question.id} className="clarify-item">
                      <label htmlFor={`clarify-${question.id}`}>
                        {question.question}
                      </label>
                      {question.hint && <small>{question.hint}</small>}
                      <Textarea
                        id={`clarify-${question.id}`}
                        rows={2}
                        value={clarifyAnswers[question.id] ?? ""}
                        onChange={event =>
                          setClarifyAnswers(current => ({
                            ...current,
                            [question.id]: event.target.value,
                          }))
                        }
                      />
                    </div>
                  ))}
                  <div className="clarify-actions">
                    <Button variant="ghost" size="sm" onClick={cancelClarify}>
                      取消
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy || !canGenerate}
                      onClick={submitClarifyAnswers}
                    >
                      按此创作
                    </Button>
                  </div>
                </div>
              )}
              {!artifact && (
                <div className="suggestions">
                  <button
                    disabled={busy || !canGenerate}
                    onClick={() => handleSend(SAMPLE_PROMPT)}
                  >
                    跑酷吃金币
                  </button>
                  <button
                    disabled={busy || !canGenerate}
                    onClick={() =>
                      handleSend(
                        "做一个竖屏太空射击游戏，飞船左右移动发射激光消灭小行星，有血条"
                      )
                    }
                  >
                    太空射击
                  </button>
                  <button
                    disabled={busy || !canGenerate}
                    onClick={() =>
                      handleSend("做一个记忆翻牌小游戏，点击卡片配对")
                    }
                  >
                    记忆翻牌
                  </button>
                </div>
              )}
              {artifact && (
                <div className="suggestions">
                  <button
                    disabled={busy || Boolean(historyPreview)}
                    onClick={() =>
                      setPrompt(
                        "保持玩法和美术不变，让移动和跳跃手感更流畅，修复不合理的碰撞。"
                      )
                    }
                  >
                    改善手感
                  </button>
                  <button
                    disabled={busy || Boolean(historyPreview)}
                    onClick={() =>
                      setPrompt(
                        "保持当前游戏和美术，降低前期难度，让新手更容易理解操作，增加逐步难度曲线。"
                      )
                    }
                  >
                    调整难度
                  </button>
                  <button
                    disabled={busy || Boolean(historyPreview)}
                    onClick={() =>
                      setPrompt(
                        "保持当前玩法，增加适合手机的触控操作，并让界面适应横竖屏。"
                      )
                    }
                  >
                    完善触控
                  </button>
                </div>
              )}
              <div className="composer">
                <Textarea
                  aria-label="游戏创作描述"
                  value={prompt}
                  maxLength={2000}
                  onChange={event => setPrompt(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder={
                    canPatch
                      ? "描述你想改变的玩法、外观或操作…"
                      : "描述你想创建的游戏…"
                  }
                  disabled={
                    busy || Boolean(clarifyQuestions) || Boolean(historyPreview)
                  }
                  rows={3}
                />
                <div className="composer-bar">
                  <span>
                    {canPatch ? "继续修改你的游戏" : "创意 → 创作 → 试玩"}
                  </span>
                  {isGenerating ? (
                    <Button variant="ghost" size="sm" onClick={cancelTask}>
                      <Square size={14} />
                      停止
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => handleSend()}
                      disabled={
                        !prompt.trim() ||
                        !canGenerate ||
                        busy ||
                        Boolean(clarifyQuestions) ||
                        Boolean(historyPreview)
                      }
                    >
                      {canPatch ? <Wrench size={15} /> : <Send size={15} />}
                      {canPatch ? "应用修改" : "生成游戏"}
                    </Button>
                  )}
                </div>
              </div>
              {!displayedArtifact && (
                <div className="home-library">
                  <div className="home-section-heading">
                    <h2>先玩一个，再开始创作</h2>
                    <span>本地示例</span>
                  </div>
                  <button
                    className="preset-card"
                    disabled={busy}
                    onClick={openExample}
                    aria-label="打开接苹果预置示例"
                  >
                    <div className="preset-art" aria-hidden="true">
                      <svg viewBox="0 0 360 150" fill="none">
                        <path
                          d="M0 128C63 98 136 139 205 111c56-23 102-13 155 0v39H0z"
                          fill="#c6dcc0"
                        />
                        <path
                          d="M267 62v64"
                          stroke="#84654e"
                          strokeWidth="10"
                          strokeLinecap="round"
                        />
                        <circle cx="267" cy="54" r="35" fill="#aec79d" />
                        <circle cx="242" cy="67" r="23" fill="#aec79d" />
                        <circle cx="289" cy="69" r="25" fill="#aec79d" />
                        <circle cx="253" cy="49" r="5" fill="#bf694f" />
                        <circle cx="284" cy="63" r="5" fill="#bf694f" />
                        <circle cx="100" cy="67" r="8" fill="#bf694f" />
                        <path
                          d="M100 59l3-6"
                          stroke="#42634b"
                          strokeWidth="3"
                          strokeLinecap="round"
                        />
                        <path d="M71 105h57l-7 24H78z" fill="#8c6c51" />
                        <path
                          d="M68 103h63"
                          stroke="#694e38"
                          strokeWidth="5"
                          strokeLinecap="round"
                        />
                        <path
                          d="M49 45h18m-9-9v18"
                          stroke="#8fad90"
                          strokeWidth="2"
                        />
                        <circle cx="177" cy="37" r="3" fill="#8fad90" />
                        <circle cx="193" cy="79" r="2" fill="#8fad90" />
                      </svg>
                    </div>
                    <div className="preset-copy">
                      <span>
                        <Gamepad2 size={15} /> 接苹果小果园
                      </span>
                      <p>移动篮子，接住苹果。用一个轻松小游戏熟悉创作流程。</p>
                      <small>
                        预置示例 · 无需模型服务 <ChevronRight size={13} />
                      </small>
                    </div>
                  </button>
                  {Object.values(libraryRef.current.documents).some(
                    document => document.artifact
                  ) && (
                    <div className="recent-drafts">
                      <div className="home-section-heading">
                        <h2>继续你的创作</h2>
                        <button onClick={() => setHistoryOpen(true)}>
                          查看全部 <ChevronRight size={13} />
                        </button>
                      </div>
                      <div className="recent-draft-grid">
                        {Object.values(libraryRef.current.documents)
                          .filter(document => document.artifact)
                          .slice(-4)
                          .reverse()
                          .map(document => (
                            <button
                              key={document.documentId}
                              onClick={() =>
                                selectLocalDraft(document.documentId)
                              }
                              disabled={busy}
                            >
                              <span className="recent-draft-icon">
                                <Gamepad2 size={20} />
                              </span>
                              <span>
                                <strong>{document.artifact!.title}</strong>
                                <small>
                                  {document.dirty
                                    ? "本地草稿 · 未保存版本"
                                    : "已保存版本"}
                                </small>
                              </span>
                              <ChevronRight size={15} />
                            </button>
                          ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
            <section className="preview-panel">
              <div className="preview-top">
                <div>
                  <p className="eyebrow">实时试玩</p>
                  <h2>{displayedArtifact?.title ?? "你的游戏将出现在这里"}</h2>
                </div>
                <div className="preview-controls">
                  <button
                    className="restart-game"
                    onClick={restartPreview}
                    disabled={!displayedArtifact}
                    title="重新开始"
                  >
                    <RefreshCw size={14} />
                    <span>重新开始</span>
                  </button>
                  <button
                    className={previewMode === "desktop" ? "active" : ""}
                    onClick={() => setPreviewMode("desktop")}
                    title="桌面预览"
                    aria-label="桌面预览"
                  >
                    <Monitor size={16} />
                  </button>
                  <button
                    className={previewMode === "mobile" ? "active" : ""}
                    onClick={() => setPreviewMode("mobile")}
                    title="手机预览"
                    aria-label="手机预览"
                  >
                    <Smartphone size={16} />
                  </button>
                  <button
                    onClick={() =>
                      void document
                        .querySelector(".preview-frame-wrap")
                        ?.requestFullscreen()
                        .catch(() => toast.info("此浏览器暂不支持全屏。"))
                    }
                    title="全屏"
                    aria-label="全屏"
                  >
                    <Maximize2 size={16} />
                  </button>
                </div>
              </div>
              <div className={`preview-stage ${previewMode}`}>
                <div className="preview-frame-wrap">
                  {displayedArtifact ? (
                    <iframe
                      ref={iframeRef}
                      key={previewRunId}
                      title="游戏隔离预览"
                      sandbox="allow-scripts"
                      srcDoc={sandbox}
                    />
                  ) : (
                    <div className="preview-empty">
                      <span>
                        <Gamepad2 size={38} />
                      </span>
                      <h3>把你的创意变成游戏</h3>
                      <p>描述玩法和风格，创作后即可试玩和继续修改。</p>
                      <small>预置示例 · 无需模型服务</small>
                      <button disabled={busy} onClick={openExample}>
                        <Gamepad2 size={15} />
                        体验示例
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {displayedArtifact?.controls?.length ? (
                <div className="controls-strip">
                  <span className="controls-label">操作</span>
                  {displayedArtifact.controls.map((control, index) => (
                    <span key={index} className="control-chip">
                      {control}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="pipeline-strip">
                {trace.length ? (
                  trace.map((step, index) => (
                    <Fragment key={`strip-${step.agent}-${index}`}>
                      {index > 0 && <i />}
                      <span
                        className={
                          step.status === "repaired"
                            ? "repaired"
                            : step.status === "fallback" ||
                                step.status === "failed"
                              ? "warned"
                              : step.status === "running"
                                ? "running"
                                : "complete"
                        }
                        title={step.detail}
                      >
                        {step.status === "running" ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : step.status === "fallback" ||
                          step.status === "failed" ? (
                          <X size={13} />
                        ) : (
                          <Check size={13} />
                        )}
                        {step.agent}
                      </span>
                    </Fragment>
                  ))
                ) : (
                  <span>
                    {displayedArtifact ? "当前草稿可直接试玩" : "等待创作"}
                  </span>
                )}
              </div>
            </section>
            <section
              className="dock"
              aria-label="游戏编辑与检查"
              hidden={!displayedArtifact || (tab === "run" && !changesOpen)}
            >
              {changesOpen && (
                <div className="changes-panel">
                  <strong>最近一次修改</strong>
                  {changes.length ? (
                    changes.map(change => (
                      <span key={change.path}>
                        <b>
                          {change.kind === "added"
                            ? "+"
                            : change.kind === "removed"
                              ? "−"
                              : "~"}{" "}
                          {change.path}
                        </b>{" "}
                        · {change.beforeLines} → {change.afterLines} 行
                      </span>
                    ))
                  ) : (
                    <span>尚无文件变更</span>
                  )}
                </div>
              )}
              <div className="dock-body" hidden={tab === "run"}>
                {tab === "files" && (
                  <div className="files-view">
                    <Tree
                      files={displayedFiles}
                      activePath={selectedFile?.path ?? ""}
                      onSelect={setSelectedPath}
                    />
                    <div className="editor-area">
                      <div className="editor-head">
                        <span>
                          {selectedFile?.path ?? "No file selected"}
                          {historyPreview
                            ? " · 历史版本只读"
                            : workspace.dirty
                              ? " · 未保存"
                              : ""}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={
                            !artifact ||
                            busy ||
                            Boolean(historyPreview) ||
                            !canUseCloud
                          }
                          onClick={() => void saveFile()}
                        >
                          <Save size={14} />
                          {isSaving ? "保存中…" : "Save version"}
                        </Button>
                      </div>
                      {selectedFile ? (
                        <Suspense
                          fallback={
                            <div className="editor-empty">
                              正在加载代码编辑器…
                            </div>
                          }
                        >
                          <Editor
                            height="360px"
                            theme="vs"
                            path={`${workspace.documentId}/${historyPreview?.versionId ?? "draft"}/${selectedFile.path}`}
                            language={language(selectedFile)}
                            value={selectedFile.content}
                            onChange={value => updateFile(value ?? "")}
                            options={{
                              readOnly: busy || Boolean(historyPreview),
                              minimap: { enabled: false },
                              fontSize: 13,
                              wordWrap: "on",
                              padding: { top: 12 },
                            }}
                          />
                        </Suspense>
                      ) : (
                        <div className="editor-empty">
                          创作后可浏览与编辑真实源码。
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {tab === "console" && (
                  <div className="console-view">
                    <div className="console-head">
                      <span>当前版本的检查日志</span>
                      <button
                        disabled={!displayedArtifact}
                        onClick={restartPreview}
                      >
                        <Play size={14} />
                        重新运行
                      </button>
                    </div>
                    <pre>{logs.join("\n")}</pre>
                  </div>
                )}
                {tab === "spec" && (
                  <div className="spec-view">
                    <div className="design-summary">
                      <p className="eyebrow">CURRENT SNAPSHOT</p>
                      <h3>游戏文档与验收要求</h3>
                      <p>预览、源码和 ZIP 使用相同的游戏内容。</p>
                      {gameDesign ? (
                        <>
                          <h4>你的创作要求</h4>
                          <p className="design-prompt">
                            {gameDesign.originalPrompt}
                          </p>
                          <h4>用户验收要求</h4>
                          <ul className="acceptance-list">
                            {gameDesign.acceptance.map(criterion => (
                              <li key={criterion.id}>
                                <span>{criterion.requirement}</span>
                                <small>
                                  {criterion.evidence === "manual"
                                    ? "需要亲自试玩确认 · 尚未自动测量"
                                    : "需要独立操作验证 · 本面板不判定通过"}
                                </small>
                              </li>
                            ))}
                          </ul>
                          {Array.isArray(gameDesign.inferredDefaults) &&
                            gameDesign.inferredDefaults.length > 0 && (
                              <>
                                <h4>创作默认项</h4>
                                {gameDesign.inferredDefaults
                                  .filter(value => typeof value === "string")
                                  .map((value, index) => (
                                    <p key={index}>{value}</p>
                                  ))}
                              </>
                            )}
                        </>
                      ) : (
                        <p>
                          当前游戏没有记录结构化验收要求，请根据原始创意亲自试玩确认。
                        </p>
                      )}
                    </div>
                    <pre>
                      {displayedArtifact
                        ? JSON.stringify(displayedArtifact, null, 2)
                        : "尚未创建游戏。"}
                    </pre>
                  </div>
                )}
                {tab === "parameters" && (
                  <GameParametersPanel
                    artifact={displayedArtifact}
                    disabled={busy || Boolean(historyPreview)}
                    onEdit={updateParameter}
                    onPrepare={() => {
                      setPrompt(
                        "保持当前游戏的玩法、美术和操作，添加或修复 arcane.config.json 可调参数。使用 schemaVersion: 1 与 parameters 数组，每项包含 id、label、type、value；number 必須提供 min 和 max，可选 step，color 使用六位十六进制颜色，boolean 使用布尔值。把现有的速度、难度和颜色等适合调整的值迁移到配置，游戏必须通过 fetch('arcane.config.json') 加载并真正使用参数。避免添加无效参数，不改变当前玩法。"
                      );
                      document
                        .querySelector<HTMLTextAreaElement>(
                          '[aria-label="游戏创作描述"]'
                        )
                        ?.focus();
                    }}
                  />
                )}
                {tab === "gates" && (
                  <div className="gates-view">
                    <div className="gates-col">
                      <div className="gates-head">
                        <ShieldCheck size={13} />
                        源码检查
                      </div>
                      {currentValidation ? (
                        currentValidation.checks.map(check => (
                          <GateRow key={check.name} check={check} />
                        ))
                      ) : (
                        <p className="gates-empty">
                          {displayedArtifact
                            ? "当前源码没有有效的静态检查结果。编辑后的旧检查已失效。"
                            : "创作后显示源码检查。"}
                        </p>
                      )}
                      {currentValidation?.stopReason &&
                        currentValidation.stopReason !== "passed" && (
                          <p className="gates-stop">
                            修正停止原因：{currentValidation.stopReason} · 尝试{" "}
                            {currentValidation.attempts} 次
                          </p>
                        )}
                    </div>
                    <div className="gates-col">
                      <div className="gates-head">
                        <Activity size={13} />
                        预览观测
                      </div>
                      {probe ? (
                        probe.checks.map(check => (
                          <GateRow key={check.name} check={check} />
                        ))
                      ) : displayedArtifact ? (
                        <p className="gates-empty running">
                          {probeTimedOut ? (
                            "未收到有效试玩报告，请重新运行预览。"
                          ) : (
                            <>
                              <Loader2 className="animate-spin" size={13} />
                              正在检查当前预览…
                            </>
                          )}
                        </p>
                      ) : (
                        <p className="gates-empty">创作后自动运行。</p>
                      )}
                      {probe?.errors.length ? (
                        <pre className="gates-errors">
                          {probe.errors.join("\n")}
                        </pre>
                      ) : null}
                      <small className="gates-empty">
                        预览观测仅用于辅助诊断，不操作游戏，也不作为发布凭据。独立运行验证请打开顶部“发布”。
                      </small>
                    </div>
                  </div>
                )}
              </div>
            </section>
          </main>
          <footer className="studio-footer">
            <span>想象、创作，然后一起玩。</span>
            <span>ARCANE GAME STUDIO</span>
          </footer>
        </div>
      </div>
      <BillingPanel open={billingOpen} onClose={() => setBillingOpen(false)} />
    </div>
  );
}
