(() => {
  const DEFAULTS = {
    durations: { pomodoro: 25, short: 5, long: 15 },
    longInterval: 4,
    tickEnabled: true,
    volume: 0.5,
    alarm: { type: 'synth-bell', customName: '' }
  };

  const els = {
    time: document.getElementById('time-display'),
    startPause: document.getElementById('start-pause'),
    reset: document.getElementById('reset'),
    next: document.getElementById('next'),
    modeButtons: Array.from(document.querySelectorAll('.mode-btn')),
    tickToggle: document.getElementById('tick-toggle'),
    volume: document.getElementById('volume'),
    testSound: document.getElementById('test-sound'),
    alarmSelect: document.getElementById('alarm-select'),
    alarmFile: document.getElementById('alarm-file'),
    alarmFileName: document.getElementById('alarm-file-name'),
    settingsBtn: document.getElementById('open-settings'),
    settingsDialog: document.getElementById('settings-dialog'),
    saveSettings: document.getElementById('save-settings'),
    durPomodoro: document.getElementById('dur-pomodoro'),
    durShort: document.getElementById('dur-short'),
    durLong: document.getElementById('dur-long'),
    longInterval: document.getElementById('long-interval')
  };
  // Checklist elements
  Object.assign(els, {
    taskForm: document.getElementById('task-form'),
    taskInput: document.getElementById('task-input'),
    taskList: document.getElementById('task-list'),
    clearCompleted: document.getElementById('clear-completed'),
    clearAll: document.getElementById('clear-all')
  });

  let settings = loadSettings();
  let tasks = loadTasks();
  let state = {
    mode: 'pomodoro',
    remainingSec: DEFAULTS.durations.pomodoro * 60,
    running: false,
    completedPomodoros: 0,
    intervalId: null,
    lastTickTs: null
  };

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  let tickOsc = null; // ticking source
  let alarmBuffer = null; // for synthesized alarms
  let customAlarmUrl = null; // object URL for custom file

  function loadSettings(){
    try{
      const raw = localStorage.getItem('pomo-settings');
      if(!raw) return structuredClone(DEFAULTS);
      return { ...structuredClone(DEFAULTS), ...JSON.parse(raw) };
    }catch{ return structuredClone(DEFAULTS); }
  }
  function saveSettings(){
    localStorage.setItem('pomo-settings', JSON.stringify(settings));
  }
  function loadTasks(){
    try{
      const raw = localStorage.getItem('pomo-tasks');
      if(!raw) return [];
      const arr = JSON.parse(raw);
      if(Array.isArray(arr)) return arr.filter(t => t && typeof t.title === 'string').map(t => ({ id: t.id || crypto.randomUUID(), title: t.title, done: !!t.done }));
      return [];
    }catch{ return []; }
  }
  function saveTasks(){
    localStorage.setItem('pomo-tasks', JSON.stringify(tasks));
  }

  function formatTime(sec){
    const m = Math.floor(sec/60).toString().padStart(2,'0');
    const s = Math.floor(sec%60).toString().padStart(2,'0');
    return `${m}:${s}`;
  }

  function updateDisplay(){
    els.time.textContent = formatTime(state.remainingSec);
    // aria label for screen readers
    els.time.setAttribute('aria-label', `${Math.floor(state.remainingSec/60)} минут ${state.remainingSec%60} секунд`);
  }

  // -------- Checklist ---------
  function renderTasks(){
    if(!els.taskList) return;
    els.taskList.innerHTML = '';
    for(const t of tasks){
      const li = document.createElement('li');
      li.className = 'task-item' + (t.done ? ' completed' : '');
      li.dataset.id = t.id;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = t.done;
      cb.addEventListener('change', () => toggleTask(t.id, cb.checked));

      const title = document.createElement('input');
      title.type = 'text';
      title.className = 'task-title';
      title.value = t.title;
      title.addEventListener('change', () => renameTask(t.id, title.value));

      const del = document.createElement('button');
      del.className = 'icon-del';
      del.title = 'Удалить';
      del.textContent = '✕';
      del.addEventListener('click', () => deleteTask(t.id));

      li.appendChild(cb);
      li.appendChild(title);
      li.appendChild(del);
      els.taskList.appendChild(li);
    }
  }
  function addTask(title){
    const trimmed = title.trim();
    if(!trimmed) return;
    const task = { id: crypto.randomUUID(), title: trimmed, done: false };
    tasks.push(task);
    saveTasks();
    renderTasks();
  }
  function toggleTask(id, done){
    const t = tasks.find(x => x.id === id);
    if(!t) return;
    t.done = !!done;
    saveTasks();
    renderTasks();
  }
  function renameTask(id, title){
    const t = tasks.find(x => x.id === id);
    if(!t) return;
    t.title = title.trim();
    saveTasks();
    renderTasks();
  }
  function deleteTask(id){
    tasks = tasks.filter(x => x.id !== id);
    saveTasks();
    renderTasks();
  }
  function clearCompletedTasks(){
    tasks = tasks.filter(x => !x.done);
    saveTasks();
    renderTasks();
  }
  function clearAllTasks(){
    tasks = [];
    saveTasks();
    renderTasks();
  }

  function setMode(mode){
    state.mode = mode;
    const mins = settings.durations[mode];
    state.remainingSec = Math.max(1, mins) * 60;
    els.modeButtons.forEach(b => {
      const active = b.dataset.mode === mode;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    });
    updateDisplay();
    stopTicking();
    state.running = false;
    els.startPause.textContent = 'Старт';
  }

  function scheduleNextMode(){
    if(state.mode === 'pomodoro'){
      state.completedPomodoros += 1;
      const isLong = state.completedPomodoros % settings.longInterval === 0;
      setMode(isLong ? 'long' : 'short');
    } else {
      setMode('pomodoro');
    }
  }

  function start(){
    if(state.running) return;
    state.running = true;
    state.lastTickTs = performance.now();
    if(settings.tickEnabled) startTicking();
    els.startPause.textContent = 'Пауза';
    state.intervalId = requestAnimationFrame(tickLoop);
  }
  function pause(){
    if(!state.running) return;
    state.running = false;
    els.startPause.textContent = 'Старт';
    stopTicking();
    if(state.intervalId){ cancelAnimationFrame(state.intervalId); state.intervalId = null; }
  }
  function reset(){
    const prevMode = state.mode;
    setMode(prevMode);
  }

  function tickLoop(now){
    if(!state.running){ return; }
    const dt = Math.max(0, now - state.lastTickTs);
    // accumulate in milliseconds to reduce drift
    if(dt >= 1000){
      const step = Math.floor(dt/1000);
      state.remainingSec = Math.max(0, state.remainingSec - step);
      state.lastTickTs = now;
      updateDisplay();
      if(state.remainingSec <= 0){
        pause();
        playAlarm();
        scheduleNextMode();
        return;
      }
    }
    state.intervalId = requestAnimationFrame(tickLoop);
  }

  // Ticking using short per-second click via oscillator envelope
  function startTicking(){
    if(tickOsc) return;
    tickOsc = { active: true };
    let lastSec = Math.floor(state.remainingSec);
    const drive = () => {
      if(!tickOsc || !tickOsc.active) return;
      const secNow = Math.floor(state.remainingSec);
      if(secNow !== lastSec){
        lastSec = secNow;
        playTick();
      }
      tickOsc.raf = requestAnimationFrame(drive);
    };
    playTick();
    tickOsc.raf = requestAnimationFrame(drive);
  }
  function stopTicking(){
    if(!tickOsc) return;
    tickOsc.active = false;
    if(tickOsc.raf) cancelAnimationFrame(tickOsc.raf);
    tickOsc = null;
  }
  function playTick(){
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 880;
    gain.gain.value = 0;
    osc.connect(gain).connect(audioCtx.destination);
    const now = audioCtx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.04 * settings.volume, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
    osc.start(now);
    osc.stop(now + 0.1);
  }

  // Alarm
  async function playAlarm(){
    const type = settings.alarm.type;
    if(type === 'custom' && customAlarmUrl){
      const audio = new Audio(customAlarmUrl);
      audio.volume = settings.volume;
      await audio.play();
      return;
    }
    if(!alarmBuffer){
      alarmBuffer = await createSynthAlarmBuffer(type);
    }
    const src = audioCtx.createBufferSource();
    src.buffer = alarmBuffer;
    const gain = audioCtx.createGain();
    gain.gain.value = settings.volume;
    src.connect(gain).connect(audioCtx.destination);
    src.start();
  }

  async function createSynthAlarmBuffer(kind){
    const duration = 2.0;
    const sampleRate = audioCtx.sampleRate;
    const length = Math.floor(duration * sampleRate);
    const buffer = audioCtx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    const baseFreq = kind === 'synth-beep' ? 880 : 660;
    for(let i=0;i<length;i++){
      const t = i/sampleRate;
      const env = Math.exp(-3*t);
      const freq = baseFreq + 4*Math.sin(2*Math.PI*3*t);
      data[i] = Math.sin(2*Math.PI*freq*t) * env;
    }
    return buffer;
  }

  async function testSound(){
    // quick short beep
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 1000;
    gain.gain.value = 0;
    osc.connect(gain).connect(audioCtx.destination);
    const now = audioCtx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.2 * settings.volume, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
    osc.start(now);
    osc.stop(now + 0.25);
  }

  // UI events
  els.startPause.addEventListener('click', () => {
    // resume audio context if suspended (autoplay policy)
    if(audioCtx.state === 'suspended') audioCtx.resume();
    state.running ? pause() : start();
  });
  els.reset.addEventListener('click', reset);
  els.next.addEventListener('click', () => { pause(); scheduleNextMode(); });

  els.modeButtons.forEach(btn => btn.addEventListener('click', () => {
    pause();
    setMode(btn.dataset.mode);
  }));

  els.tickToggle.checked = settings.tickEnabled;
  els.tickToggle.addEventListener('change', e => {
    settings.tickEnabled = e.target.checked;
    saveSettings();
    if(!settings.tickEnabled) stopTicking();
    else if(state.running) startTicking();
  });

  els.volume.value = String(settings.volume);
  els.volume.addEventListener('input', e => {
    settings.volume = Number(e.target.value);
    saveSettings();
  });
  els.testSound.addEventListener('click', () => { if(audioCtx.state==='suspended') audioCtx.resume(); testSound(); });

  els.alarmSelect.value = settings.alarm.type;
  updateAlarmFileName();
  els.alarmSelect.addEventListener('change', () => {
    const val = els.alarmSelect.value;
    if(val === 'custom'){
      els.alarmFile.click();
    } else {
      settings.alarm = { type: val, customName: '' };
      saveSettings();
      alarmBuffer = null; // regenerate for new type
      updateAlarmFileName();
    }
  });
  els.alarmFile.addEventListener('change', () => {
    const file = els.alarmFile.files && els.alarmFile.files[0];
    if(file){
      if(customAlarmUrl) URL.revokeObjectURL(customAlarmUrl);
      customAlarmUrl = URL.createObjectURL(file);
      settings.alarm = { type: 'custom', customName: file.name };
      saveSettings();
      els.alarmSelect.value = 'custom';
      updateAlarmFileName();
    } else {
      els.alarmSelect.value = settings.alarm.type;
    }
  });

  function updateAlarmFileName(){
    els.alarmFileName.textContent = settings.alarm.type === 'custom' ? settings.alarm.customName : '';
  }

  // Settings dialog
  els.settingsBtn.addEventListener('click', () => {
    els.durPomodoro.value = String(settings.durations.pomodoro);
    els.durShort.value = String(settings.durations.short);
    els.durLong.value = String(settings.durations.long);
    els.longInterval.value = String(settings.longInterval);
    els.settingsDialog.showModal();
  });
  els.saveSettings.addEventListener('click', (e) => {
    e.preventDefault();
    settings.durations.pomodoro = clampInt(els.durPomodoro.value, 1, 120);
    settings.durations.short = clampInt(els.durShort.value, 1, 60);
    settings.durations.long = clampInt(els.durLong.value, 1, 60);
    settings.longInterval = clampInt(els.longInterval.value, 2, 12);
    saveSettings();
    els.settingsDialog.close();
    setMode(state.mode);
  });

  // Checklist events
  if(els.taskForm){
    els.taskForm.addEventListener('submit', (e) => {
      e.preventDefault();
      addTask(els.taskInput.value || '');
      els.taskInput.value = '';
    });
  }
  if(els.clearCompleted){
    els.clearCompleted.addEventListener('click', clearCompletedTasks);
  }
  if(els.clearAll){
    els.clearAll.addEventListener('click', clearAllTasks);
  }

  function clampInt(val, min, max){
    const n = Math.round(Number(val));
    return Math.max(min, Math.min(max, isFinite(n) ? n : min));
  }

  // Initialize
  setMode('pomodoro');
  els.volume.value = String(settings.volume);
  updateDisplay();
  renderTasks();
})();



