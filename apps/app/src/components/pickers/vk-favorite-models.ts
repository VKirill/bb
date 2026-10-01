import { useCallback, useEffect, useState } from "react";
import type { ModelPickerOption } from "./model-picker-option";

/** VK EXPERIMENTAL — starred models in the native picker. Not part of upstream bb. */

export const VK_FAVORITE_MODELS_STORAGE_KEY = "bb.vk.favorite-models";
export const VK_FAVORITE_MODELS_CHANGE_EVENT = "bb-vk-favorite-models";
const MAX_FAVORITES = 200;

export interface VkFavoriteModel {
  providerId: string;
  model: string;
}

export interface VkFavoriteCopy {
  favorites: string;
  all: string;
  add: string;
  remove: string;
}

export function vkFavoriteKey(providerId: string, model: string): string {
  return `${providerId}\t${model}`;
}

export function vkFavoriteCopy(lang = defaultLang()): VkFavoriteCopy {
  if (lang.toLowerCase().startsWith("ru")) {
    return {
      favorites: "Избранные модели",
      all: "Все модели",
      add: "Добавить в избранное",
      remove: "Убрать из избранного",
    };
  }
  return {
    favorites: "Favorite models",
    all: "All models",
    add: "Add to favorites",
    remove: "Remove from favorites",
  };
}

function defaultLang(): string {
  return typeof document === "undefined" ? "en" : document.documentElement.lang;
}

export function vkReadFavoriteModels(): VkFavoriteModel[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(VK_FAVORITE_MODELS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: VkFavoriteModel[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const providerId =
        "providerId" in item && typeof item.providerId === "string"
          ? item.providerId.trim()
          : "";
      const model =
        "model" in item && typeof item.model === "string"
          ? item.model.trim()
          : "";
      if (!providerId || !model) continue;
      const key = vkFavoriteKey(providerId, model);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ providerId, model });
      if (out.length >= MAX_FAVORITES) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function vkWriteFavoriteModels(next: readonly VkFavoriteModel[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(
    VK_FAVORITE_MODELS_STORAGE_KEY,
    JSON.stringify(next.slice(0, MAX_FAVORITES)),
  );
  window.dispatchEvent(new Event(VK_FAVORITE_MODELS_CHANGE_EVENT));
}

export function vkToggleFavoriteModel(
  providerId: string,
  model: string,
): VkFavoriteModel[] {
  const current = vkReadFavoriteModels();
  const key = vkFavoriteKey(providerId, model);
  const exists = current.some(
    (item) => vkFavoriteKey(item.providerId, item.model) === key,
  );
  const next = exists
    ? current.filter((item) => vkFavoriteKey(item.providerId, item.model) !== key)
    : [...current, { providerId, model }];
  vkWriteFavoriteModels(next);
  return next;
}

export function vkFavoriteOptionsForProvider(
  favorites: readonly VkFavoriteModel[],
  providerId: string,
  catalog: readonly ModelPickerOption[],
): ModelPickerOption[] {
  const byValue = new Map(catalog.map((option) => [option.value, option]));
  const out: ModelPickerOption[] = [];
  for (const favorite of favorites) {
    if (favorite.providerId !== providerId) continue;
    const option = byValue.get(favorite.model);
    if (option) out.push(option);
  }
  return out;
}

export function useVkFavoriteModels(providerId: string) {
  const [favorites, setFavorites] = useState(vkReadFavoriteModels);
  useEffect(() => {
    const sync = () => setFavorites(vkReadFavoriteModels());
    window.addEventListener("storage", sync);
    window.addEventListener(VK_FAVORITE_MODELS_CHANGE_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(VK_FAVORITE_MODELS_CHANGE_EVENT, sync);
    };
  }, []);
  const toggle = useCallback((model: string) => {
    setFavorites(vkToggleFavoriteModel(providerId, model));
  }, [providerId]);
  const isFavorite = useCallback(
    (model: string) =>
      favorites.some(
        (item) => item.providerId === providerId && item.model === model,
      ),
    [favorites, providerId],
  );
  return { favorites, toggle, isFavorite };
}
