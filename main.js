/**
 * @fileoverview 将诗行拆成逐字节点，并随机让字符脱落坠向画面底部；尊重 prefers-reduced-motion 与页面可见性。
 */

(function () {
  "use strict";

  /** @type {HTMLElement | null} */
  const poemRoot = document.getElementById("poem");
  /** @type {HTMLElement | null} */
  const fallLayer = document.getElementById("fallLayer");

  if (!poemRoot || !fallLayer) return;

  /** @type {number | null} */
  let timeoutId = null;
  /** @type {boolean} */
  let schedulerActive = false;

  /**
   * @returns {boolean}
   */
  function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /**
   * 将段落中的可脱落字符包进 slot/glyph，空格保留为普通空格。
   * @param {HTMLElement} root
   * @returns {void}
   */
  function wrapPoemCharacters(root) {
    const paragraphs = root.querySelectorAll("p");
    paragraphs.forEach(function (p) {
      const text = p.textContent || "";
      p.textContent = "";
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === " ") {
          p.appendChild(document.createTextNode(" "));
          continue;
        }
        const slot = document.createElement("span");
        slot.className = "slot";
        const glyph = document.createElement("span");
        glyph.className = "glyph";
        glyph.textContent = ch;
        slot.appendChild(glyph);
        p.appendChild(slot);
      }
    });
  }

  /**
   * @returns {HTMLElement[]}
   */
  function getEligibleGlyphs() {
    /** @type {HTMLElement[]} */
    const out = [];
    poemRoot.querySelectorAll(".slot:not(.slot--empty) .glyph").forEach(function (el) {
      out.push(/** @type {HTMLElement} */ (el));
    });
    return out;
  }

  /**
   * 从数组中随机取一项。
   * @template T
   * @param {T[]} arr
   * @returns {T | undefined}
   */
  function pickRandom(arr) {
    if (arr.length === 0) return undefined;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /**
   * 触发单字坠落：克隆到 fixed 层并动画，原位留白。
   * @param {HTMLElement} glyph
   * @returns {void}
   */
  function releaseGlyph(glyph) {
    const slot = glyph.parentElement;
    if (!slot || !slot.classList.contains("slot")) return;

    const rect = glyph.getBoundingClientRect();
    const clone = /** @type {HTMLElement} */ (glyph.cloneNode(true));
    clone.classList.add("falling");
    clone.style.transform = "none";

    const driftPx = (Math.random() - 0.5) * 36;
    const spinDeg = (Math.random() - 0.5) * 14;
    const fallDist = window.innerHeight - rect.top + 24 + Math.random() * 40;
    clone.style.setProperty("--drift-x", driftPx + "px");
    clone.style.setProperty("--fall-dist", fallDist + "px");
    clone.style.setProperty("--spin", spinDeg + "deg");

    clone.style.left = rect.left + "px";
    clone.style.top = rect.top + "px";

    fallLayer.appendChild(clone);
    slot.classList.add("slot--empty");

    /**
     * @param {AnimationEvent} ev
     */
    function onEnd(ev) {
      if (ev.animationName !== "letter-fall") return;
      clone.removeEventListener("animationend", onEnd);
      clone.remove();
    }
    clone.addEventListener("animationend", onEnd);
  }

  /**
   * 随机尝试脱落一字；若已全部脱落则暂缓。
   * @returns {void}
   */
  function tickFall() {
    if (prefersReducedMotion() || document.hidden) return;
    const pool = getEligibleGlyphs();
    if (pool.length === 0) return;
    const glyph = pickRandom(pool);
    if (glyph) releaseGlyph(glyph);
  }

  /**
   * 递归随机间隔调度下一次脱落。
   * @returns {void}
   */
  function scheduleNextFall() {
    if (!schedulerActive || prefersReducedMotion() || document.hidden) return;
    if (getEligibleGlyphs().length === 0) {
      schedulerActive = false;
      return;
    }
    const delay = 380 + Math.random() * 980;
    timeoutId = window.setTimeout(function () {
      tickFall();
      if (getEligibleGlyphs().length === 0) {
        schedulerActive = false;
        timeoutId = null;
        return;
      }
      scheduleNextFall();
    }, delay);
  }

  /**
   * 启动/停止定时脱落。
   * @returns {void}
   */
  function syncScheduler() {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
      timeoutId = null;
    }
    schedulerActive = false;
    if (prefersReducedMotion()) return;
    schedulerActive = true;
    scheduleNextFall();
  }

  wrapPoemCharacters(poemRoot);
  syncScheduler();

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      schedulerActive = false;
    } else {
      syncScheduler();
    }
  });

  window
    .matchMedia("(prefers-reduced-motion: reduce)")
    .addEventListener("change", function () {
      syncScheduler();
    });
})();
