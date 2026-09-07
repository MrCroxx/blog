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

  function syncComments() {
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
  // Comments may load after the user has already selected a theme.
  document.addEventListener(
    "load",
    (event) => {
      if (event.target.matches?.("iframe.giscus-frame")) syncComments();
    },
    true,
  );
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
      if (event.key === "Escape") {
        close();
      } else if (event.key === "Tab") {
        // Wait for the browser to finish keyboard focus navigation.
        setTimeout(() => {
          if (!control.contains(document.activeElement)) control.open = false;
        }, 0);
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        control.open = true;
        const index = buttons.indexOf(document.activeElement);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : event.key === "ArrowDown"
                ? (index + 1) % buttons.length
                : index < 0
                  ? buttons.length - 1
                  : (index - 1 + buttons.length) % buttons.length;
        buttons[next].focus();
      }
    });
    document.addEventListener("pointerdown", (event) => {
      if (!control.contains(event.target)) control.open = false;
    });
    control.addEventListener("focusout", (event) => {
      // Pointer activation can blur the trigger without focusing the option.
      if (event.relatedTarget && !control.contains(event.relatedTarget)) {
        control.open = false;
      }
    });
  });
})();
