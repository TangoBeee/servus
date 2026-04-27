import { useState, useCallback } from "react";
import {
  loadConfig,
  saveConfig,
  type ServusConfig,
} from "../../config.js";

export function useConfig() {
  const [config, setConfig] = useState(loadConfig);

  const update = useCallback((partial: Partial<ServusConfig>) => {
    const next = { ...config, ...partial };
    saveConfig(next);
    setConfig(next);
  }, [config]);

  const reload = useCallback(() => {
    setConfig(loadConfig());
  }, []);

  return { config, update, reload };
}
