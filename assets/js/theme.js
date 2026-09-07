(() => {
  const root = document.documentElement;
  const system = matchMedia("(prefers-color-scheme: dark)");
  const palettes = document.currentScript.dataset.palettes.split(",");
  const modes = ["auto", "light", "dark"];
  const key = "blog-theme";
  let selected = "auto";

  function readPreference() {
    try {
      return localStorage.getItem(key) || "auto";
    } catch {
      return "auto";
    }
  }

  function syncComments(event) {
    if (event && !event.target.matches?.("iframe.giscus-frame")) return;
    document
      .querySelector("iframe.giscus-frame")
      ?.contentWindow.postMessage(
        { giscus: { setConfig: { theme: root.style.colorScheme } } },
        "https://giscus.app",
      );
  }

  function apply(value) {
    if (value === "default") value = "auto";
    selected = [...modes, ...palettes].includes(value) ? value : "auto";
    root.dataset.palette = modes.includes(selected) ? "default" : selected;
    root.style.colorScheme = ["light", "dark"].includes(selected)
      ? selected
      : system.matches
        ? "dark"
        : "light";
    document
      .querySelectorAll(".theme-options [data-theme]")
      .forEach((button) => {
        const active = button.dataset.theme === selected;
        button.setAttribute("aria-pressed", String(active));
      });
    syncComments();
  }

  apply(readPreference());
  system.addEventListener("change", () => apply(selected));
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) apply(readPreference());
  });
  // Also sync comments that load after the theme was selected.
  document.addEventListener("load", syncComments, true);
  document.addEventListener("DOMContentLoaded", () => {
    const control = document.querySelector(".theme-control");
    if (!control) return;
    const trigger = control.querySelector("summary");
    const menu = control.querySelector(".theme-options");
    const buttons = [...control.querySelectorAll("[data-theme]")];
    apply(selected);
    control.hidden = false;

    function close() {
      control.open = false;
      trigger.focus({ preventScroll: true });
    }

    function fitMenu() {
      if (!control.open) return;
      const viewport = window.visualViewport;
      const bottom = viewport
        ? viewport.offsetTop + viewport.height
        : innerHeight;
      menu.style.setProperty(
        "--theme-menu-height",
        `${Math.max(0, bottom - menu.getBoundingClientRect().top - 12)}px`,
      );
    }

    control.addEventListener("toggle", fitMenu);
    window.addEventListener("resize", fitMenu);
    window.visualViewport?.addEventListener("resize", fitMenu);

    control.addEventListener("click", (event) => {
      const button = event.target.closest("[data-theme]");
      if (!button) return;
      apply(button.dataset.theme);
      close();
      try {
        localStorage.setItem(key, selected);
      } catch {
        // Keep switching usable when browser storage is unavailable.
      }
    });
    control.addEventListener("keydown", (event) => {
      if (event.key === "Escape") return close();
      if (event.key === "Tab") {
        // Wait for keyboard focus navigation, including leaving the document.
        return setTimeout(() => dismiss(document.activeElement), 0);
      }
      const index = buttons.indexOf(document.activeElement);
      const next = {
        ArrowDown: index + 1,
        ArrowUp: Math.max(0, index) - 1,
        Home: 0,
        End: buttons.length - 1,
      }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      control.open = true;
      buttons[(next + buttons.length) % buttons.length].focus();
    });

    function dismiss(target) {
      if (target && !control.contains(target)) control.open = false;
    }
    document.addEventListener("pointerdown", (event) => dismiss(event.target));
    // A pointer can blur the trigger without focusing the clicked option.
    control.addEventListener("focusout", (event) =>
      dismiss(event.relatedTarget),
    );
  });
})();
