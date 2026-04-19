/**
 * @fileoverview 诗行拆字；云朵平移；Canvas 连续随机雨线；雨带下字母高速大范围坠落。
 */

(function () {
  "use strict";

  /** @type {HTMLElement | null} */
  const poemRoot = document.getElementById("poem");
  /** @type {HTMLElement | null} */
  const fallLayer = document.getElementById("fallLayer");
  /** @type {HTMLElement | null} */
  const cloudPack = document.getElementById("cloudPack");
  /** @type {HTMLElement | null} */
  const cloudRail = document.getElementById("cloudRail");
  /** @type {HTMLElement | null} */
  const rainColumn = document.getElementById("rainColumn");
  /** @type {HTMLCanvasElement | null} */
  const rainCanvas = document.getElementById("rainCanvas");

  if (!poemRoot || !fallLayer || !cloudPack) return;

  /** 单次按键水平移动量（px） */
  const CLOUD_STEP = 28;
  /** 云朵左缘与视口边距（px） */
  const VIEW_EDGE = 12;
  /**
   * 雨带命中范围左右扩展（px），雨柱宽度已与云朵 icon 同宽，此处略扩以利边缘字符判定。
   */
  const RAIN_BAND_PAD = 8;
  /** 雨幕向下多绘一段，形成「穿出屏幕」的连续感（px） */
  const RAIN_BELOW_FOLD = 100;

  /** localStorage 键 */
  const SETTINGS_STORAGE_KEY = "ambient_bg_demo_settings_v1";

  /**
   * 用户可调：雨与字共用竖直速度（px/s）。
   * @type {number}
   */
  let userFallSpeedPxPerSec = 72;

  /**
   * 用户可调：雨带宽度（px），以云朵中心对齐。
   * @type {number}
   */
  let userRainWidthPx = 72;

  /** 默认正文：空行分段 */
  const DEFAULT_POEM_TEXT =
    "Rain writes thin vertical laws across the page, and every letter waits to see if it may stand. A narrow streak lands first, then another, and the sentence starts to loosen at the seam.\n\n" +
    "Wishing me like to one more rich in hope, Featured like him like him with friends possessed, Desiring this man's art and that man's scope, With what I most enjoy contented least;\n\n" +
    "Yet in these thoughts myself almost despising, Haply I think on thee, and then my state, Like to the lark at break of day arising From sullen earth, sings hymns at heaven's gate;\n\n" +
    "For thy sweet love remembered such wealth brings That then I scorn to change my state with kings.";

  /** @type {number} */
  let cloudOffsetPx = 0;

  /** @type {number | null} */
  let timeoutId = null;
  /** @type {boolean} */
  let schedulerActive = false;

  /** @type {boolean} */
  let cloudDragging = false;
  /** @type {number} */
  let dragStartClientX = 0;
  /** @type {number} */
  let dragStartOffsetPx = 0;

  /** @type {CanvasRenderingContext2D | null} */
  let rainCtx = null;
  /** @type {number | null} */
  let rainRaf = null;

  /**
   * @typedef {{ x: number, y: number, len: number, vy: number, vyFactor: number, vx: number, w: number, o: number, jitterAmp: number }} RainDrop
   */

  /** @type {RainDrop[]} */
  let rainDrops = [];

  /** 上一帧雨柱尺寸，仅尺寸变化时重设 Canvas，避免拖拽时反复清空雨滴 */
  const lastRainSize = { w: 0, h: 0 };

  /** @type {number} */
  let lastRainFrameTs = 0;

  /**
   * @returns {boolean}
   */
  function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /**
   * 雨与字母共用的下落速度（px/s），减少动效时略降。
   * @returns {number}
   */
  function getSharedFallSpeedPxPerSec() {
    const base = userFallSpeedPxPerSec;
    return prefersReducedMotion() ? base * 0.32 : base;
  }

  /**
   * 调节速度滑块后，更新已有雨滴的 vy，避免与字母新速度不一致。
   * @returns {void}
   */
  function applyRainSpeedToDrops() {
    const vBase = getSharedFallSpeedPxPerSec();
    for (let i = 0; i < rainDrops.length; i += 1) {
      const d = rainDrops[i];
      d.vy = vBase * d.vyFactor;
    }
  }

  /**
   * 是否在输入控件内，避免抢走方向键。
   * @param {EventTarget | null} target
   * @returns {boolean}
   */
  function isTypingTarget(target) {
    if (!target || !(target instanceof Element)) return false;
    const el = target;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return el.closest("[contenteditable='true']") != null;
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
   * @returns {DOMRect}
   */
  function getRainBandRect() {
    if (rainColumn) {
      return rainColumn.getBoundingClientRect();
    }
    return cloudPack.getBoundingClientRect();
  }

  /**
   * 仅返回雨带水平投影下的字。
   * @returns {HTMLElement[]}
   */
  function getEligibleGlyphsUnderCloud() {
    const band = getRainBandRect();
    const left = band.left - RAIN_BAND_PAD;
    const right = band.right + RAIN_BAND_PAD;
    return getEligibleGlyphs().filter(function (glyph) {
      const r = glyph.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      return cx >= left && cx <= right;
    });
  }

  /**
   * 将云朵限制在视口内可见范围。
   * @returns {void}
   */
  function clampCloudIntoView() {
    cloudPack.style.setProperty("--cloud-offset", cloudOffsetPx + "px");
    const r = cloudPack.getBoundingClientRect();
    if (r.left < VIEW_EDGE) {
      cloudOffsetPx += VIEW_EDGE - r.left;
    }
    if (r.right > window.innerWidth - VIEW_EDGE) {
      cloudOffsetPx -= r.right - (window.innerWidth - VIEW_EDGE);
    }
    cloudPack.style.setProperty("--cloud-offset", cloudOffsetPx + "px");
    syncRainColumnLayout();
  }

  /**
   * 将雨幕对齐云底中心，并向下延伸超过视口底缘。
   * @returns {void}
   */
  function syncRainColumnLayout() {
    if (!rainColumn || !rainCanvas) return;
    const cloudEl = cloudPack.querySelector(".cloud");
    if (!cloudEl) return;
    const cb = cloudEl.getBoundingClientRect();
    const top = cb.bottom + 1;
    const wCol = Math.max(24, Math.min(420, Math.round(userRainWidthPx)));
    const cx = cb.left + cb.width / 2;
    const left = Math.round(cx - wCol / 2);
    const h = Math.max(32, window.innerHeight - top + RAIN_BELOW_FOLD);
    rainColumn.style.left = left + "px";
    rainColumn.style.top = top + "px";
    rainColumn.style.width = wCol + "px";
    rainColumn.style.height = h + "px";
    if (Math.abs(wCol - lastRainSize.w) > 0.5 || Math.abs(h - lastRainSize.h) > 0.5) {
      lastRainSize.w = wCol;
      lastRainSize.h = h;
      resizeRainCanvasAndInitDrops();
    }
  }

  /**
   * 按设备像素比设置 Canvas，并在尺寸变化时重生雨滴。
   * @returns {void}
   */
  function resizeRainCanvasAndInitDrops() {
    if (!rainCanvas || !rainColumn) return;
    const w = rainColumn.clientWidth;
    const h = rainColumn.clientHeight;
    if (w < 2 || h < 2) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    rainCanvas.width = Math.floor(w * dpr);
    rainCanvas.height = Math.floor(h * dpr);
    rainCtx = rainCanvas.getContext("2d", { alpha: true });
    if (!rainCtx) return;
    rainCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lastRainFrameTs = 0;
    initRainDrops(w, h);
  }

  /**
   * @param {number} w 逻辑宽度（css px）
   * @param {number} h 逻辑高度（css px）
   * @returns {void}
   */
  function initRainDrops(w, h) {
    const area = w * h;
    const n = Math.min(520, Math.max(110, Math.floor(area / 2200)));
    rainDrops = [];
    for (let i = 0; i < n; i += 1) {
      rainDrops.push(createRainDrop(w, h, true));
    }
  }

  /**
   * @param {number} w
   * @param {number} h
   * @param {boolean} scatterY 是否在整柱高度内散布初始 y
   * @returns {RainDrop}
   */
  function createRainDrop(w, h, scatterY) {
    const y0 = scatterY ? Math.random() * (h + 80) - 40 : -20 - Math.random() * h * 0.55;
    const vBase = getSharedFallSpeedPxPerSec();
    const vyFactor = 0.94 + Math.random() * 0.12;
    return {
      x: Math.random() * w,
      y: y0,
      len: 6 + Math.pow(Math.random(), 0.65) * 46,
      vyFactor: vyFactor,
      vy: vBase * vyFactor,
      vx: (Math.random() - 0.5) * 16,
      w: 0.3 + Math.random() * 2.1,
      o: 0.07 + Math.random() * 0.45,
      jitterAmp: 8 + Math.random() * 10,
    };
  }

  /**
   * 一帧雨线：按真实时间积分下落（vy 为 px/s），与字母匀速一致。
   * @param {number} ts performance.now
   * @returns {void}
   */
  function rainFrame(ts) {
    if (!rainCtx || !rainCanvas || !rainColumn) return;
    const w = rainColumn.clientWidth;
    const h = rainColumn.clientHeight;
    if (w < 2 || h < 2) return;

    const now = typeof ts === "number" ? ts : performance.now();
    if (!lastRainFrameTs) {
      lastRainFrameTs = now;
    }
    let dt = (now - lastRainFrameTs) / 1000;
    lastRainFrameTs = now;
    if (dt > 0.064) {
      dt = 0.064;
    }
    if (dt <= 0) {
      dt = 1 / 60;
    }

    const slow = prefersReducedMotion() ? 0.32 : 1;
    rainCtx.clearRect(0, 0, w, h);
    rainCtx.lineCap = "round";

    for (let i = 0; i < rainDrops.length; i += 1) {
      const d = rainDrops[i];
      d.x += (d.vx + (Math.random() - 0.5) * d.jitterAmp) * dt * slow;
      d.y += d.vy * dt * slow;
      if (d.x < -6) d.x = w + 6;
      if (d.x > w + 6) d.x = -6;
      if (d.y - d.len > h + 20) {
        const nd = createRainDrop(w, h, false);
        d.x = nd.x;
        d.y = nd.y;
        d.len = nd.len;
        d.vyFactor = nd.vyFactor;
        d.vy = nd.vy;
        d.vx = nd.vx;
        d.w = nd.w;
        d.o = nd.o;
        d.jitterAmp = nd.jitterAmp;
      }
      rainCtx.strokeStyle = "rgba(0,0,0," + d.o + ")";
      rainCtx.lineWidth = d.w;
      rainCtx.beginPath();
      rainCtx.moveTo(d.x, d.y);
      rainCtx.lineTo(d.x, d.y - d.len);
      rainCtx.stroke();
    }
  }

  /**
   * @param {number} ts
   * @returns {void}
   */
  function rainLoop(ts) {
    const now = typeof ts === "number" ? ts : performance.now();
    if (document.hidden) {
      rainRaf = window.requestAnimationFrame(rainLoop);
      return;
    }
    if (!rainCtx) {
      resizeRainCanvasAndInitDrops();
    }
    if (!rainCtx) {
      rainRaf = window.requestAnimationFrame(rainLoop);
      return;
    }
    rainFrame(now);
    rainRaf = window.requestAnimationFrame(rainLoop);
  }

  /**
   * 启动雨动画循环。
   * @returns {void}
   */
  function startRainLoop() {
    if (!rainCanvas || !rainColumn) return;
    if (rainRaf !== null) return;
    resizeRainCanvasAndInitDrops();
    rainLoop();
  }

  /**
   * 停止雨动画循环。
   * @returns {void}
   */
  function stopRainLoop() {
    if (rainRaf !== null) {
      window.cancelAnimationFrame(rainRaf);
      rainRaf = null;
    }
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
   * 触发单字坠落：竖直速度与雨线相同（fallDist / speed），似被雨打下。
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

    const speed = getSharedFallSpeedPxPerSec();
    const fallDist = window.innerHeight - rect.top + 72 + Math.random() * 48;
    /** 与雨同速时：duration = 竖直位移 / 竖直速度（linear 动画） */
    const durSec = Math.max(0.28, fallDist / speed);
    const driftPx = (Math.random() - 0.5) * 36;
    const spinDeg = (Math.random() - 0.5) * 14;
    clone.style.setProperty("--drift-x", driftPx + "px");
    clone.style.setProperty("--fall-dist", fallDist + "px");
    clone.style.setProperty("--spin", spinDeg + "deg");
    clone.style.setProperty("--fall-duration", durSec + "s");

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
   * @returns {void}
   */
  function tickFall() {
    if (prefersReducedMotion() || document.hidden) return;
    const pool = getEligibleGlyphsUnderCloud();
    if (pool.length === 0) return;
    const glyph = pickRandom(pool);
    if (glyph) releaseGlyph(glyph);
  }

  /**
   * @returns {void}
   */
  function scheduleNextFall() {
    if (!schedulerActive || prefersReducedMotion() || document.hidden) return;
    if (getEligibleGlyphs().length === 0) {
      schedulerActive = false;
      return;
    }
    const delay = 38 + Math.random() * 165;
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

  /**
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  function onKeyDown(e) {
    if (isTypingTarget(e.target)) return;
    const key = e.key;
    const goLeft = key === "ArrowLeft" || key === "a" || key === "A";
    const goRight = key === "ArrowRight" || key === "d" || key === "D";
    if (!goLeft && !goRight) return;
    e.preventDefault();
    if (goLeft) {
      cloudOffsetPx -= CLOUD_STEP;
    } else {
      cloudOffsetPx += CLOUD_STEP;
    }
    clampCloudIntoView();
  }

  /**
   * @param {PointerEvent} e
   * @returns {void}
   */
  function onCloudPointerDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    cloudDragging = true;
    dragStartClientX = e.clientX;
    dragStartOffsetPx = cloudOffsetPx;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch (_) {
      /* 忽略不支持 Pointer Capture 的环境 */
    }
  }

  /**
   * @param {PointerEvent} e
   * @returns {void}
   */
  function onCloudPointerMove(e) {
    if (!cloudDragging) return;
    cloudOffsetPx = dragStartOffsetPx + (e.clientX - dragStartClientX);
    clampCloudIntoView();
  }

  /**
   * @param {PointerEvent} e
   * @returns {void}
   */
  function onCloudPointerUp(e) {
    cloudDragging = false;
    try {
      if (
        e.currentTarget instanceof Element &&
        typeof e.currentTarget.hasPointerCapture === "function" &&
        e.currentTarget.hasPointerCapture(e.pointerId)
      ) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * @returns {void}
   */
  function onCloudLostCapture() {
    cloudDragging = false;
  }

  /**
   * 用纯文本重建正文（双换行分段），并重新拆字、清空坠落层。
   * @param {string} text
   * @returns {void}
   */
  function buildPoemFromPlainText(text) {
    poemRoot.innerHTML = "";
    const normalized = text.replace(/\r\n/g, "\n");
    const blocks = normalized
      .split(/\n\s*\n/)
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
    if (blocks.length === 0) {
      const p = document.createElement("p");
      p.textContent = " ";
      poemRoot.appendChild(p);
    } else {
      blocks.forEach(function (block) {
        const p = document.createElement("p");
        p.textContent = block.replace(/\n/g, " ");
        poemRoot.appendChild(p);
      });
    }
    wrapPoemCharacters(poemRoot);
    fallLayer.innerHTML = "";
    syncScheduler();
  }

  /** @type {number | null} */
  let poemInputDebounceTimer = null;

  /**
   * @returns {void}
   */
  function schedulePoemRebuildFromTextarea() {
    const ta = document.getElementById("settingPoemText");
    if (!ta) return;
    if (poemInputDebounceTimer !== null) {
      window.clearTimeout(poemInputDebounceTimer);
    }
    poemInputDebounceTimer = window.setTimeout(function () {
      poemInputDebounceTimer = null;
      buildPoemFromPlainText(ta.value);
      scheduleSaveSettings();
    }, 200);
  }

  /** @type {number | null} */
  let saveSettingsTimer = null;

  /**
   * @returns {void}
   */
  function saveSettingsToStorage() {
    try {
      const ta = document.getElementById("settingPoemText");
      localStorage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify({
          fallSpeed: userFallSpeedPxPerSec,
          rainWidth: userRainWidthPx,
          poemText: ta ? ta.value : "",
        })
      );
    } catch (_) {
      /* 忽略配额或隐私模式 */
    }
  }

  /**
   * @returns {void}
   */
  function scheduleSaveSettings() {
    if (saveSettingsTimer !== null) {
      window.clearTimeout(saveSettingsTimer);
    }
    saveSettingsTimer = window.setTimeout(function () {
      saveSettingsTimer = null;
      saveSettingsToStorage();
    }, 400);
  }

  /**
   * 从 localStorage 恢复数值与正文；若无存储则写入默认诗。
   * @returns {void}
   */
  function initSettingsStateAndPoem() {
    /** @type {HTMLTextAreaElement | null} */
    const ta = /** @type {HTMLTextAreaElement | null} */ (document.getElementById("settingPoemText"));
    /** @type {HTMLInputElement | null} */
    const speedInput = /** @type {HTMLInputElement | null} */ (document.getElementById("settingRainSpeed"));
    /** @type {HTMLInputElement | null} */
    const widthInput = /** @type {HTMLInputElement | null} */ (document.getElementById("settingRainWidth"));
    /** @type {HTMLElement | null} */
    const speedVal = document.getElementById("settingRainSpeedVal");
    /** @type {HTMLElement | null} */
    const widthVal = document.getElementById("settingRainWidthVal");

    let hadStorage = false;
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (raw) {
        hadStorage = true;
        const j = JSON.parse(raw);
        if (typeof j.fallSpeed === "number") {
          userFallSpeedPxPerSec = Math.min(220, Math.max(18, j.fallSpeed));
        }
        if (typeof j.rainWidth === "number") {
          userRainWidthPx = Math.min(420, Math.max(24, j.rainWidth));
        }
        if (typeof j.poemText === "string" && j.poemText.trim().length > 0) {
          if (ta) ta.value = j.poemText;
          buildPoemFromPlainText(j.poemText);
        } else {
          if (ta) ta.value = DEFAULT_POEM_TEXT;
          buildPoemFromPlainText(DEFAULT_POEM_TEXT);
        }
      }
    } catch (_) {
      hadStorage = false;
    }

    if (!hadStorage) {
      if (ta) ta.value = DEFAULT_POEM_TEXT;
      buildPoemFromPlainText(DEFAULT_POEM_TEXT);
    }

    if (speedInput) speedInput.value = String(userFallSpeedPxPerSec);
    if (speedVal) speedVal.textContent = String(userFallSpeedPxPerSec);
    if (widthInput) widthInput.value = String(userRainWidthPx);
    if (widthVal) widthVal.textContent = String(userRainWidthPx);
  }

  /**
   * 首次无存储时，将雨宽对齐云朵 icon 实际宽度。
   * @returns {void}
   */
  function syncInitialRainWidthFromCloud() {
    let skip = false;
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (raw) {
        const j = JSON.parse(raw);
        if (typeof j.rainWidth === "number") skip = true;
      }
    } catch (_) {
      skip = false;
    }
    if (skip) return;
    const cloudEl = cloudPack.querySelector(".cloud");
    if (!cloudEl) return;
    const w = Math.max(24, Math.min(420, Math.round(cloudEl.getBoundingClientRect().width)));
    userRainWidthPx = w;
    const widthInput = /** @type {HTMLInputElement | null} */ (document.getElementById("settingRainWidth"));
    const widthVal = document.getElementById("settingRainWidthVal");
    if (widthInput) widthInput.value = String(w);
    if (widthVal) widthVal.textContent = String(w);
    syncRainColumnLayout();
    scheduleSaveSettings();
  }

  /**
   * @param {boolean} open
   * @returns {void}
   */
  function setSettingsDrawerOpen(open) {
    const panel = document.getElementById("settingsPanel");
    const scrim = document.getElementById("settingsScrim");
    const btn = document.getElementById("settingsTrigger");
    if (!panel || !scrim || !btn) return;
    panel.classList.toggle("is-open", open);
    scrim.classList.toggle("is-visible", open);
    panel.setAttribute("aria-hidden", open ? "false" : "true");
    scrim.setAttribute("aria-hidden", open ? "false" : "true");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    document.body.classList.toggle("settings-open", open);
  }

  /**
   * @returns {void}
   */
  function toggleSettingsDrawer() {
    const panel = document.getElementById("settingsPanel");
    if (!panel) return;
    setSettingsDrawerOpen(!panel.classList.contains("is-open"));
  }

  initSettingsStateAndPoem();

  cloudPack.style.setProperty("--cloud-offset", "0px");
  clampCloudIntoView();
  window.requestAnimationFrame(function () {
    syncInitialRainWidthFromCloud();
  });
  syncScheduler();
  startRainLoop();

  document.addEventListener("keydown", onKeyDown, true);

  if (document.body) {
    document.body.addEventListener("click", function () {
      try {
        document.body.focus({ preventScroll: true });
      } catch (_) {
        document.body.focus();
      }
    });
    window.addEventListener("load", function () {
      try {
        document.body.focus({ preventScroll: true });
      } catch (_) {
        document.body.focus();
      }
    });
  }

  if (cloudRail) {
    cloudRail.addEventListener("pointerdown", onCloudPointerDown);
    cloudRail.addEventListener("pointermove", onCloudPointerMove);
    cloudRail.addEventListener("pointerup", onCloudPointerUp);
    cloudRail.addEventListener("pointercancel", onCloudPointerUp);
    cloudRail.addEventListener("lostpointercapture", onCloudLostCapture);
  }

  window.addEventListener("resize", function () {
    clampCloudIntoView();
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      schedulerActive = false;
      stopRainLoop();
    } else {
      syncScheduler();
      syncRainColumnLayout();
      startRainLoop();
    }
  });

  window
    .matchMedia("(prefers-reduced-motion: reduce)")
    .addEventListener("change", function () {
      syncScheduler();
      syncRainColumnLayout();
      applyRainSpeedToDrops();
    });

  const settingsTrigger = document.getElementById("settingsTrigger");
  const settingsClose = document.getElementById("settingsClose");
  const settingsScrim = document.getElementById("settingsScrim");
  const settingRainSpeed = /** @type {HTMLInputElement | null} */ (document.getElementById("settingRainSpeed"));
  const settingRainWidth = /** @type {HTMLInputElement | null} */ (document.getElementById("settingRainWidth"));
  const settingRainSpeedVal = document.getElementById("settingRainSpeedVal");
  const settingRainWidthVal = document.getElementById("settingRainWidthVal");
  const settingPoemText = /** @type {HTMLTextAreaElement | null} */ (document.getElementById("settingPoemText"));

  if (settingsTrigger) {
    settingsTrigger.addEventListener("click", function () {
      toggleSettingsDrawer();
    });
  }
  if (settingsClose) {
    settingsClose.addEventListener("click", function () {
      setSettingsDrawerOpen(false);
    });
  }
  if (settingsScrim) {
    settingsScrim.addEventListener("click", function () {
      setSettingsDrawerOpen(false);
    });
  }

  if (settingRainSpeed) {
    settingRainSpeed.addEventListener("input", function () {
      const v = Number(settingRainSpeed.value);
      userFallSpeedPxPerSec = Math.min(220, Math.max(18, v));
      if (settingRainSpeedVal) settingRainSpeedVal.textContent = String(userFallSpeedPxPerSec);
      applyRainSpeedToDrops();
      scheduleSaveSettings();
    });
  }

  if (settingRainWidth) {
    settingRainWidth.addEventListener("input", function () {
      const v = Number(settingRainWidth.value);
      userRainWidthPx = Math.min(420, Math.max(24, v));
      if (settingRainWidthVal) settingRainWidthVal.textContent = String(userRainWidthPx);
      syncRainColumnLayout();
      scheduleSaveSettings();
    });
  }

  if (settingPoemText) {
    settingPoemText.addEventListener("input", function () {
      schedulePoemRebuildFromTextarea();
    });
  }

  document.addEventListener(
    "keydown",
    function (e) {
      if (e.key !== "Escape") return;
      const panel = document.getElementById("settingsPanel");
      if (panel && panel.classList.contains("is-open")) {
        setSettingsDrawerOpen(false);
      }
    },
    true
  );
})();
