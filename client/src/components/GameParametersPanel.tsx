import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { validateGameConfig, type GameParameter } from "@shared/game/config";
import type { GameArtifact } from "@shared/game/types";
import { gameConfigIsConnected } from "@/lib/gameConfigConnection";

const CONFIG_PATH = "arcane.config.json";

function readParameters(artifact: GameArtifact | null) {
  const file = artifact?.files.find(file => file.path === CONFIG_PATH);
  if (!file) return { config: null, errors: [], consumed: false };
  try {
    const checked = validateGameConfig(JSON.parse(file.content));
    // A config is actionable only when game code loads it. A mention in a
    // README or design document must not create controls that do nothing.
    const consumed = gameConfigIsConnected(artifact!);
    return { config: checked.config, errors: checked.errors, consumed };
  } catch {
    return {
      config: null,
      errors: ["游戏配置不是有效的 JSON。"],
      consumed: false,
    };
  }
}

export default function GameParametersPanel({
  artifact,
  disabled,
  onEdit,
  onPrepare,
}: {
  artifact: GameArtifact | null;
  disabled: boolean;
  onEdit: (path: string, content: string) => void;
  onPrepare: () => void;
}) {
  const { config, errors, consumed } = useMemo(
    () => readParameters(artifact),
    [artifact]
  );
  function change(parameter: GameParameter, value: number | boolean | string) {
    if (disabled || !config || !consumed) return;
    let nextValue = value;
    if (parameter.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      nextValue = Math.max(parameter.min, Math.min(parameter.max, value));
      if (parameter.step) {
        const steps = Math.round(
          (Number(nextValue) - parameter.min) / parameter.step
        );
        nextValue = Math.max(
          parameter.min,
          Math.min(
            parameter.max,
            Number((parameter.min + steps * parameter.step).toPrecision(12))
          )
        );
      }
    }
    const next = {
      ...config,
      parameters: config.parameters.map(item =>
        item.id === parameter.id ? { ...item, value: nextValue } : item
      ),
    };
    const checked = validateGameConfig(next);
    if (checked.config)
      onEdit(CONFIG_PATH, JSON.stringify(checked.config, null, 2));
  }
  return (
    <div className="parameters-panel">
      <div>
        <p className="eyebrow">GAME PARAMETERS</p>
        <h3>调整游戏参数</h3>
        <p>修改配置后预览重新运行。调整玩法后，请重新试玩和验证。</p>
      </div>
      {config && consumed ? (
        <div className="parameter-list">
          {config.parameters.map(parameter => (
            <label className="parameter-field" key={parameter.id}>
              <span>
                {parameter.label}
                <small>
                  {parameter.type === "number"
                    ? `${parameter.min} – ${parameter.max}${parameter.step ? ` · 步长 ${parameter.step}` : ""}`
                    : parameter.type === "color"
                      ? "游戏颜色"
                      : "开启 / 关闭"}
                </small>
              </span>
              {parameter.type === "boolean" ? (
                <input
                  type="checkbox"
                  checked={parameter.value}
                  disabled={disabled}
                  onChange={event => change(parameter, event.target.checked)}
                />
              ) : parameter.type === "color" ? (
                <input
                  type="color"
                  value={parameter.value}
                  disabled={disabled}
                  onChange={event => change(parameter, event.target.value)}
                />
              ) : (
                <input
                  type="number"
                  min={parameter.min}
                  max={parameter.max}
                  step={parameter.step ?? "any"}
                  value={parameter.value}
                  disabled={disabled}
                  onChange={event => {
                    if (event.target.value.trim())
                      change(parameter, Number(event.target.value));
                  }}
                />
              )}
            </label>
          ))}
        </div>
      ) : (
        <div className="parameters-empty">
          <p>
            {errors.length
              ? `配置需要修复：${errors.join(" ")}`
              : config
                ? "游戏已经有配置文件，但尚未加载这份配置。请让创作助手接入游戏逻辑。"
                : artifact
                  ? "当前游戏还没有可调配置。可以让创作助手提取速度、重力和难度等参数，保持现有玩法。"
                  : "创作游戏后，可以在这里调整可用参数。"}
          </p>
          <Button disabled={!artifact || disabled} onClick={onPrepare}>
            {config || errors.length ? "修复可调参数" : "为游戏添加可调参数"}
          </Button>
        </div>
      )}
    </div>
  );
}
