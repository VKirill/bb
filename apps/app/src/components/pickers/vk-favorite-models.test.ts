// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  VK_FAVORITE_MODELS_STORAGE_KEY,
  vkFavoriteCopy,
  vkFavoriteOptionsForProvider,
  vkReadFavoriteModels,
  vkToggleFavoriteModel,
  vkWriteFavoriteModels,
} from "./vk-favorite-models";

afterEach(() => {
  localStorage.clear();
});

describe("vk favorite models", () => {
  it("ignores junk in storage", () => {
    localStorage.setItem(VK_FAVORITE_MODELS_STORAGE_KEY, "{");
    expect(vkReadFavoriteModels()).toEqual([]);
    localStorage.setItem(
      VK_FAVORITE_MODELS_STORAGE_KEY,
      JSON.stringify([
        null,
        { providerId: "  ", model: "gpt" },
        { providerId: "codex", model: "gpt-5.5" },
        { providerId: "codex", model: "gpt-5.5" },
        { providerId: "codex" },
      ]),
    );
    expect(vkReadFavoriteModels()).toEqual([
      { providerId: "codex", model: "gpt-5.5" },
    ]);
  });

  it("toggles per provider and keeps star order", () => {
    vkToggleFavoriteModel("codex", "o3");
    vkToggleFavoriteModel("claude-code", "opus");
    vkToggleFavoriteModel("codex", "gpt-5.5");
    expect(vkReadFavoriteModels()).toEqual([
      { providerId: "codex", model: "o3" },
      { providerId: "claude-code", model: "opus" },
      { providerId: "codex", model: "gpt-5.5" },
    ]);
    vkToggleFavoriteModel("codex", "o3");
    expect(vkReadFavoriteModels()).toEqual([
      { providerId: "claude-code", model: "opus" },
      { providerId: "codex", model: "gpt-5.5" },
    ]);
  });

  it("lists starred catalog rows in star order, skipping unknown ids", () => {
    vkWriteFavoriteModels([
      { providerId: "codex", model: "missing" },
      { providerId: "codex", model: "o3" },
      { providerId: "claude-code", model: "opus" },
      { providerId: "codex", model: "gpt-5.5" },
    ]);
    const catalog = [
      { value: "gpt-5.5", label: "GPT-5.5" },
      { value: "o3", label: "o3" },
    ];
    expect(
      vkFavoriteOptionsForProvider(vkReadFavoriteModels(), "codex", catalog).map(
        (row) => row.value,
      ),
    ).toEqual(["o3", "gpt-5.5"]);
  });

  it("uses Russian copy when the document language is ru", () => {
    expect(vkFavoriteCopy("ru").favorites).toBe("Избранные модели");
    expect(vkFavoriteCopy("en").favorites).toBe("Favorite models");
  });
});
