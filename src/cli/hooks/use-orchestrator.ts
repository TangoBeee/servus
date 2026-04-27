import { useState, useEffect, useCallback, useRef } from "react";
import { bus, type ServusEvent } from "../../events.js";
import type { LogEntry } from "../components/log-viewer.js";

export function useEventLog(maxEntries = 500) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const counter = useRef(0);

  useEffect(() => {
    const handler = (event: ServusEvent) => {
      if (event.type === "agent:text") return;
      setLogs((prev) => {
        const entry: LogEntry = {
          id: ++counter.current,
          agent: event.agent,
          color: event.color,
          message: event.message,
          type: event.type,
        };
        const next = [...prev, entry];
        return next.length > maxEntries ? next.slice(-Math.floor(maxEntries * 0.8)) : next;
      });
    };

    bus.on("event", handler);
    return () => { bus.off("event", handler); };
  }, [maxEntries]);

  const clear = useCallback(() => setLogs([]), []);

  return { logs, clear };
}
