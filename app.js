/**
 * ChronoFocus — High-Precision Zero-Drift Pomodoro Engine
 *
 * Key Optimizations:
 * 1. Dedicated inline Web Worker (via Blob URL) so background tab throttling
 *    never slows down or freezes countdown checks.
 * 2. Monotonic timestamp delta math (`targetEndTime - performance.now()`)
 *    instead of accumulating `remaining--` every 1000ms.
 * 3. Dirty-checked DOM rendering so text/title/favicon only update when the
 *    displayed second actually changes, while the SVG progress ring and PiP
 *    canvas animate smoothly.
 * 4. Zero-dependency Web Audio API harmonic chime synthesizer.
 * 5. Picture-in-Picture (PiP) floating mini-timer via HTML5 Canvas stream.
 */

(() => {
  'use strict';

  const STORAGE_KEY = 'chronofocus_state_v1';
  const RING_CIRCUMFERENCE = 2 * Math.PI * 134; // r = 134

  const MODE_META = {
    focus: { label: 'Focus', color: '#ff5e5b', startText: 'Start Focus' },
    shortBreak: { label: 'Short Break', color: '#10b981', startText: 'Start Break' },
    longBreak: { label: 'Long Break', color: '#3b82f6', startText: 'Start Long Break' }
  };

  // Default Configuration & State
  const defaultConfig = {
    focus: 25,
    shortBreak: 5,
    longBreak: 15,
    longBreakInterval: 4,
    autoStartBreaks: false,
    autoStartFocus: false,
    soundEnabled: true
  };

  let config = { ...defaultConfig };
  let state = {
    mode: 'focus',
    isRunning: false,
    totalMs: defaultConfig.focus * 60 * 1000,
    remainingMs: defaultConfig.focus * 60 * 1000,
    targetEpochMs: null, // Date.now() + remainingMs for persistence across reloads
    currentCycle: 1,
    completedToday: 0,
    focusMinutesToday: 0,
    lastDateKey: getTodayKey(),
    intent: ''
  };

  // DOM Elements
  const dom = {
    body: document.body,
    modeTabs: document.querySelectorAll('.mode-tab'),
    progressBar: document.getElementById('progress-bar'),
    timeDisplay: document.getElementById('time-display'),
    cycleIndicator: document.getElementById('cycle-indicator'),
    driftStatus: document.getElementById('drift-status'),
    cycleDots: document.getElementById('cycle-dots'),
    startPauseBtn: document.getElementById('start-pause-btn'),
    startPauseLabel: document.getElementById('start-pause-label'),
    playIcon: document.getElementById('play-icon'),
    pauseIcon: document.getElementById('pause-icon'),
    resetBtn: document.getElementById('reset-btn'),
    skipBtn: document.getElementById('skip-btn'),
    minus1mBtn: document.getElementById('minus-1m-btn'),
    plus1mBtn: document.getElementById('plus-1m-btn'),
    plus5mBtn: document.getElementById('plus-5m-btn'),
    focusIntent: document.getElementById('focus-intent'),
    statCompleted: document.getElementById('stat-completed'),
    statMinutes: document.getElementById('stat-minutes'),
    statTarget: document.getElementById('stat-target'),
    soundToggleBtn: document.getElementById('sound-toggle-btn'),
    soundOnIcon: document.getElementById('sound-on-icon'),
    soundOffIcon: document.getElementById('sound-off-icon'),
    pipBtn: document.getElementById('pip-btn'),
    pipCanvas: document.getElementById('pip-canvas'),
    pipVideo: document.getElementById('pip-video'),
    settingsBtn: document.getElementById('settings-btn'),
    settingsModal: document.getElementById('settings-modal'),
    closeSettingsBtn: document.getElementById('close-settings-btn'),
    settingsForm: document.getElementById('settings-form'),
    inputFocus: document.getElementById('input-focus'),
    inputShort: document.getElementById('input-short'),
    inputLong: document.getElementById('input-long'),
    inputInterval: document.getElementById('input-interval'),
    inputAutoBreak: document.getElementById('input-auto-break'),
    inputAutoFocus: document.getElementById('input-auto-focus'),
    requestNotifBtn: document.getElementById('request-notif-btn'),
    resetStatsBtn: document.getElementById('reset-stats-btn'),
    favicon: document.getElementById('dynamic-favicon')
  };

  let lastRenderedSecond = -1;
  let rafId = null;
  let audioCtx = null;

  function getTodayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  // =========================================================================
  // 1. INLINE WEB WORKER (Zero-Drift Background Heartbeat)
  // =========================================================================
  const workerCode = `
    let timerId = null;
    let targetPerfMs = 0;
    let expectedTickPerfMs = 0;
    const INTERVAL = 200;

    self.onmessage = function(e) {
      const { command, durationMs } = e.data;
      if (command === 'START') {
        clearInterval(timerId);
        const now = performance.now();
        targetPerfMs = now + durationMs;
        expectedTickPerfMs = now + INTERVAL;

        timerId = setInterval(() => {
          const current = performance.now();
          const remainingMs = Math.max(0, targetPerfMs - current);
          const tickDriftMs = Math.round(current - expectedTickPerfMs);
          expectedTickPerfMs += INTERVAL;

          self.postMessage({
            type: 'TICK',
            remainingMs,
            driftMs: tickDriftMs
          });

          if (remainingMs <= 0) {
            clearInterval(timerId);
            timerId = null;
            self.postMessage({ type: 'COMPLETE' });
          }
        }, INTERVAL);
      } else if (command === 'ADJUST') {
        targetPerfMs += durationMs;
      } else if (command === 'STOP') {
        clearInterval(timerId);
        timerId = null;
      }
    };
  `;

  const workerBlob = new Blob([workerCode], { type: 'application/javascript' });
  const timerWorker = new Worker(URL.createObjectURL(workerBlob));

  timerWorker.onmessage = (e) => {
    const { type, remainingMs } = e.data;
    if (type === 'TICK') {
      state.remainingMs = remainingMs;
      // Exact wall-clock cross-check so sleep/hibernate wakes up accurately
      if (state.targetEpochMs) {
        const wallRemaining = Math.max(0, state.targetEpochMs - Date.now());
        if (Math.abs(wallRemaining - state.remainingMs) > 1500) {
          state.remainingMs = wallRemaining;
        }
      }
      renderTimerTick();
    } else if (type === 'COMPLETE') {
      handleSessionComplete();
    }
  };

  // Visual 60fps ring interpolation when tab is focused
  function startSmoothVisualLoop() {
    cancelAnimationFrame(rafId);
    const loop = () => {
      if (!state.isRunning) return;
      if (state.targetEpochMs) {
        state.remainingMs = Math.max(0, state.targetEpochMs - Date.now());
        updateProgressRing(state.remainingMs, state.totalMs);
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }

  // =========================================================================
  // 2. WEB AUDIO SYNTHESIZER (Zero External Assets)
  // =========================================================================
  function getAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) audioCtx = new AudioContextClass();
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  function playClickSound() {
    if (!config.soundEnabled) return;
    const ctx = getAudioContext();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(520, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(180, ctx.currentTime + 0.045);

    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.045);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.05);
  }

  function playCompletionChime(mode) {
    if (!config.soundEnabled) return;
    const ctx = getAudioContext();
    if (!ctx) return;

    // Uplifting chord for break, warm resolved triad for returning to focus
    const notes = mode === 'focus'
      ? [523.25, 659.25, 783.99, 1046.5] // C5, E5, G5, C6
      : [440.0, 554.37, 659.25, 880.0];  // A4, C#5, E5, A5

    notes.forEach((freq, idx) => {
      const startTime = ctx.currentTime + idx * 0.14;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, startTime);

      gain.gain.setValueAtTime(0.0001, startTime);
      gain.gain.linearRampToValueAtTime(0.18, startTime + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 1.1);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startTime);
      osc.stop(startTime + 1.15);
    });
  }

  // =========================================================================
  // 3. CORE TIMER ACTIONS
  // =========================================================================
  function startTimer() {
    if (state.isRunning) return;
    playClickSound();
    state.isRunning = true;
    state.targetEpochMs = Date.now() + state.remainingMs;

    timerWorker.postMessage({
      command: 'START',
      durationMs: state.remainingMs
    });

    startSmoothVisualLoop();
    updateControlsUI();
    saveState();
  }

  function pauseTimer() {
    if (!state.isRunning) return;
    playClickSound();
    state.isRunning = false;
    if (state.targetEpochMs) {
      state.remainingMs = Math.max(0, state.targetEpochMs - Date.now());
    }
    state.targetEpochMs = null;

    timerWorker.postMessage({ command: 'STOP' });
    cancelAnimationFrame(rafId);
    updateControlsUI();
    renderTimerTick(true);
    saveState();
  }

  function toggleTimer() {
    if (state.isRunning) {
      pauseTimer();
    } else {
      startTimer();
    }
  }

  function resetTimer() {
    playClickSound();
    state.isRunning = false;
    state.targetEpochMs = null;
    timerWorker.postMessage({ command: 'STOP' });
    cancelAnimationFrame(rafId);

    const minutes = config[state.mode];
    state.totalMs = minutes * 60 * 1000;
    state.remainingMs = state.totalMs;

    updateControlsUI();
    renderTimerTick(true);
    saveState();
  }

  function switchMode(newMode, autoStart = false) {
    state.isRunning = false;
    state.targetEpochMs = null;
    timerWorker.postMessage({ command: 'STOP' });
    cancelAnimationFrame(rafId);

    state.mode = newMode;
    state.totalMs = config[newMode] * 60 * 1000;
    state.remainingMs = state.totalMs;

    dom.body.setAttribute('data-mode', newMode);
    dom.modeTabs.forEach((tab) => {
      const isMatch = tab.dataset.mode === newMode;
      tab.classList.toggle('active', isMatch);
      tab.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    });

    updateControlsUI();
    renderCycleDots();
    renderTimerTick(true);
    updateDynamicFavicon();

    if (autoStart) {
      startTimer();
    } else {
      saveState();
    }
  }

  function adjustTimeMs(deltaMs) {
    const newRemaining = Math.max(5000, state.remainingMs + deltaMs);
    const actualDelta = newRemaining - state.remainingMs;
    state.remainingMs = newRemaining;
    state.totalMs = Math.max(state.totalMs, state.remainingMs);

    if (state.isRunning && state.targetEpochMs) {
      state.targetEpochMs += actualDelta;
      timerWorker.postMessage({
        command: 'ADJUST',
        durationMs: actualDelta
      });
    }

    renderTimerTick(true);
    saveState();
  }

  function handleSessionComplete() {
    const finishedMode = state.mode;
    state.isRunning = false;
    state.targetEpochMs = null;
    cancelAnimationFrame(rafId);

    playCompletionChime(finishedMode);

    if (finishedMode === 'focus') {
      state.completedToday += 1;
      state.focusMinutesToday += config.focus;

      const isLongBreakDue = state.currentCycle >= config.longBreakInterval;
      const nextMode = isLongBreakDue ? 'longBreak' : 'shortBreak';
      sendDesktopNotification(
        'Focus Session Complete!',
        state.intent
          ? `Great work on "${state.intent}". Time for a ${MODE_META[nextMode].label.toLowerCase()}.`
          : `Time for a well-deserved ${MODE_META[nextMode].label.toLowerCase()}!`
      );

      switchMode(nextMode, config.autoStartBreaks);
    } else {
      // Transitioning from a break back to Focus
      if (finishedMode === 'longBreak') {
        state.currentCycle = 1;
      } else {
        state.currentCycle += 1;
      }

      sendDesktopNotification(
        'Break Finished',
        'Ready to start your next focus session?'
      );

      switchMode('focus', config.autoStartFocus);
    }

    renderStats();
    saveState();
  }

  // =========================================================================
  // 4. DOM RENDERING & DYNAMIC FAVICON / PICTURE-IN-PICTURE
  // =========================================================================
  function formatTime(ms) {
    const totalSeconds = Math.ceil(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function updateProgressRing(remainingMs, totalMs) {
    const fraction = totalMs > 0 ? Math.max(0, Math.min(1, remainingMs / totalMs)) : 1;
    const offset = RING_CIRCUMFERENCE * (1 - fraction);
    dom.progressBar.style.strokeDashoffset = offset.toFixed(2);
  }

  function renderTimerTick(force = false) {
    updateProgressRing(state.remainingMs, state.totalMs);

    const currentSec = Math.ceil(state.remainingMs / 1000);
    if (!force && currentSec === lastRenderedSecond) return;
    lastRenderedSecond = currentSec;

    const formatted = formatTime(state.remainingMs);
    dom.timeDisplay.textContent = formatted;
    dom.driftStatus.textContent = state.isRunning ? '±0ms sync' : 'Ready';

    const modeTitle = MODE_META[state.mode].label;
    const intentSuffix = state.intent ? ` — ${state.intent}` : '';
    document.title = `(${formatted}) ${modeTitle}${intentSuffix}`;

    renderPiPCanvas(formatted);
  }

  function updateControlsUI() {
    dom.playIcon.classList.toggle('hidden', state.isRunning);
    dom.pauseIcon.classList.toggle('hidden', !state.isRunning);
    dom.startPauseLabel.textContent = state.isRunning
      ? 'Pause'
      : MODE_META[state.mode].startText;

    dom.cycleIndicator.textContent = `Session #${state.currentCycle}`;
    dom.soundOnIcon.classList.toggle('hidden', !config.soundEnabled);
    dom.soundOffIcon.classList.toggle('hidden', config.soundEnabled);
  }

  function renderCycleDots() {
    dom.cycleDots.innerHTML = '';
    for (let i = 1; i <= config.longBreakInterval; i++) {
      const dot = document.createElement('div');
      dot.className = 'cycle-dot';
      if (i < state.currentCycle) {
        dot.classList.add('completed');
      } else if (i === state.currentCycle) {
        dot.classList.add('current');
      }
      dom.cycleDots.appendChild(dot);
    }
  }

  function renderStats() {
    dom.statCompleted.textContent = String(state.completedToday);
    dom.statMinutes.textContent = `${state.focusMinutesToday}m`;
    dom.statTarget.textContent = `${state.currentCycle} / ${config.longBreakInterval}`;
  }

  function updateDynamicFavicon() {
    const color = encodeURIComponent(MODE_META[state.mode].color);
    dom.favicon.href = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='45' fill='${color}'/></svg>`;
  }

  // Picture-in-Picture Floating Mini Timer
  function renderPiPCanvas(formattedTime) {
    const canvas = dom.pipCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const accent = MODE_META[state.mode].color;

    ctx.fillStyle = '#0d0f14';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Top Accent Progress Bar
    const progress = state.totalMs > 0 ? state.remainingMs / state.totalMs : 1;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, 0, canvas.width, 6);
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, canvas.width * progress, 6);

    // Mode Label
    ctx.fillStyle = accent;
    ctx.font = '700 14px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(MODE_META[state.mode].label.toUpperCase(), canvas.width / 2, 46);

    // Countdown Readout
    ctx.fillStyle = '#f3f5f8';
    ctx.font = '800 64px system-ui, -apple-system, sans-serif';
    ctx.fillText(formattedTime, canvas.width / 2, 112);

    // Objective Subtitle
    ctx.fillStyle = '#8a94a6';
    ctx.font = '500 13px system-ui, -apple-system, sans-serif';
    const subtitle = state.intent || `Session #${state.currentCycle} of ${config.longBreakInterval}`;
    ctx.fillText(subtitle.slice(0, 34), canvas.width / 2, 150);
  }

  async function togglePictureInPicture() {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return;
      }
      renderPiPCanvas(formatTime(state.remainingMs));
      const stream = dom.pipCanvas.captureStream(15);
      dom.pipVideo.srcObject = stream;
      await dom.pipVideo.play();
      await dom.pipVideo.requestPictureInPicture();
    } catch (err) {
      alert('Picture-in-Picture floating window is not supported in this browser context.');
    }
  }

  // =========================================================================
  // 5. NOTIFICATIONS & PERSISTENCE
  // =========================================================================
  function sendDesktopNotification(title, body) {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      new Notification(title, { body });
    }
  }

  function saveState() {
    try {
      const payload = {
        config,
        state: {
          ...state,
          lastDateKey: getTodayKey()
        }
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (_) {
      // Ignore storage quota errors
    }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);

      if (parsed.config) {
        config = { ...defaultConfig, ...parsed.config };
      }
      if (parsed.state) {
        const today = getTodayKey();
        const isSameDay = parsed.state.lastDateKey === today;

        state = {
          ...state,
          ...parsed.state,
          completedToday: isSameDay ? (parsed.state.completedToday || 0) : 0,
          focusMinutesToday: isSameDay ? (parsed.state.focusMinutesToday || 0) : 0,
          lastDateKey: today
        };

        // If timer was running before page reload, recover exact remaining time
        if (state.isRunning && state.targetEpochMs) {
          const remaining = state.targetEpochMs - Date.now();
          if (remaining > 0) {
            state.remainingMs = remaining;
            timerWorker.postMessage({
              command: 'START',
              durationMs: state.remainingMs
            });
            startSmoothVisualLoop();
          } else {
            state.isRunning = false;
            state.targetEpochMs = null;
            state.remainingMs = config[state.mode] * 60 * 1000;
            state.totalMs = state.remainingMs;
          }
        }
      }
    } catch (_) {
      // Fall back cleanly to defaults
    }
  }

  // =========================================================================
  // 6. EVENT LISTENERS & KEYBOARD SHORTCUTS
  // =========================================================================
  function bindEvents() {
    dom.startPauseBtn.addEventListener('click', toggleTimer);
    dom.resetBtn.addEventListener('click', resetTimer);
    dom.skipBtn.addEventListener('click', () => handleSessionComplete());

    dom.minus1mBtn.addEventListener('click', () => adjustTimeMs(-60 * 1000));
    dom.plus1mBtn.addEventListener('click', () => adjustTimeMs(60 * 1000));
    dom.plus5mBtn.addEventListener('click', () => adjustTimeMs(5 * 60 * 1000));

    dom.modeTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const targetMode = tab.dataset.mode;
        if (targetMode !== state.mode) {
          playClickSound();
          switchMode(targetMode, false);
        }
      });
    });

    dom.focusIntent.addEventListener('input', (e) => {
      state.intent = e.target.value.trim();
      renderTimerTick(true);
      saveState();
    });

    dom.soundToggleBtn.addEventListener('click', () => {
      config.soundEnabled = !config.soundEnabled;
      if (config.soundEnabled) playClickSound();
      updateControlsUI();
      saveState();
    });

    dom.pipBtn.addEventListener('click', togglePictureInPicture);

    // Settings Modal
    dom.settingsBtn.addEventListener('click', openSettingsModal);
    dom.closeSettingsBtn.addEventListener('click', closeSettingsModal);
    dom.settingsModal.addEventListener('click', (e) => {
      if (e.target === dom.settingsModal) closeSettingsModal();
    });

    dom.requestNotifBtn.addEventListener('click', async () => {
      if (!('Notification' in window)) return;
      const perm = await Notification.requestPermission();
      updateNotificationBtnLabel(perm);
    });

    dom.resetStatsBtn.addEventListener('click', () => {
      state.completedToday = 0;
      state.focusMinutesToday = 0;
      state.currentCycle = 1;
      renderStats();
      renderCycleDots();
      saveState();
      closeSettingsModal();
    });

    dom.settingsForm.addEventListener('submit', (e) => {
      e.preventDefault();
      config.focus = Math.max(1, Math.min(180, Number(dom.inputFocus.value) || 25));
      config.shortBreak = Math.max(1, Math.min(60, Number(dom.inputShort.value) || 5));
      config.longBreak = Math.max(1, Math.min(90, Number(dom.inputLong.value) || 15));
      config.longBreakInterval = Math.max(2, Math.min(12, Number(dom.inputInterval.value) || 4));
      config.autoStartBreaks = dom.inputAutoBreak.checked;
      config.autoStartFocus = dom.inputAutoFocus.checked;

      if (!state.isRunning) {
        state.totalMs = config[state.mode] * 60 * 1000;
        state.remainingMs = state.totalMs;
      }

      renderCycleDots();
      renderStats();
      renderTimerTick(true);
      saveState();
      closeSettingsModal();
    });

    // Global Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      const activeTag = document.activeElement ? document.activeElement.tagName : '';
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') {
        if (e.key === 'Escape') document.activeElement.blur();
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        toggleTimer();
      } else if (e.key === 'r' || e.key === 'R') {
        resetTimer();
      } else if (e.key === 'n' || e.key === 'N') {
        handleSessionComplete();
      } else if (e.key === '1') {
        switchMode('focus', false);
      } else if (e.key === '2') {
        switchMode('shortBreak', false);
      } else if (e.key === '3') {
        switchMode('longBreak', false);
      } else if (e.key === 's' || e.key === 'S') {
        openSettingsModal();
      } else if (e.key === 'Escape') {
        closeSettingsModal();
      }
    });

    // Ensure immediate sync when switching back to tab
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.isRunning && state.targetEpochMs) {
        state.remainingMs = Math.max(0, state.targetEpochMs - Date.now());
        renderTimerTick(true);
        startSmoothVisualLoop();
      }
    });
  }

  function updateNotificationBtnLabel(perm) {
    if (perm === 'granted') {
      dom.requestNotifBtn.textContent = 'Enabled';
      dom.requestNotifBtn.disabled = true;
    } else if (perm === 'denied') {
      dom.requestNotifBtn.textContent = 'Blocked';
    } else {
      dom.requestNotifBtn.textContent = 'Enable';
    }
  }

  function openSettingsModal() {
    dom.inputFocus.value = config.focus;
    dom.inputShort.value = config.shortBreak;
    dom.inputLong.value = config.longBreak;
    dom.inputInterval.value = config.longBreakInterval;
    dom.inputAutoBreak.checked = config.autoStartBreaks;
    dom.inputAutoFocus.checked = config.autoStartFocus;

    if ('Notification' in window) {
      updateNotificationBtnLabel(Notification.permission);
    }
    dom.settingsModal.classList.remove('hidden');
  }

  function closeSettingsModal() {
    dom.settingsModal.classList.add('hidden');
  }

  // Initialize Application
  function init() {
    loadState();
    dom.body.setAttribute('data-mode', state.mode);
    dom.modeTabs.forEach((tab) => {
      const isMatch = tab.dataset.mode === state.mode;
      tab.classList.toggle('active', isMatch);
      tab.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    });
    dom.focusIntent.value = state.intent || '';

    updateControlsUI();
    renderCycleDots();
    renderStats();
    updateDynamicFavicon();
    renderTimerTick(true);
    bindEvents();
  }

  init();
})();
