// Google Analytics 4. Every site of Diego's ships this same file; only the two
// constants below change. It is a same-origin file, not an inline script, so a
// strict CSP only needs https://www.googletagmanager.com in script-src.
(() => {
  const GA_MEASUREMENT_ID = "G-B8118TCBQY";
  // gtag.js loads on the live site only. Local and preview builds (localhost,
  // Tailscale IPs, *.pages.dev, *.workers.dev) send nothing to GA4.
  const GA_LIVE_HOST = /(^|\.)diegoromero\.es$/;

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function gtag() { window.dataLayer.push(arguments); };
  window.gtag("js", new Date());

  // Visit any page with ?internal=1 once per browser to exclude your own
  // traffic (GA4 "Internal Traffic" filter); ?internal=0 undoes it.
  const isInternalTraffic = (() => {
    try {
      const flag = new URLSearchParams(location.search).get("internal");
      if (flag === "1") localStorage.setItem("ga_internal", "1");
      if (flag === "0") localStorage.removeItem("ga_internal");
      return localStorage.getItem("ga_internal") === "1";
    } catch {
      return false;
    }
  })();

  window.gtag("config", GA_MEASUREMENT_ID, {
    anonymize_ip: true,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    ...(isInternalTraffic && { traffic_type: "internal" }),
  });

  if (!GA_LIVE_HOST.test(location.hostname)) return;

  // gtag.js waits for the first interaction, an idle moment (3.5 s at most) or
  // the page being hidden, so it stays off the page's critical path. Events
  // queued in dataLayer before then are sent when it loads.
  let loaded = false;
  const load = () => {
    if (loaded) return;
    loaded = true;
    const tag = document.createElement("script");
    tag.async = true;
    tag.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
    document.head.appendChild(tag);
  };
  for (const event of ["pointerdown", "keydown", "touchstart", "scroll"]) {
    window.addEventListener(event, load, { passive: true, once: true });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") load();
  });
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(load, { timeout: 3500 });
  } else {
    window.setTimeout(load, 3500);
  }
})();
