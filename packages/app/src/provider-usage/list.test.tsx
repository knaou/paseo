/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderUsage } from "@getpaseo/protocol/messages";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 3: 12 },
    fontSize: { sm: 13 },
    colors: { foreground: "#foreground", foregroundMuted: "#muted", border: "#border" },
  },
}));

vi.mock("react-native", () => ({
  View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("div", props, children),
  Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("span", props, children),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: (value: typeof theme) => unknown) => factory(theme),
  },
}));

vi.mock("@/styles/settings", () => ({
  settingsStyles: { card: { backgroundColor: "#surface" } },
}));

vi.mock("./card", () => ({
  ProviderUsageCard: ({ usage: cardUsage }: { usage: ProviderUsage }) =>
    React.createElement("div", { "data-card": cardUsage.providerId }),
}));

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { ProviderUsageList } from "./list";

function usage(
  providerId: string,
  displayName: string,
  status: ProviderUsage["status"],
): ProviderUsage {
  return {
    providerId,
    displayName,
    status,
    planLabel: null,
    windows: [],
    balances: [],
    details: [],
    error: null,
  };
}

describe("ProviderUsageList", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders available and error providers as cards, unavailable ones as a muted footer", () => {
    act(() =>
      root.render(
        <ProviderUsageList
          providers={[
            usage("claude", "Claude", "available"),
            usage("codex", "Codex", "error"),
            usage("junie", "Junie", "unavailable"),
            usage("opencode-go", "OpenCode Go", "unavailable"),
          ]}
        />,
      ),
    );

    const cards = Array.from(container.querySelectorAll("[data-card]")).map((node) =>
      node.getAttribute("data-card"),
    );
    expect(cards).toEqual(["claude", "codex"]);

    const footer = container.querySelector("span");
    expect(footer?.textContent).toBe("Junie, OpenCode Go unavailable");
  });

  it("renders only the footer when every provider is unavailable", () => {
    act(() =>
      root.render(
        <ProviderUsageList
          providers={[usage("junie", "Junie", "unavailable"), usage("zai", "Z.ai", "unavailable")]}
        />,
      ),
    );

    expect(container.querySelectorAll("[data-card]")).toHaveLength(0);
    expect(container.querySelector("span")?.textContent).toBe("Junie, Z.ai unavailable");
  });

  it("renders no footer when every provider is available", () => {
    act(() =>
      root.render(<ProviderUsageList providers={[usage("claude", "Claude", "available")]} />),
    );

    expect(container.querySelectorAll("[data-card]")).toHaveLength(1);
    expect(container.querySelector("span")).toBeNull();
  });
});
