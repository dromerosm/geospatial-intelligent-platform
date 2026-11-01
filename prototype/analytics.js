// Google Analytics 4 with prior consent. Every site of Diego's ships this same
// file; only the constants at the top change. It is a same-origin file, not an
// inline script, and the banner is styled through the DOM, so a strict CSP only
// needs https://www.googletagmanager.com in script-src.
//
// Nothing reaches Google before the visitor presses "Accept": gtag.js is not
// loaded and no _ga cookie is set. The choice (accept or reject) is kept for 12
// months in a first-party cookie shared by every site under CONSENT_DOMAIN. Any
// element with data-cookie-settings reopens the banner, so consent can be
// withdrawn as easily as it was given; rejecting deletes the _ga cookies.
(() => {
  const GA_MEASUREMENT_ID = "G-B8118TCBQY";
  // gtag.js loads on the live site only. Local and preview builds (localhost,
  // Tailscale IPs, *.pages.dev, *.workers.dev) never send anything to GA4.
  const GA_LIVE_HOST = /(^|\.)diegoromero\.es$/;
  // The consent cookie, and the _ga cookies GA4 sets, live on this domain.
  const CONSENT_DOMAIN = "diegoromero.es";
  const POLICY_URL = {"es": "https://diegoromero.es/cookies/", "en": "https://diegoromero.es/en/cookies/"};
  const SCOPE = {"es": "Tu elección vale para todos los sitios de diegoromero.es.", "en": "Your choice applies to every site on diegoromero.es."};
  // Raise when the purposes change, so everyone is asked again.
  const CONSENT_VERSION = 1;
  const CONSENT_COOKIE = "cookie_consent";
  const YEAR = 365 * 24 * 60 * 60;
  const GA_COOKIE_SECONDS = 395 * 24 * 60 * 60; // 13 months instead of Google's 2 years

  const lang = document.documentElement.lang.toLowerCase().startsWith("es") ? "es" : "en";
  const TEXT = {
    es: {
      label: "Aviso de cookies",
      body: `Usamos Google Analytics para saber, de forma agregada, qué páginas se visitan. Solo se activa si aceptas: entonces guarda las cookies _ga y envía datos de tu visita a Google. ${SCOPE.es} Puedes cambiarla cuando quieras en «Configurar cookies».`,
      policy: "Política de cookies",
      accept: "Aceptar",
      reject: "Rechazar",
      now: { granted: "Ahora: aceptadas.", denied: "Ahora: rechazadas." },
    },
    en: {
      label: "Cookie notice",
      body: `We use Google Analytics to learn, in aggregate, which pages are visited. It only starts if you accept: it then stores the _ga cookies and sends data about your visit to Google. ${SCOPE.en} You can change it at any time under "Cookie settings".`,
      policy: "Cookie policy",
      accept: "Accept",
      reject: "Reject",
      now: { granted: "Current choice: accepted.", denied: "Current choice: rejected." },
    },
  }[lang];

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function gtag() { window.dataLayer.push(arguments); };
  window.gtag("consent", "default", { analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });
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
    cookie_expires: GA_COOKIE_SECONDS,
    ...(isInternalTraffic && { traffic_type: "internal" }),
  });

  // On a live host the cookie is shared by the whole domain; elsewhere it stays on the host.
  const onConsentDomain = location.hostname === CONSENT_DOMAIN || location.hostname.endsWith(`.${CONSENT_DOMAIN}`);
  const domainAttr = onConsentDomain ? `; Domain=.${CONSENT_DOMAIN}` : "";
  const secureAttr = location.protocol === "https:" ? "; Secure" : "";

  function readChoice() {
    const match = document.cookie.match(new RegExp(`(?:^|; )${CONSENT_COOKIE}=v(\\d+)\\.(granted|denied)`));
    return match && Number(match[1]) === CONSENT_VERSION ? match[2] : null;
  }
  function saveChoice(choice) {
    document.cookie = `${CONSENT_COOKIE}=v${CONSENT_VERSION}.${choice}; Max-Age=${YEAR}; Path=/; SameSite=Lax${domainAttr}${secureAttr}`;
  }
  function deleteGaCookies() {
    for (const part of document.cookie.split("; ")) {
      const name = part.split("=")[0];
      if (!/^_ga(_|$)/.test(name)) continue;
      for (const domain of ["", `; Domain=.${CONSENT_DOMAIN}`, `; Domain=${location.hostname}`]) {
        document.cookie = `${name}=; Max-Age=0; Path=/${domain}`;
      }
    }
  }

  let loaded = false;
  function loadGtag() {
    if (loaded || !GA_LIVE_HOST.test(location.hostname)) return;
    loaded = true;
    const tag = document.createElement("script");
    tag.async = true;
    tag.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
    document.head.appendChild(tag);
  }
  // A returning visitor who accepted: gtag.js waits for the first interaction,
  // an idle moment (3.5 s at most) or the page being hidden, so it stays off
  // the page's critical path. Events queued before then are sent when it loads.
  function loadGtagLazily() {
    for (const event of ["pointerdown", "keydown", "touchstart", "scroll"]) {
      window.addEventListener(event, loadGtag, { passive: true, once: true });
    }
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") loadGtag();
    });
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(loadGtag, { timeout: 3500 });
    } else {
      window.setTimeout(loadGtag, 3500);
    }
  }
  function grant() {
    window[`ga-disable-${GA_MEASUREMENT_ID}`] = false;
    window.gtag("consent", "update", { analytics_storage: "granted" });
  }
  function deny() {
    window[`ga-disable-${GA_MEASUREMENT_ID}`] = true;
    window.gtag("consent", "update", { analytics_storage: "denied" });
    deleteGaCookies();
  }

  // The banner: not modal and never in the way of the page. Accept and Reject
  // look the same. Styles are set through the DOM so a strict CSP allows them.
  let banner;
  let opener;
  function style(el, rules) {
    Object.assign(el.style, rules);
    return el;
  }
  function button(label, onClick) {
    const b = style(document.createElement("button"), {
      font: "inherit", fontWeight: "600", minWidth: "104px", minHeight: "44px", padding: "8px 18px",
      border: "1px solid #1b1f24", borderRadius: "6px", background: "#1b1f24", color: "#ffffff", cursor: "pointer",
    });
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }
  function choose(choice) {
    saveChoice(choice);
    if (choice === "granted") { grant(); loadGtag(); } else { deny(); }
    closeBanner();
  }
  function closeBanner() {
    banner?.remove();
    banner = null;
    if (opener && document.contains(opener)) opener.focus();
    opener = null;
  }
  function openBanner(focus) {
    if (banner) { if (focus) banner.querySelector("button").focus(); return; }
    banner = style(document.createElement("section"), {
      position: "fixed", left: "12px", right: "12px", bottom: "12px", zIndex: "2147483000",
      maxWidth: "680px", margin: "0 auto", boxSizing: "border-box",
      display: "flex", flexWrap: "wrap", alignItems: "center", gap: "12px 16px", padding: "14px 16px",
      background: "#ffffff", color: "#1b1f24", border: "1px solid #c9ced6", borderRadius: "10px",
      boxShadow: "0 6px 24px rgba(0, 0, 0, 0.25)",
      font: "14px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif", textAlign: "left",
    });
    banner.setAttribute("aria-label", TEXT.label);
    const text = style(document.createElement("p"), { flex: "1 1 320px", margin: "0" });
    const current = readChoice();
    text.textContent = `${current ? `${TEXT.now[current]} ` : ""}${TEXT.body} `;
    const link = style(document.createElement("a"), { color: "#1f5fae", textDecoration: "underline" });
    link.href = POLICY_URL[lang];
    link.textContent = TEXT.policy;
    text.append(link, ".");
    const actions = style(document.createElement("div"), { display: "flex", gap: "8px", flex: "0 0 auto" });
    actions.append(button(TEXT.accept, () => choose("granted")), button(TEXT.reject, () => choose("denied")));
    banner.append(text, actions);
    document.body.append(banner);
    if (focus) banner.querySelector("button").focus();
  }

  // "Cookie settings" links reopen the banner. They point to the policy, so
  // without JavaScript they still lead somewhere useful.
  document.addEventListener("click", (event) => {
    const trigger = event.target instanceof Element ? event.target.closest("[data-cookie-settings]") : null;
    if (!trigger) return;
    event.preventDefault();
    opener = trigger;
    openBanner(true);
  });
  window.cookieConsent = { open: () => openBanner(true) };

  const choice = readChoice();
  if (choice === "granted") {
    grant();
    loadGtagLazily();
  } else if (choice === "denied") {
    deny();
  } else if (document.body) {
    openBanner(false);
  } else {
    document.addEventListener("DOMContentLoaded", () => openBanner(false), { once: true });
  }
})();
