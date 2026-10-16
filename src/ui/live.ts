import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { STATE_CHANNEL, type rpcContract, type RunView } from "../contract.ts";
import type { Thread } from "./layout.ts";

export type LiveState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; value: T; refreshError: string | null };

export function signalMatchesThread(payload: unknown, threadId: string): boolean {
  return typeof payload === "object" && payload !== null && "threadId" in payload && payload.threadId === threadId
    && "revision" in payload && typeof payload.revision === "number" && Number.isInteger(payload.revision);
}

export function createCoalescedRefresh(load: () => Promise<void>) {
  let disposed = false;
  let running = false;
  let queued = false;
  let scheduled: ReturnType<typeof setTimeout> | null = null;
  const run = async () => {
    running = true;
    try { await load(); }
    finally {
      running = false;
      if (queued && !disposed) {
        queued = false;
        refresh();
      }
    }
  };
  const refresh = () => {
    if (disposed) return;
    if (running) { queued = true; return; }
    if (scheduled !== null) return;
    scheduled = setTimeout(() => { scheduled = null; void run(); }, 50);
  };
  return { refresh, dispose() { disposed = true; queued = false; if (scheduled !== null) clearTimeout(scheduled); } };
}

function useLiveView<T>(threadId: string, load: () => Promise<T>) {
  const [state, setState] = useState<LiveState<T>>({ status: "loading" });
  const refreshRef = useRef<() => void>(() => {});
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  useEffect(() => {
    let disposed = false;
    setState({ status: "loading" });
    const queue = createCoalescedRefresh(async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const value = await load();
        if (!disposed) setState({ status: "ready", value, refreshError: null });
      } catch (error) {
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        setState((current) => current.status === "ready" ? { ...current, refreshError: message } : { status: "error", message });
      }
    });
    refreshRef.current = queue.refresh;
    const visible = () => { if (document.visibilityState !== "hidden") queue.refresh(); };
    visible();
    const poll = setInterval(visible, 15_000);
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      queue.dispose();
      clearInterval(poll);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [threadId, load]);
  useRealtime(STATE_CHANNEL, (payload) => {
    if (signalMatchesThread(payload, threadId) && document.visibilityState !== "hidden") refreshRef.current();
  });
  useEffect(() => {
    if (connection === "connected" && previousConnection.current !== "connected") refreshRef.current();
    previousConnection.current = connection;
  }, [connection]);
  const refresh = useCallback(() => refreshRef.current(), []);
  return { state, refresh };
}

export function useThreadView(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const load = useCallback(() => rpc.call("pstackThreadView", { threadId }), [rpc, threadId]);
  return useLiveView<Thread>(threadId, load);
}

export function useRunView(threadId: string, runId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const load = useCallback(() => rpc.call("pstackRunView", { threadId, runId }), [rpc, threadId, runId]);
  return useLiveView<RunView | null>(threadId, load);
}
