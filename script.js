'use strict';
// ============================================================
//  Práctica 9 — Sistema Tolva + Bandas Transportadoras
//  Simulación + Diagrama Ladder IEC 60617
// ============================================================

// ==================== CONSTANTS ====================
const FILL_TIME_MS   = 6000;   // ms para llenar 0→100%
const RETURN_TIME_MS = 8000;   // ms para que el contenedor regrese
const TIMEOUT_SEC    = 10;     // s antes de RESET KV por timeout
const LEAVE_DELAY_MS = 800;    // ms después de full antes de que el contenedor empiece a salir
const SENSOR_CLEAR_MS= 600;    // ms para que el sensor se desactiva al salir

// ==================== STATE ====================
const S = {
  // Coil outputs
  kv: false, km1: false, km2: false, km3: false,

  // Sensor inputs (real + manual override)
  fc3: false, fc4: false,
  fc3_manual: false, fc4_manual: false,
  fc3_prev: false, fc4_prev: false,

  // System state machine
  state: 'IDLE', // IDLE | FILLING_S4 | FILLING_S3 | EMERGENCY | TIMEOUT

  // Latch / seal-in
  run_latch: false,
  km3_latch: false,   // memory bit: FC4 triggered → KM3 should run

  // Container fill 0..100
  s3_fill: 0, s4_fill: 0,

  // Container status: ready | filling | full | leaving | away | returning
  s3_status: 'ready', s4_status: 'ready',

  // Timer objects: { active, elapsed_ms, triggered }
  t_fc3: { active: false, elapsed_ms: 0, triggered: false },
  t_fc4: { active: false, elapsed_ms: 0, triggered: false },

  // Internal timers for container animation
  s3_leave_timer: 0, s4_leave_timer: 0,
  s3_return_timer: 0, s4_return_timer: 0,
  s3_sensor_timer: 0, s4_sensor_timer: 0,

  // Button state
  pb_start_held: false,
};

// Particle animation
const particles = [];
let belt1Class = 'belt-stopped';
let belt2Class = 'belt-stopped';
let simTime = 0; // ms since start
let startTimeMs = Date.now();

// ==================== HELPERS ====================
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function getTimestamp() {
  const elapsed = Date.now() - startTimeMs;
  const s = Math.floor(elapsed / 1000) % 60;
  const m = Math.floor(elapsed / 60000);
  return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
}

function logEvent(msg, type) {
  type = type || 'info';
  const log = document.getElementById('event-log');
  if (!log) return;
  const div = document.createElement('div');
  div.className = 'log-entry ' + type;
  div.innerHTML = '<span class="log-time">' + getTimestamp() + '</span>' +
                  '<span class="log-msg">' + msg + '</span>';
  log.insertBefore(div, log.firstChild);
  // Keep last 80 entries
  while (log.children.length > 80) log.removeChild(log.lastChild);
}

// ==================== STATE TRANSITIONS ====================
function startSystem() {
  if (S.state !== 'IDLE' && S.state !== 'EMERGENCY' && S.state !== 'TIMEOUT') return;
  S.state = 'FILLING_S4';
  S.run_latch = true;
  S.km3_latch = false;
  S.kv = true; S.km1 = true; S.km2 = true; S.km3 = false;
  resetTimers();
  logEvent('PB_START — KV ON, KM1 ON, KM2 ON — Llenando S4', 'start');
}

function stopSystem() {
  S.state = 'IDLE';
  S.run_latch = false; S.km3_latch = false;
  S.kv = false; S.km1 = false; S.km2 = false; S.km3 = false;
  resetTimers();
  logEvent('PB_STOP — Sistema detenido', 'stop');
}

function resetSystem() {
  stopSystem();
  S.fc3 = false; S.fc4 = false;
  S.s3_fill = 0; S.s4_fill = 0;
  S.s3_status = 'ready'; S.s4_status = 'ready';
  S.s3_leave_timer = 0; S.s4_leave_timer = 0;
  S.s3_return_timer = 0; S.s4_return_timer = 0;
  S.s3_sensor_timer = 0; S.s4_sensor_timer = 0;
  S.fc3_manual = false; S.fc4_manual = false;
  document.getElementById('fc3-toggle').checked = false;
  document.getElementById('fc4-toggle').checked = false;
  particles.length = 0;
  logEvent('RESET — Sistema reiniciado', 'stop');
}

function triggerEmergency() {
  S.state = 'EMERGENCY';
  S.run_latch = false; S.km3_latch = false;
  S.kv = false; S.km1 = false; S.km2 = false; S.km3 = false;
  resetTimers();
  logEvent('&#x26A0; EMERGENCIA — FC3 + FC4 simultáneos — RESET todo', 'alarm');
}

function triggerTimeout(source) {
  S.state = 'TIMEOUT';
  S.kv = false;
  logEvent('&#x23F1; TIMEOUT — T_' + source + ' expiró 10s — KV OFF', 'warn');
}

function resetTimers() {
  S.t_fc3.active = false; S.t_fc3.elapsed_ms = 0; S.t_fc3.triggered = false;
  S.t_fc4.active = false; S.t_fc4.elapsed_ms = 0; S.t_fc4.triggered = false;
}

// ==================== SCAN CYCLE ====================
function scan(dt) {
  // Save previous sensor states for edge detection
  S.fc3_prev = S.fc3;
  S.fc4_prev = S.fc4;

  // Merge manual overrides into sensor state (manual can force ON)
  // Actual FC3/FC4 is set by fill simulation; manual can override
  if (S.fc3_manual) S.fc3 = true;
  if (S.fc4_manual) S.fc4 = true;

  // ---- EMERGENCY: both sensors active ----
  if (S.fc3 && S.fc4 && S.state !== 'EMERGENCY' && S.state !== 'IDLE') {
    triggerEmergency();
    return;
  }

  // ---- TIMEOUT TIMERS ----
  // Timer FC4: starts when FC4 activates, resets when FC4 deactivates
  if (S.state === 'FILLING_S4' || S.state === 'FILLING_S3') {
    if (S.fc4 && !S.t_fc4.triggered) {
      if (!S.t_fc4.active) {
        S.t_fc4.active = true;
        S.t_fc4.elapsed_ms = 0;
      }
      S.t_fc4.elapsed_ms += dt;
      if (S.t_fc4.elapsed_ms >= TIMEOUT_SEC * 1000 && !S.t_fc4.triggered) {
        S.t_fc4.triggered = true;
        triggerTimeout('FC4');
        return;
      }
    } else if (!S.fc4) {
      S.t_fc4.active = false;
      S.t_fc4.elapsed_ms = 0;
      S.t_fc4.triggered = false;
    }

    if (S.fc3 && !S.t_fc3.triggered) {
      if (!S.t_fc3.active) {
        S.t_fc3.active = true;
        S.t_fc3.elapsed_ms = 0;
      }
      S.t_fc3.elapsed_ms += dt;
      if (S.t_fc3.elapsed_ms >= TIMEOUT_SEC * 1000 && !S.t_fc3.triggered) {
        S.t_fc3.triggered = true;
        triggerTimeout('FC3');
        return;
      }
    } else if (!S.fc3) {
      S.t_fc3.active = false;
      S.t_fc3.elapsed_ms = 0;
      S.t_fc3.triggered = false;
    }
  }

  // ---- STATE MACHINE ----
  switch (S.state) {
    case 'IDLE':
      S.kv = false; S.km1 = false; S.km2 = false; S.km3 = false;
      break;

    case 'FILLING_S4':
      S.kv = true; S.km1 = true; S.km2 = true; S.km3 = false;
      // FC4 triggered? → switch to filling S3
      if (S.fc4 && !S.fc4_prev) {
        S.km3_latch = true;
        S.km2 = false; S.km3 = true;
        S.state = 'FILLING_S3';
        logEvent('FC4 ON — S4 lleno → KM2 OFF, KM3 ON — Llenando S3', 'warn');
      }
      break;

    case 'FILLING_S3':
      S.kv = true; S.km1 = true; S.km2 = false; S.km3 = true;
      // FC3 triggered? → switch back to filling S4
      if (S.fc3 && !S.fc3_prev) {
        S.km3_latch = false;
        S.km3 = false; S.km2 = true;
        S.state = 'FILLING_S4';
        logEvent('FC3 ON — S3 lleno → KM3 OFF, KM2 ON — Llenando S4', 'warn');
      }
      break;

    case 'EMERGENCY':
    case 'TIMEOUT':
      S.kv = false; S.km1 = false; S.km2 = false; S.km3 = false;
      break;
  }
}

// ==================== FILL SIMULATION ====================
function updateFill(dt) {
  const fillRate = 100 / FILL_TIME_MS; // % per ms

  // S4 filling (KM2 active)
  if (S.km2 && S.s4_status === 'ready') {
    S.s4_status = 'filling';
  }
  if (S.s4_status === 'filling' && S.km2) {
    S.s4_fill = clamp(S.s4_fill + fillRate * dt, 0, 100);
    if (S.s4_fill >= 100) {
      S.s4_fill = 100;
      S.s4_status = 'full';
      S.fc4 = true;
      S.s4_leave_timer = 0;
      logEvent('S4 lleno (100%) — FC4 activado', 'warn');
    }
  }

  // S3 filling (KM3 active)
  if (S.km3 && S.s3_status === 'ready') {
    S.s3_status = 'filling';
  }
  if (S.s3_status === 'filling' && S.km3) {
    S.s3_fill = clamp(S.s3_fill + fillRate * dt, 0, 100);
    if (S.s3_fill >= 100) {
      S.s3_fill = 100;
      S.s3_status = 'full';
      S.fc3 = true;
      S.s3_leave_timer = 0;
      logEvent('S3 lleno (100%) — FC3 activado', 'warn');
    }
  }

  // Stop filling if KM turned off mid-fill
  if (!S.km2 && S.s4_status === 'filling') { /* keep fill level, just stop */ }
  if (!S.km3 && S.s3_status === 'filling') { /* keep fill level, just stop */ }

  // Container leave + return animation for S4
  if (S.s4_status === 'full' && !S.fc4_manual) {
    S.s4_leave_timer += dt;
    if (S.s4_leave_timer >= LEAVE_DELAY_MS) {
      S.s4_status = 'leaving';
      S.s4_sensor_timer = 0;
      S.s4_return_timer = 0;
    }
  }
  if (S.s4_status === 'leaving') {
    S.s4_sensor_timer += dt;
    if (S.s4_sensor_timer >= SENSOR_CLEAR_MS) {
      // Container cleared the sensor
      S.fc4 = false;
    }
    S.s4_return_timer += dt;
    if (S.s4_return_timer >= RETURN_TIME_MS) {
      S.s4_status = 'ready';
      S.s4_fill = 0;
      S.s4_return_timer = 0;
      logEvent('S4 vació y regresó a posición', 'info');
    }
  }

  // Container leave + return animation for S3
  if (S.s3_status === 'full' && !S.fc3_manual) {
    S.s3_leave_timer += dt;
    if (S.s3_leave_timer >= LEAVE_DELAY_MS) {
      S.s3_status = 'leaving';
      S.s3_sensor_timer = 0;
      S.s3_return_timer = 0;
    }
  }
  if (S.s3_status === 'leaving') {
    S.s3_sensor_timer += dt;
    if (S.s3_sensor_timer >= SENSOR_CLEAR_MS) {
      S.fc3 = false;
    }
    S.s3_return_timer += dt;
    if (S.s3_return_timer >= RETURN_TIME_MS) {
      S.s3_status = 'ready';
      S.s3_fill = 0;
      S.s3_return_timer = 0;
      logEvent('S3 vació y regresó a posición', 'info');
    }
  }

  // Re-ready containers when KM direction switches and away
  if (S.km2 && S.s4_status === 'leaving' && S.s4_return_timer < 100) {
    // Already leaving, let it finish
  }
}

// ==================== PARTICLE SYSTEM ====================
function spawnParticles(dt) {
  if (!S.km1 || !S.kv) return;
  simTime += dt;
  // Spawn a particle every 300ms
  if (simTime % 300 < dt) {
    particles.push({
      x: 238 + Math.random() * 24,
      y: 98,
      vy: 0.08 + Math.random() * 0.04,
      life: 1.0,
      r: 2 + Math.random() * 2,
    });
  }
  // Update particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.y += p.vy * dt;
    p.life -= dt / 400;
    if (p.life <= 0 || p.y > 160) {
      particles.splice(i, 1);
    }
  }
}

function renderParticles() {
  const layer = document.getElementById('particles-layer');
  if (!layer) return;
  layer.innerHTML = '';
  for (const p of particles) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', p.x.toFixed(1));
    circle.setAttribute('cy', p.y.toFixed(1));
    circle.setAttribute('r', p.r.toFixed(1));
    circle.setAttribute('fill', '#aa8844');
    circle.setAttribute('opacity', (p.life * 0.8).toFixed(2));
    layer.appendChild(circle);
  }
}

// ==================== LADDER DISPLAY UPDATE ====================
function updateLadder() {
  // Helper: set energized state on a group by id
  function setE(id, on, alarmMode) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('energized', 'partial', 'alarm', 'coil-active');
    if (alarmMode) el.classList.add('alarm');
    else if (on) el.classList.add('energized');
  }
  function setCoil(id, on, alarmMode) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('energized', 'partial', 'alarm', 'coil-active');
    if (alarmMode) el.classList.add('alarm');
    else if (on) el.classList.add('coil-active');
  }

  const isRun = S.state !== 'IDLE';
  const emerg = S.state === 'EMERGENCY';
  const timeout = S.state === 'TIMEOUT';

  // Rung 1
  setE('c-pbstart', S.pb_start_held || S.run_latch);
  setE('c-pbstop', !false); // NC = normally energized
  setE('c-sealin', S.run_latch);
  setE('c-emerg', !emerg && S.state !== 'IDLE');
  setCoil('coil-kv', S.kv, emerg || timeout);
  setCoil('coil-km1', S.km1, emerg || timeout);

  // Rung 2
  setE('c-kv-r2', S.kv);
  setE('c-nfc4', !S.fc4 && S.kv);
  setE('c-nfc3-r2', !S.fc3 && S.kv);
  setCoil('coil-km2', S.km2);

  // Rung 3
  setE('c-kv-r3', S.kv);
  setE('c-fc4latch', S.km3_latch && S.kv);
  setE('c-nfc3-r3', !S.fc3 && S.kv);
  setE('c-nkm2', !S.km2 && S.kv);
  setCoil('coil-km3', S.km3);

  // Rung 4: EMERGENCY
  setE('c-fc3-r4', S.fc3, emerg);
  setE('c-fc4-r4', S.fc4, emerg);
  setCoil('coil-emerg', emerg, true);

  // Rung 5: T_FC4 timeout
  const tfc4Active = S.t_fc4.active && S.t_fc4.elapsed_ms > 0;
  setE('c-fc4-r5', tfc4Active || S.t_fc4.triggered);
  setE('timer-tfc4', tfc4Active || S.t_fc4.triggered);
  setCoil('coil-tfc4-reset', S.t_fc4.triggered, true);

  // Rung 6: T_FC3 timeout
  const tfc3Active = S.t_fc3.active && S.t_fc3.elapsed_ms > 0;
  setE('c-fc3-r6', tfc3Active || S.t_fc3.triggered);
  setE('timer-tfc3', tfc3Active || S.t_fc3.triggered);
  setCoil('coil-tfc3-reset', S.t_fc3.triggered, true);

  // Timer countdown displays in SVG
  const t4El = document.getElementById('tfc4-display');
  const t3El = document.getElementById('tfc3-display');
  if (t4El) t4El.textContent = tfc4Active ? (((TIMEOUT_SEC * 1000 - S.t_fc4.elapsed_ms) / 1000).toFixed(1) + 's') : '--';
  if (t3El) t3El.textContent = tfc3Active ? (((TIMEOUT_SEC * 1000 - S.t_fc3.elapsed_ms) / 1000).toFixed(1) + 's') : '--';
}

// ==================== SIMULATION DISPLAY UPDATE ====================
function updateSimulation() {
  // Valve
  const valveRect = document.getElementById('valve-rect');
  const valveText = document.getElementById('valve-text');
  const stream = document.getElementById('material-stream');
  if (valveRect) {
    valveRect.className.baseVal = S.kv ? 'valve-open' : 'valve-closed';
    valveText.textContent = S.kv ? 'KV ✓' : 'KV ✗';
    stream.setAttribute('opacity', S.kv && S.km1 ? '1' : '0');
  }

  // Belt 1
  const b1 = document.getElementById('belt1-anim');
  if (b1) {
    if (S.km1) {
      b1.className.baseVal = 'belt-anim-right';
      b1.setAttribute('stroke', '#00ff88');
    } else {
      b1.className.baseVal = 'belt-stopped';
      b1.setAttribute('stroke', '#2a3a5a');
    }
  }
  const b1arr = document.getElementById('belt1-arrow');
  if (b1arr) {
    b1arr.setAttribute('fill', S.km1 ? '#00ff88' : '#2a3a5a');
  }

  // Belt 2
  const b2 = document.getElementById('belt2-anim');
  const dirR = document.getElementById('band2-dir-right');
  const dirL = document.getElementById('band2-dir-left');
  const km2lbl = document.getElementById('km2-label');
  const km3lbl = document.getElementById('km3-label');
  if (b2) {
    if (S.km2) {
      b2.className.baseVal = 'belt-anim-right';
      b2.setAttribute('stroke', '#00ff88');
      if (dirR) dirR.firstElementChild.setAttribute('opacity', '1');
      if (dirL) dirL.firstElementChild.setAttribute('opacity', '0');
      if (km2lbl) km2lbl.setAttribute('opacity', '1');
      if (km3lbl) km3lbl.setAttribute('opacity', '0');
    } else if (S.km3) {
      b2.className.baseVal = 'belt-anim-left';
      b2.setAttribute('stroke', '#00ccff');
      if (dirR) dirR.firstElementChild.setAttribute('opacity', '0');
      if (dirL) dirL.firstElementChild.setAttribute('opacity', '1');
      if (km2lbl) km2lbl.setAttribute('opacity', '0');
      if (km3lbl) km3lbl.setAttribute('opacity', '1');
    } else {
      b2.className.baseVal = 'belt-stopped';
      b2.setAttribute('stroke', '#2a3a5a');
      if (dirR) dirR.firstElementChild.setAttribute('opacity', '0');
      if (dirL) dirL.firstElementChild.setAttribute('opacity', '0');
      if (km2lbl) km2lbl.setAttribute('opacity', '0');
      if (km3lbl) km3lbl.setAttribute('opacity', '0');
    }
  }

  // Container S4
  const fillS4 = document.getElementById('fill-s4');
  const s4pct  = document.getElementById('s4-pct');
  const s4stat = document.getElementById('s4-status');
  const fc4sen = document.getElementById('fc4-sensor');
  if (fillS4) {
    const h = (S.s4_fill / 100) * 108;
    fillS4.setAttribute('y', (378 - h).toFixed(1));
    fillS4.setAttribute('height', h.toFixed(1));
    s4pct.textContent = Math.round(S.s4_fill) + '%';
    // Color pct text
    const pctColor = S.s4_fill >= 100 ? '#ff4444' : (S.s4_fill > 60 ? '#f0a500' : '#2a8a5a');
    s4pct.setAttribute('fill', pctColor);
    // Status text
    const statusMap = { ready:'ESPERA', filling:'LLENANDO', full:'LLENO', leaving:'SALIENDO', away:'FUERA' };
    s4stat.textContent = statusMap[S.s4_status] || S.s4_status.toUpperCase();
    // FC4 sensor color
    fc4sen.setAttribute('fill', S.fc4 ? '#00ff44' : '#2a3a5a');
    // Container opacity during leaving/away
    const cont = document.getElementById('container-s4');
    if (S.s4_status === 'away') {
      cont.setAttribute('opacity', '0.25');
    } else if (S.s4_status === 'leaving') {
      const prog = S.s4_return_timer / RETURN_TIME_MS;
      cont.setAttribute('opacity', Math.max(0.25, 1 - prog * 3).toFixed(2));
    } else {
      cont.setAttribute('opacity', '1');
    }
  }

  // Container S3
  const fillS3 = document.getElementById('fill-s3');
  const s3pct  = document.getElementById('s3-pct');
  const s3stat = document.getElementById('s3-status');
  const fc3sen = document.getElementById('fc3-sensor');
  if (fillS3) {
    const h = (S.s3_fill / 100) * 108;
    fillS3.setAttribute('y', (378 - h).toFixed(1));
    fillS3.setAttribute('height', h.toFixed(1));
    s3pct.textContent = Math.round(S.s3_fill) + '%';
    const pctColor = S.s3_fill >= 100 ? '#ff4444' : (S.s3_fill > 60 ? '#f0a500' : '#2a5a9a');
    s3pct.setAttribute('fill', pctColor);
    const statusMap = { ready:'ESPERA', filling:'LLENANDO', full:'LLENO', leaving:'SALIENDO', away:'FUERA' };
    s3stat.textContent = statusMap[S.s3_status] || S.s3_status.toUpperCase();
    fc3sen.setAttribute('fill', S.fc3 ? '#00ff44' : '#2a3a5a');
    const cont = document.getElementById('container-s3');
    if (S.s3_status === 'away') {
      cont.setAttribute('opacity', '0.25');
    } else if (S.s3_status === 'leaving') {
      const prog = S.s3_return_timer / RETURN_TIME_MS;
      cont.setAttribute('opacity', Math.max(0.25, 1 - prog * 3).toFixed(2));
    } else {
      cont.setAttribute('opacity', '1');
    }
  }

  // Render particles
  renderParticles();
}

// ==================== PANEL UPDATE ====================
function updatePanel() {
  // Helper: set indicator state
  function setInd(id, on, type) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = 'indicator' + (on ? (' ' + (type || 'on')) : '');
  }

  setInd('ind-kv',  S.kv);
  setInd('ind-km1', S.km1);
  setInd('ind-km2', S.km2);
  setInd('ind-km3', S.km3);
  setInd('ind-fc3', S.fc3, S.state === 'EMERGENCY' ? 'alarm' : 'warn');
  setInd('ind-fc4', S.fc4, S.state === 'EMERGENCY' ? 'alarm' : 'warn');

  // System badge
  const badge = document.getElementById('sys-badge');
  if (badge) {
    const labels = {
      IDLE:       'IDLE',
      FILLING_S4: 'LLENANDO S4',
      FILLING_S3: 'LLENANDO S3',
      EMERGENCY:  'EMERGENCIA',
      TIMEOUT:    'TIMEOUT',
    };
    badge.textContent = labels[S.state] || S.state;
    badge.className = 'system-badge ' + S.state;
  }

  // Timer cards FC4
  const t4active = S.t_fc4.active && S.t_fc4.elapsed_ms > 0;
  const t3active = S.t_fc3.active && S.t_fc3.elapsed_ms > 0;

  const tc4 = document.getElementById('tcard-fc4');
  const tv4 = document.getElementById('tval-fc4');
  const tb4 = document.getElementById('tbar-fc4');
  if (tc4) tc4.className = 'timer-card' + (t4active ? ' active' : '');
  if (tv4) {
    if (t4active) {
      const rem = clamp(TIMEOUT_SEC - S.t_fc4.elapsed_ms / 1000, 0, TIMEOUT_SEC);
      tv4.textContent = rem.toFixed(1) + 's';
    } else {
      tv4.textContent = '--';
    }
  }
  if (tb4) tb4.style.width = (t4active ? ((S.t_fc4.elapsed_ms / (TIMEOUT_SEC * 1000)) * 100).toFixed(1) : 0) + '%';

  const tc3 = document.getElementById('tcard-fc3');
  const tv3 = document.getElementById('tval-fc3');
  const tb3 = document.getElementById('tbar-fc3');
  if (tc3) tc3.className = 'timer-card' + (t3active ? ' active' : '');
  if (tv3) {
    if (t3active) {
      const rem = clamp(TIMEOUT_SEC - S.t_fc3.elapsed_ms / 1000, 0, TIMEOUT_SEC);
      tv3.textContent = rem.toFixed(1) + 's';
    } else {
      tv3.textContent = '--';
    }
  }
  if (tb3) tb3.style.width = (t3active ? ((S.t_fc3.elapsed_ms / (TIMEOUT_SEC * 1000)) * 100).toFixed(1) : 0) + '%';
}

// ==================== MAIN LOOP ====================
let lastTimestamp = null;

function loop(timestamp) {
  if (lastTimestamp === null) lastTimestamp = timestamp;
  const dt = Math.min(timestamp - lastTimestamp, 50); // cap delta at 50ms
  lastTimestamp = timestamp;

  scan(dt);
  updateFill(dt);
  spawnParticles(dt);
  updateSimulation();
  updateLadder();
  updatePanel();

  requestAnimationFrame(loop);
}

// ==================== INPUT HANDLERS ====================
function onStart() {
  S.pb_start_held = true;
  startSystem();
}
function onStartUp() {
  S.pb_start_held = false;
}
function onStop() {
  stopSystem();
}
function onReset() {
  resetSystem();
}
function onFc3Toggle(el) {
  S.fc3_manual = el.checked;
  if (!el.checked) {
    // releasing manual force — let simulation take over
    S.fc3 = false;
    S.t_fc3.active = false;
    S.t_fc3.elapsed_ms = 0;
    S.t_fc3.triggered = false;
  }
}
function onFc4Toggle(el) {
  S.fc4_manual = el.checked;
  if (!el.checked) {
    S.fc4 = false;
    S.t_fc4.active = false;
    S.t_fc4.elapsed_ms = 0;
    S.t_fc4.triggered = false;
  }
}

// ==================== BOOT ====================
logEvent('Sistema listo — Esperando START', 'info');
requestAnimationFrame(loop);
