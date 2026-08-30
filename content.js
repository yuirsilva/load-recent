(() => {
  "use strict";

  const PREFIX = "[Instagram Oldest First]";
  const COMMAND_EVENT = "instagram-oldest-first:relay-command";
  const PROGRESS_EVENT = "instagram-oldest-first:relay-progress";
  const STATUS_HOST_ID = "instagram-oldest-first-status";
  const READY_ATTRIBUTE = "data-instagram-oldest-first-ready";
  const RESERVED_ROUTES = new Set([
    "accounts", "developer", "direct", "directory", "emails", "explore",
    "legal", "press", "reels", "stories", "web"
  ]);

  const state = {
    mode: "newest",
    statusTimer: null,
    lastToggleAt: 0
  };

  function isProfilePage() {
    const parts = location.pathname.split("/").filter(Boolean);
    return parts.length === 1 && !RESERVED_ROUTES.has(parts[0].toLowerCase());
  }

  function username() {
    return location.pathname.split("/").filter(Boolean)[0] || "";
  }

  function declaredPostCount() {
    const text = document.querySelector("main")?.innerText ?? "";
    const match = text.match(/([\d.,]+)\s*([KMB])?\s+posts\b/i);
    if (!match) return null;
    const number = Number(match[1].replace(/,/g, ""));
    const multiplier = { K: 1e3, M: 1e6, B: 1e9 }[match[2]?.toUpperCase()] ?? 1;
    return Number.isFinite(number) ? Math.round(number * multiplier) : null;
  }

  function statusElement() {
    let host = document.getElementById(STATUS_HOST_ID);
    if (host) return host.shadowRoot.querySelector("[role=status]");

    host = document.createElement("div");
    host.id = STATUS_HOST_ID;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        [role=status] {
          position: fixed; z-index: 2147483647; top: 18px; left: 50%;
          transform: translateX(-50%); max-width: min(520px, calc(100vw - 32px));
          box-sizing: border-box; padding: 10px 14px; border-radius: 10px;
          color: #f5f5f5; background: rgba(18,18,18,.94);
          border: 1px solid rgba(255,255,255,.18); box-shadow: 0 8px 28px rgba(0,0,0,.35);
          font: 600 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          letter-spacing: 0; text-align: center; pointer-events: none;
        }
        [role=status][data-tone=success] { border-color: rgba(70,210,120,.7); }
        [role=status][data-tone=error] { border-color: rgba(255,90,90,.8); }
      </style>
      <div role="status" aria-live="polite"></div>
    `;
    document.documentElement.append(host);
    return shadow.querySelector("[role=status]");
  }

  function showStatus(message, tone = "loading", hideAfter = 0) {
    clearTimeout(state.statusTimer);
    const status = statusElement();
    status.dataset.tone = tone;
    status.textContent = message;
    status.hidden = false;
    if (hideAfter) {
      state.statusTimer = setTimeout(() => { status.hidden = true; }, hideAfter);
    }
  }

  function command(action) {
    document.dispatchEvent(new CustomEvent(COMMAND_EVENT, {
      detail: {
        action,
        username: username(),
        total: declaredPostCount()
      }
    }));
  }

  function toggle() {
    const now = performance.now();
    if (now - state.lastToggleAt < 300) return;
    state.lastToggleAt = now;

    if (state.mode === "newest") {
      if (!isProfilePage()) {
        showStatus("Open a profile's Posts tab first.", "error");
        return;
      }
      state.mode = "loading";
      showStatus("Connecting to Instagram's native post data…");
      command("start");
    } else {
      command("restore");
    }
  }

  document.addEventListener(PROGRESS_EVENT, (event) => {
    const detail = event.detail || {};
    if (detail.phase === "loading") {
      state.mode = "loading";
      showStatus(
        `Loading native posts: ${detail.count}${detail.total ? ` / ${detail.total}` : ""} · page stays still`
      );
      console.info(`${PREFIX} Loaded ${detail.count}${detail.total ? ` of about ${detail.total}` : ""} posts…`);
    } else if (detail.phase === "cache-hit") {
      state.mode = "loading";
      showStatus(`No new posts · restoring ${detail.count} saved native posts…`);
      console.info(`${PREFIX} Cache hit for ${detail.count} posts; no pagination needed.`);
    } else if (detail.phase === "saving") {
      state.mode = "loading";
      showStatus(`Loaded ${detail.count} native posts · saving for next time…`);
    } else if (detail.phase === "complete") {
      state.mode = "oldest";
      showStatus(
        detail.cached
          ? `Done instantly: ${detail.count} saved posts, oldest first`
          : `Done: ${detail.count} native posts, oldest first`,
        "success",
        6500
      );
      console.info(
        `${PREFIX} Showing ${detail.count} native posts oldest first${detail.cached ? " from cache" : ""}.`
      );
    } else if (detail.phase === "restored") {
      state.mode = "newest";
      showStatus("Restored Instagram's normal newest-first grid.", "success", 4500);
      console.info(`${PREFIX} Restored newest-first order.`);
    } else if (detail.phase === "error") {
      state.mode = "newest";
      showStatus(`Could not load posts: ${detail.message}`, "error");
      console.error(`${PREFIX} ${detail.message}`);
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "instagram-oldest-first:toggle") toggle();
  });

  document.addEventListener("keydown", (event) => {
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === "KeyO") {
      event.preventDefault();
      toggle();
    }
  }, true);

  document.documentElement.setAttribute(READY_ATTRIBUTE, "");
})();
