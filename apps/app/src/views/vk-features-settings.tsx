import { vkFeatures, type Experiments, type VkFeature, type VkSwitchKey } from "@bb/domain";
import { Switch } from "@bb/shared-ui/switch";
import {
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui/settings-section.js";

// VK EXPERIMENTAL: Settings -> «Функции VK», rendered from the vkFeatures list in @bb/domain.

export const VK_ALWAYS_ON_BADGE = "Всегда включено";

export function vkFeatureNote(feature: VkFeature): string | null {
  if (feature.kind !== "env") return null;
  return feature.defaultOn
    ? `Работает по умолчанию; отключается переменной ${feature.envVar}=0`
    : `Включается переменной ${feature.envVar}=1 на сервере`;
}

function vkFeatureBadge(feature: VkFeature): string | undefined {
  if (feature.kind === "always") return VK_ALWAYS_ON_BADGE;
  if (feature.kind === "env") return feature.defaultOn ? "Включено" : "Выключено";
  return undefined;
}

export interface VkFeaturesSettingsSectionProps {
  disabled: boolean;
  experiments: Experiments;
  onSwitchChange: (key: VkSwitchKey, enabled: boolean) => void;
}

export function VkFeaturesSettingsSection({
  disabled,
  experiments,
  onSwitchChange,
}: VkFeaturesSettingsSectionProps) {
  return (
    <SettingsSection
      title="Функции VK"
      description="Функции ядра, которых нет в обычном BB. Переключатели включают и выключают поведение сразу; функции с пометкой «Всегда включено» нужны плагинам и не отключаются."
    >
      <div className="space-y-5">
        {vkFeatures.map((feature) => {
          const note = vkFeatureNote(feature);
          return (
            <SettingsWithControl
              key={feature.key}
              label={feature.label}
              labelBadge={vkFeatureBadge(feature)}
              description={note ? `${feature.description} ${note}.` : feature.description}
            >
              {feature.kind === "switch" ? (
                <Switch
                  checked={experiments[feature.key]}
                  disabled={disabled}
                  onCheckedChange={(enabled) =>
                    onSwitchChange(feature.key, enabled)
                  }
                  aria-label={feature.label}
                />
              ) : null}
            </SettingsWithControl>
          );
        })}
      </div>
    </SettingsSection>
  );
}
