import { useCallback, useEffect, useRef, useState } from "react";
import {
  emptyWorkspace,
  parseDraftLibrary,
  serializeDraftLibrary,
  type DraftLibrary,
  type WorkspaceState,
} from "@/lib/workspaceState";

export function useWorkspaceDrafts(
  userId: number | undefined,
  authLoading: boolean
) {
  const initial = useRef(emptyWorkspace(crypto.randomUUID()));
  const [workspace, setWorkspace] = useState(initial.current);
  const workspaceRef = useRef(workspace);
  const libraryRef = useRef<DraftLibrary>({
    activeDocumentId: workspace.documentId,
    documents: { [workspace.documentId]: workspace },
  });
  const storageKeyRef = useRef<string | null>(null);
  const [storageStatus, setStorageStatus] = useState("正在读取草稿…");
  const [ready, setReady] = useState(false);

  const flushDrafts = useCallback(() => {
    if (!storageKeyRef.current) return;
    try {
      localStorage.setItem(
        storageKeyRef.current,
        serializeDraftLibrary(libraryRef.current)
      );
      setStorageStatus("草稿已保存在此浏览器");
    } catch {
      setStorageStatus("浏览器草稿存储不可用，请下载或保存到项目");
    }
  }, []);

  const prepareLogin = useCallback(() => {
    flushDrafts();
    if (
      storageKeyRef.current !== "arcane.workspace.v2.guest" ||
      !workspaceRef.current.artifact
    )
      return;
    try {
      localStorage.setItem(
        "arcane.workspace.loginDraft",
        workspaceRef.current.documentId
      );
    } catch {
      /* The guest library is still available when browser storage works. */
    }
  }, [flushDrafts]);

  const commitWorkspace = useCallback(
    (next: WorkspaceState | ((current: WorkspaceState) => WorkspaceState)) => {
      const value =
        typeof next === "function" ? next(workspaceRef.current) : next;
      workspaceRef.current = value;
      libraryRef.current.activeDocumentId = value.documentId;
      libraryRef.current.documents[value.documentId] = value;
      setWorkspace(value);
    },
    []
  );

  const updateStoredDocument = useCallback(
    (document: WorkspaceState) => {
      libraryRef.current.documents[document.documentId] = document;
      if (workspaceRef.current.documentId === document.documentId)
        commitWorkspace(document);
      else flushDrafts();
    },
    [commitWorkspace, flushDrafts]
  );

  useEffect(() => {
    if (authLoading) return;
    const key = `arcane.workspace.v2.${userId ?? "guest"}`;
    if (storageKeyRef.current === key) return;
    let library: DraftLibrary | null = null;
    try {
      library = parseDraftLibrary(localStorage.getItem(key));
      if (userId) {
        const guest = parseDraftLibrary(
          localStorage.getItem("arcane.workspace.v2.guest")
        );
        const pendingDocumentId = localStorage.getItem(
          "arcane.workspace.loginDraft"
        );
        const requestedDraft = pendingDocumentId
          ? guest?.documents[pendingDocumentId]
          : undefined;
        if (requestedDraft?.artifact) {
          library = {
            activeDocumentId: requestedDraft.documentId,
            documents: {
              ...guest!.documents,
              ...library?.documents,
              [requestedDraft.documentId]: requestedDraft,
            },
          };
        } else if (
          !library &&
          guest?.documents[guest.activeDocumentId]?.artifact
        )
          library = guest;
        // Persist the merged library before acknowledging a login handoff.
        // On a failed write, the marker remains and the guest copy is retained.
        if (library) localStorage.setItem(key, serializeDraftLibrary(library));
        if (pendingDocumentId)
          localStorage.removeItem("arcane.workspace.loginDraft");
      }
    } catch {
      /* Start with an in-memory document if storage is disabled. */
    }
    storageKeyRef.current = key;
    const document =
      library?.documents[library.activeDocumentId] ??
      emptyWorkspace(crypto.randomUUID());
    libraryRef.current = library ?? {
      activeDocumentId: document.documentId,
      documents: { [document.documentId]: document },
    };
    commitWorkspace(document);
    setReady(true);
    setStorageStatus(
      document.artifact ? "已恢复本地草稿" : "草稿将自动保存在此浏览器"
    );
  }, [authLoading, userId, commitWorkspace]);

  useEffect(() => {
    if (!ready) return;
    const timeout = setTimeout(flushDrafts, 300);
    return () => clearTimeout(timeout);
  }, [workspace, ready, flushDrafts]);

  useEffect(() => {
    const onPageHide = () => flushDrafts();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      flushDrafts();
    };
  }, [flushDrafts]);

  return {
    workspace,
    workspaceRef,
    libraryRef,
    commitWorkspace,
    updateStoredDocument,
    flushDrafts,
    prepareLogin,
    storageStatus,
    ready,
  };
}
