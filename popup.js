const DEFAULTS = {
  mode: 'chatters',
  initialCount: 5,
  windowMin: 5,
  pollSec: 30,
  showDeletedMessages: true,
  useApi: true,
  ignoreBots: true,
  bots: 'botrix,kickbot,nightbot,streamelements,fossabot,moobot,wizebot'
};

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
};

chrome.storage.sync.get(DEFAULTS, (s) => {
  $('mode').value = s.mode || DEFAULTS.mode;
  $('initialCount').value = s.initialCount || DEFAULTS.initialCount;
  $('windowMin').value = s.windowMin || DEFAULTS.windowMin;
  $('pollSec').value = s.pollSec || DEFAULTS.pollSec;
  $('showDeletedMessages').checked = s.showDeletedMessages !== false;
  $('useApi').checked = s.useApi !== false;
  $('ignoreBots').checked = s.ignoreBots !== false;
  $('bots').value = s.bots || DEFAULTS.bots;
});

$('save').addEventListener('click', () => {
  const next = {
    mode: $('mode').value,
    initialCount: clamp($('initialCount').value, 2, 25, DEFAULTS.initialCount),
    windowMin: clamp($('windowMin').value, 1, 30, DEFAULTS.windowMin),
    pollSec: clamp($('pollSec').value, 15, 120, DEFAULTS.pollSec),
    showDeletedMessages: $('showDeletedMessages').checked,
    useApi: $('useApi').checked,
    ignoreBots: $('ignoreBots').checked,
    bots: $('bots').value.trim()
  };
  chrome.storage.sync.set(next, () => {
    $('msg').textContent = 'Saved! Changes applied immediately.';
    setTimeout(() => ($('msg').textContent = ''), 2500);
  });
});
