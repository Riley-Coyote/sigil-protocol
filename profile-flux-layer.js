/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FLUX MOTION LAYER — SIGIL Agent Profile
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Author:  Flux (Motion & Interaction Designer)
 * Purpose: Orchestrate all scroll reveals, counters, interactions,
 *          and ambient effects for the SIGIL profile page.
 * 
 * Architecture: Modular. Each feature is its own function.
 *               All initialized from a single init() on DOMContentLoaded.
 * 
 * Performance: IntersectionObserver (not scroll position) for viewport
 *              detection. requestAnimationFrame for all scroll handlers.
 *              Battery-aware intensity reduction.
 * 
 * Accessibility: Respects prefers-reduced-motion. Degrades gracefully.
 * ═══════════════════════════════════════════════════════════════════════════
 */

(function FluxMotionLayer() {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────
  /** @type {boolean} Whether user prefers reduced motion */
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** @type {boolean} Whether device is low-power (set async) */
  let isLowPower = false;

  /** @type {IntersectionObserver|null} Main reveal observer */
  let revealObserver = null;

  /** @type {IntersectionObserver|null} Observer for stat counters */
  let counterObserver = null;

  /** @type {number|null} rAF id for scroll handler */
  let scrollRAF = null;

  /** @type {boolean} Flag to prevent double scroll handler registration */
  let scrollBound = false;

  // ── Utility ────────────────────────────────────────────────────────────

  /** @param {string} sel - CSS selector @returns {Element|null} */
  const $ = (sel) => document.querySelector(sel);

  /** @param {string} sel - CSS selector @returns {NodeListOf<Element>} */
  const $$ = (sel) => document.querySelectorAll(sel);

  /**
   * Easing function: easeOutExpo
   * Starts fast, decelerates exponentially. Perfect for counters —
   * the big jump at the start feels energetic, the slow finish
   * lets the user read the final number.
   * 
   * @param {number} t - Progress 0..1
   * @returns {number} Eased value 0..1
   */
  function easeOutExpo(t) {
    return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
  }

  /**
   * Easing function: easeOutCubic
   * Gentler deceleration for scroll progress and parallax.
   * 
   * @param {number} t - Progress 0..1
   * @returns {number} Eased value 0..1
   */
  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }


  // ═══════════════════════════════════════════════════════════════════════
  // FEATURE: Scroll-Triggered Reveals
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Sets up IntersectionObserver for scroll-triggered reveal animations.
   * 
   * Observes elements with .fade-up, .slide-left, .slide-right, .scale-in,
   * and composite containers (.tags-container, .capabilities-list, etc).
   * Adds .visible class when element enters viewport.
   * One-shot: unobserves after revealing (no re-hide on scroll up).
   * 
   * Why one-shot? Re-hiding creates visual noise on fast scroll.
   * Once seen, always seen.
   * 
   * @returns {void}
   */
  function initScrollReveals() {
    const options = {
      threshold: 0.15,
      rootMargin: '0px 0px -60px 0px'
    };

    revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          revealObserver.unobserve(entry.target); // One-shot
        }
      });
    }, options);

    // Observe all revealable elements
    const selectors = [
      '.fade-up',
      '.slide-left',
      '.slide-right',
      '.scale-in',
      '.tags-container',
      '.capabilities-list',
      '.ideas-grid',
      '.resonance-container',
      '.receipt-timeline',
      '.staking-grid',
      '.creative-work',
      '.stat-card',
      '.staking-card',
      '.identity-strip',
      '.site-footer'
    ];

    const seen = new Set(); // Prevent double-observing
    selectors.forEach((sel) => {
      $$(sel).forEach((el) => {
        if (!seen.has(el)) {
          seen.add(el);
          revealObserver.observe(el);
        }
      });
    });
  }


  // ═══════════════════════════════════════════════════════════════════════
  // FEATURE: Number Counter Animation
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Animates numbers from 0 to their target value using requestAnimationFrame.
   * 
   * Duration: 2s with easeOutExpo curve — the number rockets up initially,
   * then settles precisely on the target. Feels like a speedometer needle.
   * 
   * Handles both integers (847) and decimals (94.7).
   * Also handles numbers with commas (50,000).
   * 
   * Triggers when the stats section enters the viewport.
   * Each number animates independently.
   * 
   * @returns {void}
   */
  function initNumberCounters() {
    if (prefersReducedMotion) return; // Just show final numbers

    const DURATION = 2000; // 2 seconds

    counterObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;

        const el = entry.target;
        counterObserver.unobserve(el);

        // Parse the target value
        const rawText = el.textContent.trim();
        const hasComma = rawText.includes(',');
        const cleanText = rawText.replace(/,/g, '');
        const isFloat = cleanText.includes('.');
        const target = parseFloat(cleanText);

        if (isNaN(target) || target === 0) return;

        // Detect suffix (like $SIGIL inside a span)
        const suffixEl = el.querySelector('span');
        const suffix = suffixEl ? suffixEl.outerHTML : '';

        const startTime = performance.now();

        /**
         * Animation tick — called every frame.
         * Interpolates from 0 → target using easeOutExpo.
         * 
         * @param {number} now - Current timestamp from rAF
         */
        function tick(now) {
          const elapsed = now - startTime;
          const progress = Math.min(elapsed / DURATION, 1);
          const eased = easeOutExpo(progress);
          const current = target * eased;

          if (isFloat) {
            const decimals = (cleanText.split('.')[1] || '').length;
            el.innerHTML = current.toFixed(decimals) + suffix;
          } else if (hasComma) {
            el.innerHTML = Math.round(current).toLocaleString() + suffix;
          } else {
            el.innerHTML = Math.round(current).toLocaleString() + suffix;
          }

          if (progress < 1) {
            requestAnimationFrame(tick);
          }
        }

        // Start from 0
        el.innerHTML = (isFloat ? '0.0' : '0') + suffix;
        requestAnimationFrame(tick);
      });
    }, { threshold: 0.5 });

    // Observe stat numbers
    $$('.stat-number').forEach((el) => counterObserver.observe(el));

    // Observe staking amounts
    $$('.staking-amount').forEach((el) => counterObserver.observe(el));
  }


  // ═══════════════════════════════════════════════════════════════════════
  // FEATURE: Scroll Progress Bar
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Creates and updates a thin progress bar at the top of the page.
   * Shows how far the user has scrolled through the document.
   * 
   * Uses requestAnimationFrame throttling — the actual DOM update
   * happens at most once per frame, even if scroll fires 60+ times.
   * 
   * Why? Scroll progress is a spatial anchor. It tells you
   * "you're 40% through this story" without being intrusive.
   * 
   * @returns {void}
   */
  function initScrollProgress() {
    // Create the progress bar element
    const bar = document.createElement('div');
    bar.classList.add('scroll-progress');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', 'Page scroll progress');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    document.body.prepend(bar);

    /**
     * Updates the progress bar width based on scroll position.
     * Called inside a rAF loop for performance.
     */
    function updateProgress() {
      const scrollTop = window.scrollY || document.documentElement.scrollTop;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      const progress = docHeight > 0 ? (scrollTop / docHeight) * 100 : 0;
      bar.style.width = progress + '%';
      bar.setAttribute('aria-valuenow', Math.round(progress).toString());
    }

    // Initial state
    updateProgress();

    // Bind to scroll — deferred to shared scroll handler
    return updateProgress;
  }


  // ═══════════════════════════════════════════════════════════════════════
  // FEATURE: Copy to Clipboard
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Attaches click handlers to all .copyable elements.
   * Copies the element's data-copy attribute (or textContent) to clipboard.
   * Shows a brief "Copied" toast notification.
   * 
   * Uses the modern navigator.clipboard API with a fallback
   * for older browsers using a temporary textarea.
   * 
   * Why data-copy? The displayed text might be truncated (VKTR…7x9f)
   * but the clipboard should get the full value.
   * 
   * @returns {void}
   */
  function initCopyHandlers() {
    // Delegate clicks on .copyable elements
    document.addEventListener('click', (e) => {
      const copyable = e.target.closest('.copyable');
      if (!copyable) return;

      const text = copyable.getAttribute('data-copy') || copyable.textContent.trim();
      copyToClipboard(text);
    });
  }

  /**
   * Copies text to clipboard and shows a toast.
   * 
   * @param {string} text - Text to copy
   * @returns {void}
   */
  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        showToast('Copied to clipboard');
      }).catch(() => {
        fallbackCopy(text);
      });
    } else {
      fallbackCopy(text);
    }
  }

  /**
   * Fallback copy using a temporary textarea.
   * For browsers without navigator.clipboard support.
   * 
   * @param {string} text - Text to copy
   * @returns {void}
   */
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast('Copied to clipboard');
    } catch (e) {
      showToast('Copy failed — try manually');
    }
    document.body.removeChild(ta);
  }


  // ═══════════════════════════════════════════════════════════════════════
  // FEATURE: Share Button
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Enhances the share button with clipboard copy + confirmation state.
   * 
   * If Web Share API is available (mobile), uses native share sheet.
   * Otherwise, copies the current URL and briefly changes
   * the button text to "Copied!" for tactile feedback.
   * 
   * Why override? The existing inline onclick is basic.
   * This version adds visual feedback on the button itself.
   * 
   * @returns {void}
   */
  function initShareButton() {
    const btn = $('.btn-share');
    if (!btn) return;

    // Remove inline handler, add ours
    btn.removeAttribute('onclick');

    btn.addEventListener('click', () => {
      const url = window.location.href;
      const title = document.title;

      if (navigator.share) {
        navigator.share({ title, url }).catch(() => {
          // User cancelled — that's fine
        });
        return;
      }

      // Copy URL and show confirmation on button
      copyToClipboard(url);

      // Brief confirmation state
      const originalHTML = btn.innerHTML;
      btn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        Copied!
      `;
      btn.style.borderColor = 'var(--accent)';
      btn.style.color = 'var(--accent)';

      setTimeout(() => {
        btn.innerHTML = originalHTML;
        btn.style.borderColor = '';
        btn.style.color = '';
      }, 2000);
    });
  }


  // ═══════════════════════════════════════════════════════════════════════
  // FEATURE: Parallax
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Applies subtle parallax to the hero glyph container.
   * The glyph moves at 0.15x scroll rate — barely perceptible,
   * but enough to create depth separation between hero layers.
   * 
   * Only active above 1024px viewport width.
   * Mobile devices don't benefit from parallax — it's just jank.
   * 
   * Disabled entirely when prefers-reduced-motion is set.
   * 
   * @returns {Function|null} Update function for scroll handler, or null
   */
  function initParallax() {
    if (prefersReducedMotion) return null;
    if (window.innerWidth <= 1024) return null;

    const glyph = $('.glyph-container');
    if (!glyph) return null;

    glyph.classList.add('parallax-glyph');
    const RATE = 0.15;

    /**
     * Updates parallax offset based on current scroll position.
     * Sets a CSS custom property that the CSS file reads.
     */
    function updateParallax() {
      const scrollY = window.scrollY;
      // Only apply parallax while hero is in view
      if (scrollY > window.innerHeight) return;
      const offset = scrollY * RATE;
      glyph.style.setProperty('--parallax-y', offset + 'px');
    }

    updateParallax();
    return updateParallax;
  }


  // ═══════════════════════════════════════════════════════════════════════
  // FEATURE: Typewriter Effect
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Applies a typewriter effect to the ASCII art section.
   * Characters appear one by one at 15ms intervals.
   * 
   * Triggers on scroll-into-view using IntersectionObserver.
   * Only plays once.
   * 
   * When prefers-reduced-motion is set, the text simply appears
   * with a fade instead.
   * 
   * Why typewriter for ASCII art? Because ASCII art IS typing.
   * Seeing it appear character by character connects the viewer
   * to the act of creation.
   * 
   * @returns {void}
   */
  function initTypewriter() {
    const asciiEl = $('.creative-ascii');
    if (!asciiEl) return;

    // Skip typewriter in reduced motion — just let CSS handle opacity
    if (prefersReducedMotion) return;

    // Store the full text
    const fullText = asciiEl.textContent;
    asciiEl.textContent = '';
    asciiEl.style.opacity = '1'; // Override any CSS hide
    asciiEl.setAttribute('aria-label', fullText.trim());

    let hasPlayed = false;

    const typeObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && !hasPlayed) {
          hasPlayed = true;
          typeObserver.unobserve(entry.target);
          playTypewriter(asciiEl, fullText, 15);
        }
      });
    }, { threshold: 0.3 });

    typeObserver.observe(asciiEl);
  }

  /**
   * Plays the typewriter animation — characters appear one by one.
   * Adds a blinking cursor during typing, removes it when done.
   * 
   * @param {HTMLElement} el - The target element
   * @param {string} text - Full text to type out
   * @param {number} interval - Milliseconds between each character
   * @returns {void}
   */
  function playTypewriter(el, text, interval) {
    let index = 0;
    const cursor = document.createElement('span');
    cursor.classList.add('typewriter-cursor');
    el.appendChild(cursor);

    // Use a text node for the typed content
    const textNode = document.createTextNode('');
    el.insertBefore(textNode, cursor);

    function typeNext() {
      if (index < text.length) {
        // Type in small chunks for performance (3 chars at a time for speed)
        const chunk = text.slice(index, index + 3);
        textNode.textContent += chunk;
        index += 3;
        setTimeout(typeNext, interval);
      } else {
        // Typing complete
        el.classList.add('typewriter-complete');
        // Remove cursor after a brief pause
        setTimeout(() => {
          if (cursor.parentNode) cursor.remove();
        }, 2000);
      }
    }

    // Small initial delay before typing starts
    setTimeout(typeNext, 300);
  }


  // ═══════════════════════════════════════════════════════════════════════
  // FEATURE: Smooth Scroll for Anchor Links
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Makes all anchor links (href="#...") scroll smoothly to their target.
   * Also hooks the hero scroll indicator to scroll to the first content section.
   * 
   * Uses native scrollIntoView with smooth behavior.
   * Falls back to instant scroll if smooth not supported.
   * 
   * Why? Jump scrolling (the default) is disorienting.
   * Smooth scroll maintains the user's spatial context.
   * 
   * @returns {void}
   */
  function initSmoothScroll() {
    // Handle all anchor links
    document.addEventListener('click', (e) => {
      const link = e.target.closest('a[href^="#"]');
      if (!link) return;

      const targetId = link.getAttribute('href');
      if (!targetId || targetId === '#') return;

      const target = document.querySelector(targetId);
      if (!target) return;

      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // Hero scroll indicator — scrolls to first content section
    const scrollIndicator = $('.hero-scroll-indicator');
    if (scrollIndicator) {
      scrollIndicator.style.cursor = 'pointer';
      scrollIndicator.setAttribute('role', 'button');
      scrollIndicator.setAttribute('aria-label', 'Scroll to content');
      scrollIndicator.setAttribute('tabindex', '0');

      scrollIndicator.addEventListener('click', () => {
        // Find the first section after hero
        const firstSection = $('.identity-strip') || document.querySelector('section:nth-of-type(2)');
        if (firstSection) {
          firstSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });

      // Also handle Enter/Space for keyboard accessibility
      scrollIndicator.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          scrollIndicator.click();
        }
      });
    }
  }


  // ═══════════════════════════════════════════════════════════════════════
  // FEATURE: Magnetic Cursor Effect
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Applies a magnetic cursor effect to buttons with .magnetic-cursor class.
   * The element subtly shifts toward the cursor position when hovering,
   * creating a feeling of the button "reaching" for the user's intent.
   * 
   * Effect strength: 6px max displacement (subtle, not gimmicky).
   * Only active on non-touch devices above 1024px.
   * 
   * Why? It makes clickable elements feel responsive before the click.
   * The interface anticipates the user's action.
   * 
   * @returns {void}
   */
  function initMagneticCursor() {
    if (prefersReducedMotion) return;
    if (window.innerWidth <= 1024) return;
    if ('ontouchstart' in window) return;

    const STRENGTH = 6; // Max displacement in pixels

    // Apply to share button, stake button, branch buttons
    const magneticElements = $$('.btn-share, .btn-stake, .btn-branch, .footer-cta');

    magneticElements.forEach((el) => {
      el.classList.add('magnetic-cursor');

      el.addEventListener('mousemove', (e) => {
        const rect = el.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        // Distance from center, normalized
        const deltaX = (e.clientX - centerX) / (rect.width / 2);
        const deltaY = (e.clientY - centerY) / (rect.height / 2);

        // Apply displacement (clamped)
        const tx = Math.max(-STRENGTH, Math.min(STRENGTH, deltaX * STRENGTH));
        const ty = Math.max(-STRENGTH, Math.min(STRENGTH, deltaY * STRENGTH));

        el.style.transform = `translate(${tx}px, ${ty}px)`;
      });

      el.addEventListener('mouseleave', () => {
        el.style.transform = '';
      });
    });
  }


  // ═══════════════════════════════════════════════════════════════════════
  // FEATURE: Battery-Aware Performance
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Checks battery status and reduces animation intensity when low.
   * 
   * "Low battery" = charging false AND level ≤ 20%.
   * When detected: pauses ambient animations (breathe, float, pulse)
   * to conserve power.
   * 
   * Uses the Battery Status API (navigator.getBattery).
   * Gracefully degrades if API not available (most browsers now).
   * 
   * @returns {void}
   */
  function initBatteryAwareness() {
    if (!('getBattery' in navigator)) return;

    navigator.getBattery().then((battery) => {
      /**
       * Checks current battery state and adjusts animations.
       */
      function checkBattery() {
        isLowPower = !battery.charging && battery.level <= 0.2;

        if (isLowPower) {
          document.body.classList.add('low-power');
          // Pause ambient animations to conserve battery
          $$('.breathe, .float, .ember-pulse, .glyph-rotate, .pulse-dot').forEach((el) => {
            el.style.animationPlayState = 'paused';
          });
          // Also pause SVG animateTransform
          $$('animateTransform').forEach((el) => {
            el.setAttribute('dur', 'indefinite'); // Effectively pause
          });
        } else {
          document.body.classList.remove('low-power');
          $$('.breathe, .float, .ember-pulse, .glyph-rotate, .pulse-dot').forEach((el) => {
            el.style.animationPlayState = '';
          });
        }
      }

      checkBattery();
      battery.addEventListener('chargingchange', checkBattery);
      battery.addEventListener('levelchange', checkBattery);
    }).catch(() => {
      // API not available or rejected — that's fine
    });
  }


  // ═══════════════════════════════════════════════════════════════════════
  // FEATURE: Scroll Handler (Unified)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Unified scroll handler. Collects all scroll-dependent updates
   * and runs them inside a single requestAnimationFrame callback.
   * 
   * This prevents multiple rAF calls from different features
   * competing for the same frame budget.
   * 
   * @param {Function|null} progressFn - Scroll progress updater
   * @param {Function|null} parallaxFn - Parallax updater
   * @returns {void}
   */
  function initScrollHandler(progressFn, parallaxFn) {
    if (scrollBound) return;
    scrollBound = true;

    /**
     * The scroll callback. Batches all scroll-driven updates
     * into a single rAF for 16ms budget compliance.
     */
    function onScroll() {
      if (scrollRAF) return; // Already queued

      scrollRAF = requestAnimationFrame(() => {
        if (progressFn) progressFn();
        if (parallaxFn) parallaxFn();
        scrollRAF = null;
      });
    }

    // Passive listener — we never call preventDefault
    window.addEventListener('scroll', onScroll, { passive: true });

    // Also handle hero scroll indicator fade-out
    initScrollIndicatorFade();
  }

  /**
   * Fades out the hero scroll indicator once the user starts scrolling.
   * After scrolling 200px, it's gone. No point telling them to scroll
   * when they already are.
   * 
   * @returns {void}
   */
  function initScrollIndicatorFade() {
    const indicator = $('.hero-scroll-indicator');
    if (!indicator) return;

    let hidden = false;

    function checkIndicator() {
      if (hidden) return;
      if (window.scrollY > 200) {
        indicator.style.opacity = '0';
        indicator.style.pointerEvents = 'none';
        hidden = true;
      }
    }

    // Check on each scroll (piggybacking on the rAF loop isn't worth it
    // for this simple opacity check)
    window.addEventListener('scroll', checkIndicator, { passive: true });
    checkIndicator();
  }


  // ═══════════════════════════════════════════════════════════════════════
  // FEATURE: Toast Notifications
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Shows a brief toast notification at the bottom of the screen.
   * Auto-dismisses after 2.5 seconds.
   * 
   * Toast entrance uses CSS spring easing (defined in the CSS layer).
   * Content is set via textContent to prevent XSS.
   * 
   * @param {string} message - The message to display
   * @returns {void}
   */
  function showToast(message) {
    const toast = $('#toast');
    if (!toast) return;

    // Clear any existing timeout
    if (toast._hideTimeout) clearTimeout(toast._hideTimeout);

    toast.textContent = message;
    toast.classList.add('show');

    toast._hideTimeout = setTimeout(() => {
      toast.classList.remove('show');
    }, 2500);
  }

  // Expose globally for inline handlers that already exist in HTML
  window.showToast = showToast;


  // ═══════════════════════════════════════════════════════════════════════
  // FEATURE: Resonance Map Node Drift
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Adds subtle organic drift to resonance map nodes.
   * Each node oscillates gently in a Lissajous-like pattern.
   * 
   * This makes the constellation feel alive — like the agents
   * are orbiting in a gentle field. The effect is nearly subliminal.
   * 
   * Only runs when the resonance map is in the viewport.
   * Uses IntersectionObserver to start/stop animation.
   * 
   * @returns {void}
   */
  function initResonanceDrift() {
    if (prefersReducedMotion) return;

    const container = $('.resonance-container');
    if (!container) return;

    const nodes = container.querySelectorAll('.resonance-node');
    if (!nodes.length) return;

    let isVisible = false;
    let driftRAF = null;

    // Each node gets a unique phase offset for variety
    const phases = Array.from(nodes).map((_, i) => i * 1.2);
    const AMPLITUDE = 3; // Max 3px drift — barely perceptible

    /**
     * Animation loop for node drift.
     * Sine/cosine at different frequencies = organic path.
     */
    function drift() {
      if (!isVisible) {
        driftRAF = null;
        return;
      }

      const time = Date.now() * 0.001; // Seconds

      nodes.forEach((node, i) => {
        const t = time + phases[i];
        const dx = Math.sin(t * 0.5) * AMPLITUDE;
        const dy = Math.cos(t * 0.35) * AMPLITUDE;
        // Preserve existing transform from CSS (scale from reveal)
        // Apply drift as a CSS translate addition
        node.style.transform = `translate(${dx}px, ${dy}px)`;
      });

      driftRAF = requestAnimationFrame(drift);
    }

    // Only animate when visible — saves CPU when offscreen
    const driftObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        isVisible = entry.isIntersecting;
        if (isVisible && !driftRAF) {
          driftRAF = requestAnimationFrame(drift);
        }
      });
    }, { threshold: 0.1 });

    driftObserver.observe(container);
  }


  // ═══════════════════════════════════════════════════════════════════════
  // FEATURE: Enhanced Copy Button Handlers
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Enhances existing copy buttons (inline onclick handlers in HTML)
   * with better visual feedback.
   * 
   * The existing profile.html has `copyText()` and `shareProfile()`
   * as global functions. We enhance them with better UX.
   * 
   * @returns {void}
   */
  function enhanceCopyButtons() {
    // Override the global copyText with our enhanced version
    window.copyText = function(text, btn) {
      copyToClipboard(text);

      if (btn) {
        btn.style.color = 'var(--accent)';
        btn.style.transform = 'scale(1.2)';
        setTimeout(() => {
          btn.style.color = '';
          btn.style.transform = '';
        }, 1500);
      }
    };

    // Override shareProfile
    window.shareProfile = function() {
      const url = window.location.href;
      const title = document.title;

      if (navigator.share) {
        navigator.share({ title, url }).catch(() => {});
        return;
      }

      copyToClipboard(url);
    };
  }


  // ═══════════════════════════════════════════════════════════════════════
  // FEATURE: Viewport Resize Handler
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Handles viewport resize events for features that depend on width.
   * Debounced to fire at most once per 250ms.
   * 
   * Currently handles:
   * - Parallax enable/disable at 1024px breakpoint
   * - Magnetic cursor enable/disable at 1024px breakpoint
   * 
   * @returns {void}
   */
  function initResizeHandler() {
    let resizeTimer = null;

    window.addEventListener('resize', () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        // Re-check parallax eligibility
        const glyph = $('.glyph-container.parallax-glyph');
        if (glyph && window.innerWidth <= 1024) {
          glyph.style.setProperty('--parallax-y', '0px');
        }
      }, 250);
    });
  }


  // ═══════════════════════════════════════════════════════════════════════
  // FEATURE: Staking Chart Line Draw
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Calculates and sets the correct stroke-dasharray for staking chart
   * paths so the draw animation works properly.
   * 
   * SVG paths need their total length to set dasharray/dashoffset.
   * We calculate this on init so the CSS animation has correct values.
   * 
   * @returns {void}
   */
  function initChartLineDraw() {
    $$('.staking-chart path[fill="none"], .stat-sparkline path:not(.fill)').forEach((path) => {
      try {
        const length = path.getTotalLength();
        path.style.strokeDasharray = length;
        path.style.strokeDashoffset = length;
      } catch (e) {
        // getTotalLength not available on all SVG elements
      }
    });
  }


  // ═══════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Disconnects all observers and removes event listeners.
   * Called on page unload to prevent memory leaks.
   * 
   * In a SPA context, this would be called on route change.
   * For a static page, it's a good hygiene practice.
   * 
   * @returns {void}
   */
  function cleanup() {
    if (revealObserver) {
      revealObserver.disconnect();
      revealObserver = null;
    }
    if (counterObserver) {
      counterObserver.disconnect();
      counterObserver = null;
    }
    if (scrollRAF) {
      cancelAnimationFrame(scrollRAF);
      scrollRAF = null;
    }
  }


  // ═══════════════════════════════════════════════════════════════════════
  // INIT — The conductor raises the baton
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Master initialization function. Orchestrates all features.
   * Called on DOMContentLoaded.
   * 
   * Order matters:
   * 1. Scroll reveals (foundational — everything depends on .visible)
   * 2. Chart line setup (must happen before reveals trigger)
   * 3. Number counters (trigger on their own observer)
   * 4. Scroll progress + parallax (scroll-driven)
   * 5. Typewriter (its own observer)
   * 6. Interactions (click/hover handlers)
   * 7. Ambient effects (drift, battery)
   * 8. Cleanup hook
   * 
   * @returns {void}
   */
  function init() {
    // 1. Foundation: scroll reveals
    initScrollReveals();

    // 2. Prep: calculate SVG path lengths for draw animations
    initChartLineDraw();

    // 3. Counters: numbers animate on scroll-in
    initNumberCounters();

    // 4. Scroll-driven: progress bar + parallax
    const progressFn = initScrollProgress();
    const parallaxFn = initParallax();
    initScrollHandler(progressFn, parallaxFn);

    // 5. Typewriter: ASCII art types itself
    initTypewriter();

    // 6. Interactions
    initSmoothScroll();
    initCopyHandlers();
    initShareButton();
    enhanceCopyButtons();
    initMagneticCursor();

    // 7. Ambient effects
    initResonanceDrift();
    initBatteryAwareness();

    // 8. Resize handler
    initResizeHandler();

    // 9. Cleanup on unload
    window.addEventListener('beforeunload', cleanup);

    // ── Done ──
    // The page is alive.
  }

  // ── Launch ──
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // DOM already ready (script loaded async/deferred)
    init();
  }

})();
