/* ============================================================
   Max Potential Learning — shared interactions
   ============================================================ */
(function () {
  "use strict";

  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Navigation: scroll state + mobile menu ---------- */
  const nav = document.querySelector(".nav");
  if (nav) {
    const onScroll = () => nav.classList.toggle("is-scrolled", window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    const toggle = nav.querySelector(".nav__toggle");
    const mobile = nav.querySelector(".nav__mobile");
    if (toggle && mobile) {
      const setOpen = (open) => {
        nav.classList.toggle("is-open", open);
        toggle.setAttribute("aria-expanded", String(open));
        document.body.style.overflow = open ? "hidden" : "";
      };
      toggle.addEventListener("click", () => setOpen(!nav.classList.contains("is-open")));
      mobile.querySelectorAll("a").forEach((a) =>
        a.addEventListener("click", () => setOpen(false))
      );
      window.addEventListener("keydown", (e) => {
        if (e.key === "Escape") setOpen(false);
      });
    }
  }

  /* ============================================================
     Graceful error handling for links/buttons with no destination.
     OWASP-friendly fail-safe: never fail silently, never execute
     unexpected URL schemes, and never inject untrusted markup.
     ============================================================ */
  const TOAST_MAX = 3; // cap the stack so rapid clicks can't flood the screen
  function showToast(message, opts) {
    opts = opts || {};
    const duration = opts.duration || 3600;
    let region = document.getElementById("mpl-toast-region");
    if (!region) {
      region = document.createElement("div");
      region.id = "mpl-toast-region";
      region.className = "toast-region";
      region.setAttribute("role", "region");
      region.setAttribute("aria-label", "Notifications");
      document.body.appendChild(region);
    }

    // Dedupe: if this exact message is already on screen, just restart its
    // timer instead of stacking duplicates (e.g. a spam-clicked dead link).
    const dupe = Array.from(region.querySelectorAll(".toast")).find(
      (t) => t.dataset.msg === message
    );
    if (dupe && dupe._resetTimer) { dupe._resetTimer(); return; }

    // Cap the stack: dismiss the oldest if we're at the limit.
    const live = region.querySelectorAll(".toast");
    if (live.length >= TOAST_MAX && live[0]._dismiss) live[0]._dismiss();

    const toast = document.createElement("div");
    toast.className = "toast toast--error";
    toast.setAttribute("role", "alert"); // assertive, announced by screen readers
    toast.dataset.msg = message;

    const icon = document.createElement("span");
    icon.className = "toast__icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "!";

    const text = document.createElement("span");
    text.className = "toast__msg";
    // textContent (never innerHTML) => message/route data can never inject HTML.
    text.textContent = message;

    toast.append(icon, text);
    region.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("toast--in"));

    let timer;
    const dismiss = () => {
      clearTimeout(timer);
      toast.classList.remove("toast--in");
      const done = () => { if (toast.parentNode) toast.parentNode.removeChild(toast); };
      toast.addEventListener("transitionend", done, { once: true });
      setTimeout(done, 400); // fallback if transitionend never fires
    };
    const resetTimer = () => { clearTimeout(timer); timer = setTimeout(dismiss, duration); };
    toast._dismiss = dismiss;
    toast._resetTimer = resetTimer;
    resetTimer();
    toast.addEventListener("click", dismiss);
  }

  // A link/button has no usable destination if href is absent, empty,
  // a bare "#", or a javascript: URL (which is also an XSS smell).
  function isDeadDestination(href) {
    if (href === null || href === undefined) return true;
    const v = String(href).trim();
    if (v === "" || v === "#") return true;
    if (/^\s*javascript:/i.test(v)) return true;
    return false;
  }

  document.addEventListener("click", (e) => {
    const el = e.target.closest("a, button");
    if (!el) return;

    if (el.tagName === "A") {
      if (isDeadDestination(el.getAttribute("href"))) {
        e.preventDefault();
        showToast("Error — please try a different route.");
      }
      return;
    }

    // <button>: only guard CTA-styled buttons that aren't already wired to act.
    if (el.tagName === "BUTTON") {
      if (el.classList.contains("nav__toggle")) return; // has its own handler
      if (el.type === "submit" || el.type === "reset") return; // form-bound
      if (el.dataset.action) return; // explicitly handled elsewhere
      if (el.classList.contains("btn")) {
        e.preventDefault();
        showToast("Error — please try a different route.");
      }
    }
  });

  /* ---------- Infinite marquee: duplicate the set ---------- */
  document.querySelectorAll(".marquee__track").forEach((track) => {
    const originals = Array.from(track.children);
    originals.forEach((node) => {
      const clone = node.cloneNode(true);
      clone.setAttribute("aria-hidden", "true");
      track.appendChild(clone);
    });
  });

  /* ---------- Reveal on scroll (with stagger) ---------- */
  document.querySelectorAll("[data-stagger]").forEach((group) => {
    Array.from(group.children).forEach((child, i) => {
      if (child.classList.contains("reveal")) {
        child.style.setProperty("--reveal-delay", `${Math.min(i * 70, 420)}ms`);
      }
    });
  });

  const revealEls = document.querySelectorAll(".reveal");
  if (prefersReduced || !("IntersectionObserver" in window)) {
    revealEls.forEach((el) => el.classList.add("is-in"));
  } else {
    const io = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            obs.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );
    revealEls.forEach((el) => io.observe(el));
  }

  /* ---------- Count-up numbers ---------- */
  const counters = document.querySelectorAll("[data-count]");
  if (counters.length) {
    const runCount = (el) => {
      const target = parseFloat(el.dataset.count);
      const suffix = el.dataset.suffix || "";
      const prefix = el.dataset.prefix || "";
      if (prefersReduced) {
        el.textContent = prefix + target + suffix;
        return;
      }
      const dur = 1400;
      const start = performance.now();
      const tick = (now) => {
        const p = Math.min((now - start) / dur, 1);
        const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
        el.textContent = prefix + Math.round(target * eased) + suffix;
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    if (!("IntersectionObserver" in window)) {
      counters.forEach(runCount);
    } else {
      const cio = new IntersectionObserver(
        (entries, obs) => {
          entries.forEach((e) => {
            if (e.isIntersecting) {
              runCount(e.target);
              obs.unobserve(e.target);
            }
          });
        },
        { threshold: 0.6 }
      );
      counters.forEach((el) => cio.observe(el));
    }
  }

})();
