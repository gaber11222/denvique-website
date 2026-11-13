const APP_URL: &str = "https://csconweb-remote.hatchable.site/";

const LIVE_SITE_MONITOR: &str = r#"
(() => {
  const APP_ORIGIN = "https://csconweb-remote.hatchable.site";
  if (window.top !== window || location.origin !== APP_ORIGIN) return;
  if (window.__denviqueDesktopLiveMonitor) return;
  window.__denviqueDesktopLiveMonitor = true;

  let currentEtag = null;
  let updatePending = false;
  let lastActivity = Date.now();
  let requestRunning = false;

  const isEditing = () => {
    const el = document.activeElement;
    if (!el) return false;
    const tag = String(el.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true;
  };

  const pollVersion = async () => {
    if (requestRunning || document.visibilityState !== "visible") return;
    requestRunning = true;
    try {
      const response = await fetch(APP_ORIGIN + "/", {
        method: "HEAD",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Cache-Control": "no-cache" }
      });
      const etag = response.headers.get("etag");
      if (response.ok && etag) {
        if (currentEtag === null) currentEtag = etag;
        else if (etag !== currentEtag) {
          currentEtag = etag;
          updatePending = true;
        }
      }
    } catch (_) {
      // Temporary network loss must not interrupt work or sign the user out.
    } finally {
      requestRunning = false;
    }

    if (
      updatePending &&
      document.visibilityState === "visible" &&
      !isEditing() &&
      Date.now() - lastActivity >= 45000
    ) {
      location.reload();
    }
  };

  ["pointerdown", "keydown", "touchstart", "wheel", "scroll", "focusin"].forEach((name) => {
    document.addEventListener(name, () => { lastActivity = Date.now(); }, { capture: true, passive: true });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      lastActivity = Date.now();
      pollVersion();
    }
  });

  window.setInterval(pollVersion, 30000);
  window.setTimeout(pollVersion, 8000);
})();
"#;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let url = APP_URL.parse().expect("DENVique app URL must be valid");
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(url),
            )
            .title("DENVique")
            .inner_size(1440.0, 920.0)
            .min_inner_size(960.0, 640.0)
            .resizable(true)
            .initialization_script(LIVE_SITE_MONITOR)
            .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running DENVique desktop");
}
