/**
 * Front-end entry point for Student Task Manager.
 * Chooses the storage driver, renders tasks, and maintains reminder state.
 */
// Session helpers keep the UI aligned with the PHP session state.
async function checkSession(){
  try{
    const r = await fetch('server/auth.php?action=session',{credentials:'same-origin'});
    if(!r.ok) return {authenticated:false};
    return r.json();
  }catch{
    return {authenticated:false};
  }
}
async function logout(){
  try{ await fetch('server/auth.php?action=logout',{credentials:'same-origin'}); }catch{}
  window.location.href='auth.html';
}
async function pingServer() {
  try {
    const res = await fetch('server/tasks.php?ping=1', { credentials:'same-origin' });
    return res.ok;
  } catch { return false; }
}

// Storage drivers: first localStorage fallback, then the authenticated server API.
// Local persistence fallback when the server is unavailable.
const LocalStore = (() => {
  const KEY = 'stm.tasks.v1';
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
  const write = (tasks) => localStorage.setItem(KEY, JSON.stringify(tasks));
  return {
    name: 'local',
    async all() { return read().sort((a,b) => new Date(a.dueAt) - new Date(b.dueAt)); },
    async get(id) { return read().find(t => t.id === id) || null; },
    async create(partial) {
     
      const nowIso = new Date().toISOString();
      const task = {
        id: uid(),
        title: '',
        description: '',
        category: '',
        priority: 'medium',
        dueAt: nowIso,
        done: false,
        notify: false,
        createdAt: nowIso,
        updatedAt: nowIso,
        ...partial
      };
      const tasks = read(); tasks.push(task); write(tasks); return task;
    },
    async update(id, updates) {
      const tasks = read();
      const idx = tasks.findIndex(t => t.id === id);
      if (idx === -1) return null;
      tasks[idx] = { ...tasks[idx], ...updates, updatedAt: new Date().toISOString() };
      write(tasks); return tasks[idx];
    },
    async remove(id) { write(read().filter(t => t.id !== id)); },
    async import(json) { write(json); },
    async export() { return read(); },
  };
})();

// Server-backed persistence that requires a valid PHP session.
const ServerStore = (() => {
  const base = 'server/tasks.php';
  const headers = { 'Content-Type': 'application/json' };
  async function j(res){ if(!res.ok){ const t=await res.text(); throw new Error(t||('HTTP '+res.status)); } return res.json(); }
  return {
    name: 'server',
    async all(){ return j(await fetch(base, { credentials:'same-origin' })); },
    async get(id){ return j(await fetch(`${base}?id=${encodeURIComponent(id)}`, { credentials:'same-origin' })); },
    async create(partial){
      return j(await fetch(base, { method:'POST', headers, body: JSON.stringify(partial), credentials:'same-origin' }));
    },
    async update(id, updates){
      return j(await fetch(`${base}?id=${encodeURIComponent(id)}`, { method:'PATCH', headers, body: JSON.stringify(updates), credentials:'same-origin' }));
    },
    async remove(id){
      await j(await fetch(`${base}?id=${encodeURIComponent(id)}`, { method:'DELETE', credentials:'same-origin' }));
    },
    async import(json){
      await j(await fetch(`${base}?import=1`, { method:'POST', headers, body: JSON.stringify(json), credentials:'same-origin' }));
    },
    async export(){ return j(await fetch(`${base}?export=1`, { credentials:'same-origin' })); },
  };
})();

// Reminder poller keeps badge counts and browser notifications in sync with due dates.
const Reminders = (() => {
  let timer = null;
  const REQUESTED = 'stm.notify.requested';
  async function ensurePermission() {
    try {
      if (!('Notification' in window)) return false;
      const already = localStorage.getItem(REQUESTED) === '1';
      if (Notification.permission === 'granted') return true;
      if (Notification.permission !== 'denied' && !already) {
        const perm = await Notification.requestPermission();
        localStorage.setItem(REQUESTED, '1');
        return perm === 'granted';
      }
    } catch {}
    return false;
  }
  function notify(task) {
    try {
      const title = `Task due: ${task.title}`;
      const body = `${new Date(task.dueAt).toLocaleString()} - ${task.category || 'No category'}`;
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body });
      }
    } catch {}
  }
  // Poll tasks to trigger notifications and update the due-soon badge.
  async function checkDue(Store) {
    const now = Date.now();
    const soonWindow = 24*60*60*1000;
    const tasks = (await Store.all()).filter(t => !t.done);
    let dueSoon = 0;
    for (const t of tasks) {
      const due = new Date(t.dueAt).getTime();
      if (due - now <= soonWindow && due >= now) dueSoon++;
      if (t.notify && due <= now && due > now - 60*1000) notify(t);
    }
    UI.setDueSoonBadge(dueSoon);
    UI.renderStats(Store);
  }
  return {
    start(Store){
      checkDue(Store);
      if (timer) clearInterval(timer);
      timer = setInterval(()=>checkDue(Store), 60*1000);
    },
    requestPermissionIfNeeded: ensurePermission
  };
})();

// ---------------- UI / App -------------------------------
const UI = (() => {
  const els = {
    list: document.getElementById('taskList'),
    empty: document.getElementById('emptyState'),
    listSummary: document.getElementById('listSummary'),
    modal: document.getElementById('taskModal'),
    form: document.getElementById('taskForm'),
    formTitle: document.getElementById('formTitle'),
    btnDelete: document.getElementById('btnDelete'),
    search: document.getElementById('search'),
    categoryFilter: document.getElementById('categoryFilter'),
    catDatalist: document.getElementById('categoryList'),
    weekRange: document.getElementById('weekRange'),
    statTotal: document.getElementById('statTotal'),
    statDone: document.getElementById('statDone'),
    statSoon: document.getElementById('statSoon'),
    statOverdue: document.getElementById('statOverdue'),
    dueSoonBadge: document.getElementById('dueSoonBadge'),
    tpl: document.getElementById('taskRowTemplate')
  };

  let currentFilter = 'all';
  let editingId = null;
  let weeklyChart = null;
  let Store = LocalStore;

  // Format stored UTC timestamps for display in the user's locale.
  const fmtDate = (isoZ) => new Date(isoZ).toLocaleString();

  const startOfWeek = (date) => { const d=new Date(date); const day=d.getDay(); const diff=(day===0?-6:1)-day; d.setDate(d.getDate()+diff); d.setHours(0,0,0,0); return d; };
  const endOfWeek   = (date) => { const d=startOfWeek(date); d.setDate(d.getDate()+6); d.setHours(23,59,59,999); return d; };

  // Recognize multiple UI affordances that should open the task form.
  const NEW_TASK_SELECTORS = [
    '#btnNewTask', '#btnAddTask', '#addTask', '#taskAdd', '#add',
    '.btn-add', '.btn-add-task', '.add-task', '.addTask',
    '[data-action="newTask"]', '[data-new-task]', '[data-action="add-task"]',
    '[aria-label="Add Task"]'
  ];
  function looksLikeNewTask(el){ if(!el) return false; const t=(el.getAttribute('aria-label')||el.textContent||'').toLowerCase().replace(/\s+/g,' ').trim(); return /(^|\b)(add|new)\s+task(s)?\b/.test(t); }
  function isClickable(el){ if(!el) return false; const role=el.getAttribute && el.getAttribute('role'); return ['BUTTON','A'].includes(el.tagName) || role==='button'; }
  document.addEventListener('click', (e)=>{
    let match = e.target.closest(NEW_TASK_SELECTORS.join(','));
    if(!match){
      for (let n=e.target; n && n !== document; n = n.parentElement) {
        if (isClickable(n) && looksLikeNewTask(n)) { match = n; break; }
      }
    }
    if (match){ e.preventDefault(); openForm(); }
  }, true);

  function priorityChipEl(priority){
    const span=document.createElement('span'); span.classList.add('chip');
    if (priority==='high'){ span.classList.add('chip-high'); span.textContent='high'; }
    else if (priority==='low'){ span.classList.add('chip-low'); span.textContent='low'; }
    else { span.classList.add('chip-med'); span.textContent='medium'; }
    return span;
  }

  /**
   * Render the task list using the active filters, search, and sort order.
   */
  async function renderList() {
    const query = els.search?.value?.trim().toLowerCase() || '';
    const cat = els.categoryFilter?.value || '';
    const now = Date.now();
    const weekEnd = endOfWeek(new Date());
    const weekStart = startOfWeek(new Date());

    let tasks = await Store.all();
    if (query) tasks = tasks.filter(t => t.title.toLowerCase().includes(query) || (t.description||'').toLowerCase().includes(query));
    if (cat) tasks = tasks.filter(t => t.category === cat);

    tasks = tasks.filter(t => {
      const due = new Date(t.dueAt).getTime(); 
      switch (currentFilter) {
        case 'today': {
          const d = new Date(); const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
          const end = start + 24*60*60*1000;
          return due>=start && due<end;
        }
        case 'week': return due>=weekStart.getTime() && due<=weekEnd.getTime();
        case 'overdue': return !t.done && due < now;
        case 'completed': return t.done;
        default: return true;
      }
    });

    els.list.innerHTML = '';
    if (!tasks.length) { els.empty?.classList?.remove('hidden'); els.listSummary && (els.listSummary.textContent = '0 items'); return; }
    els.empty?.classList?.add('hidden');
    if (els.listSummary) els.listSummary.textContent = `${tasks.length} ${tasks.length===1?'item':'items'}`;

    for (const t of tasks) {
      const frag = els.tpl.content.cloneNode(true);
      const chk = frag.querySelector('.toggle-done');
      const title = frag.querySelector('.title');
      const desc = frag.querySelector('.desc');
      const due = frag.querySelector('.due');
      const prio = frag.querySelector('.priority-chip');
      const catChip = frag.querySelector('.category-chip');
      const reminder = frag.querySelector('.reminder-chip');
      const btnEdit = frag.querySelector('.edit-btn');
      const btnDel = frag.querySelector('.delete-btn');
      const origin = frag.querySelector('.origin');

      chk.checked = t.done;
      title.textContent = t.title;
      if (t.done) title.classList.add('line-through','text-slate-400');
      desc.textContent = t.description || '';
      const overdue = !t.done && new Date(t.dueAt).getTime() < Date.now();
      // Show due dates in the viewer's local timezone.
      due.textContent = `Due: ${fmtDate(t.dueAt)}`;
      due.className = `text-xs mt-2 ${overdue ? 'text-red-600' : 'text-slate-500'}`;

      if (origin) {
        const assignedName = t.assignedBy && (t.assignedBy.username || t.assignedBy.email);
        if (t.assignedBy && t.assignedById && t.assignedById !== t.ownerId) {
          const label = assignedName || 'Mentor';
          origin.textContent = `Assigned by ${label}`;
          origin.classList.remove('hidden');
        } else {
          origin.textContent = '';
          origin.classList.add('hidden');
        }
      }

      const pc = priorityChipEl(t.priority);
      prio.replaceWith(pc);

      if (t.category) { catChip.textContent = t.category; catChip.classList.remove('hidden'); }
      if (t.notify) reminder.classList.remove('hidden');

      chk.addEventListener('change', async () => { await Store.update(t.id, { done: chk.checked }); renderAll(Store); });
      btnEdit.addEventListener('click', () => openForm(t.id));
      btnDel.addEventListener('click', async () => { if (confirm('Delete this task?')) { await Store.remove(t.id); renderAll(Store); } });

      els.list.appendChild(frag);
    }
  }

  // Populate category inputs based on the current task set.
  async function populateFilters() {
    if (!els.categoryFilter || !els.catDatalist) return;
    const cats = [...new Set((await Store.all()).map(t => t.category).filter(Boolean))].sort();
    els.categoryFilter.innerHTML = '<option value=\"\">All categories</option>' + cats.map(c => `<option value="${c}">${c}</option>`).join('');
    els.catDatalist.innerHTML = cats.map(c => `<option value="${c}"></option>`).join('');
  }

  // Update the due-soon badge count and visibility.
  function setDueSoonBadge(count) {
    if (!els.dueSoonBadge) return;
    els.dueSoonBadge.textContent = `${count} due soon`;
    if (count > 0) els.dueSoonBadge.classList.remove('hidden'); else els.dueSoonBadge.classList.add('hidden');
  }

  // Convert Date values into the string format expected by datetime-local inputs.
  function toLocalDateTime(date) {
    const pad = (n) => String(n).padStart(2, '0');
    const y = date.getFullYear(); const m = pad(date.getMonth()+1); const d = pad(date.getDate());
    const hh = pad(date.getHours()); const mm = pad(date.getMinutes());
    return `${y}-${m}-${d}T${hh}:${mm}`;
  }

  // Open the modal for creating or editing a task and prefill values.
  async function openForm(id=null) {
    if (!els.modal || !els.form) return;
    editingId = id;
    els.form.reset();
    els.btnDelete?.classList?.add('hidden');

    
    const when = new Date(); when.setHours(when.getHours()+2);
    els.form.elements['dueAt'].value = toLocalDateTime(when);

    els.formTitle && (els.formTitle.textContent = id ? 'Edit Task' : 'New Task');

    if (id) {
      const t = await Store.get(id); if (!t) return;
      els.form.elements['title'].value = t.title;
      els.form.elements['description'].value = t.description || '';
      els.form.elements['category'].value = t.category || '';
      els.form.elements['priority'].value = t.priority;

  
      const d = new Date(t.dueAt);
      els.form.elements['dueAt'].value = toLocalDateTime(d);

      els.form.elements['notify'].checked = !!t.notify;
      els.btnDelete?.classList?.remove('hidden');
    }

    els.modal.showModal();
    els.form.elements['title'].focus();
  }
  function closeForm(){ els.modal?.close(); }
  if (!window.UI) window.UI = {};
  window.UI.openForm = openForm;
  window.UI.closeForm = closeForm;

  // Normalize form data before persisting (always send UTC timestamps).
  // Persist form data then refresh the task list.
  async function handleSubmit(e){
    e.preventDefault();
    const fd = new FormData(els.form);
    const data = Object.fromEntries(fd.entries());

    const dueAtUtc = new Date(data.dueAt).toISOString();

    const payload = {
      title: data.title.trim(),
      description: (data.description||'').trim(),
      category: (data.category||'').trim(),
      priority: data.priority,
      dueAt: dueAtUtc,         
      notify: !!data.notify
    };

    if (!payload.title) return alert('Title is required');

    if (editingId) await Store.update(editingId, payload);
    else await Store.create(payload);

    closeForm();
    renderAll(Store);
  }

  // Delete the currently edited task and refresh the view.
  async function handleDelete(){
    if (editingId && confirm('Delete this task?')) {
      await Store.remove(editingId);
      closeForm(); renderAll(Store);
    }
  }

  // Statistics panels and weekly completion chart.
  /**
   * Compute aggregate stats for the dashboard cards.
   */
  async function renderStats(Store){
    if (!els.statTotal) return;
    const tasks = await Store.all();
    const now = Date.now(); const soonWindow = 24*60*60*1000;
    const overdue = tasks.filter(t => !t.done && new Date(t.dueAt).getTime() < now).length;
    const soon = tasks.filter(t => !t.done).filter(t => {
      const due = new Date(t.dueAt).getTime();
      return due >= now && (due - now) <= soonWindow;
    }).length;
    const done = tasks.filter(t => t.done).length;
    els.statTotal.textContent = tasks.length;
    els.statDone.textContent = done;
    els.statSoon.textContent = soon;
    els.statOverdue.textContent = overdue;
  }

  /**
   * Render a seven day completion chart using Chart.js if it is available.
   */
  async function renderWeeklyChart(Store){
    if (typeof Chart === 'undefined') return;
    const canvas = document.getElementById('weeklyChart');
    if (!canvas) return;
    if (!canvas.style.height) canvas.style.height = '220px';

    const keyLocal = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

    const startOfWeekLocal = (date) => { const d = new Date(date); const day = d.getDay(); const diff = (day === 0 ? -6 : 1) - day; d.setDate(d.getDate() + diff); d.setHours(0,0,0,0); return d; };
    const endOfWeekLocal   = (date) => { const d = startOfWeekLocal(date); d.setDate(d.getDate() + 6); d.setHours(23,59,59,999); return d; };

    const sw = startOfWeekLocal(new Date());
    const days = [...Array(7)].map((_, i) => { const d = new Date(sw); d.setDate(d.getDate() + i); d.setHours(0,0,0,0); return d; });

    const doneByDay  = Object.fromEntries(days.map(d => [keyLocal(d), 0]));
    const totalByDay = Object.fromEntries(days.map(d => [keyLocal(d), 0]));

    const tasks = await Store.all();
    for (const t of tasks) {
      const due = new Date(t.dueAt);
      const localDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
      const k = keyLocal(localDay);
      if (k in totalByDay) {
        totalByDay[k]++;
        if (t.done) doneByDay[k]++;
      }
    }

    const labels   = days.map(d => d.toLocaleDateString(undefined, { weekday: 'short' }));
    const doneData = days.map(d => doneByDay[keyLocal(d)]);
    const totData  = days.map(d => totalByDay[keyLocal(d)]);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (window.weeklyChart?.destroy) window.weeklyChart.destroy();

    window.weeklyChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Completed', data: doneData },
          { label: 'Total Due', data: totData }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
      }
    });

    const end = endOfWeekLocal(new Date());
    const wr = document.getElementById('weekRange');
    if (wr) wr.textContent = `${sw.toLocaleDateString()} - ${end.toLocaleDateString()}`;
  }

  // Wire up DOM event handlers after the store has been selected.
  // Attach an event handler to every element that matches any selector.
  function onAll(selectors, type, handler) {
    selectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => el.addEventListener(type, handler));
    });
  }

  // Register UI event handlers that depend on the active storage driver.
  function bind(StoreRef){
    onAll(
      ['#btnNewTask', '#btnAddTask', '#addTask', '#taskAdd', '.btn-add', '.btn-add-task', '.add-task', '[data-action="newTask"]'],
      'click',
      (e) => { e.preventDefault(); openForm(); }
    );

    if (els.form) els.form.addEventListener('submit', handleSubmit);
    const del = document.getElementById('btnDelete'); if (del) del.addEventListener('click', handleDelete);

    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => { currentFilter = btn.dataset.filter; renderList(); });
    });
    els.search?.addEventListener('input', renderList);
    els.categoryFilter?.addEventListener('change', renderList);

    const btnExport = document.getElementById('btnExport');
    if (btnExport) btnExport.addEventListener('click', async () => {
      const blob=new Blob([JSON.stringify(await Store.export(),null,2)],{type:'application/json'});
      const url=URL.createObjectURL(blob); const a=document.createElement('a');
      a.href=url; a.download='tasks.json'; a.click(); URL.revokeObjectURL(url);
    });
    const importFile = document.getElementById('importFile');
    if (importFile) importFile.addEventListener('change', async (e) => {
      const file=e.target.files?.[0]; if(!file) return;
      const text=await file.text();
      try{
        const json=JSON.parse(text);
        if(!Array.isArray(json)) throw new Error('Invalid file');
  
        await Store.import(json);
        renderAll(Store);
      } catch { alert('Invalid JSON file'); }
      e.target.value='';
    });

    const notifyCheck = document.getElementById('notifyCheck');
    if (notifyCheck) notifyCheck.addEventListener('change', (e)=>{ if(e.target.checked) Reminders.requestPermissionIfNeeded(); });

    const btnSave =
      document.getElementById('btnSaveTask') ||
      document.querySelector('[data-action="saveTask"]') ||
      document.querySelector('.btn-save');
    if (btnSave) {
      btnSave.addEventListener('click', (e) => {
        e.preventDefault();
        if (els.form?.requestSubmit) els.form.requestSubmit();
        else els.form?.dispatchEvent(new Event('submit', { cancelable: true }));
      });
    }

    const btnClose =
      document.getElementById('btnCloseModal') ||
      document.querySelector('[data-action="closeModal"]') ||
      document.querySelector('.btn-close');
    if (btnClose) {
      btnClose.addEventListener('click', (e) => {
        e.preventDefault();
        if (typeof els.modal?.close === 'function') els.modal.close();
      });
    }

    if (els.modal && typeof els.modal.addEventListener === 'function') {
      els.modal.addEventListener('click', (e) => {
        const rect = els.modal.getBoundingClientRect();
        const outside =
          e.clientX < rect.left || e.clientX > rect.right ||
          e.clientY < rect.top || e.clientY > rect.bottom;
        if (outside) els.modal.close();
      });
    }
  }

  // Refresh filters, list, stats, and charts in sequence.
  async function renderAll(StoreRef){
    await populateFilters();
    await renderList();
    await renderStats(StoreRef);
    await renderWeeklyChart(StoreRef);
  }

  /**
   * Select a storage driver, enforce auth when needed, and bootstrap the UI.
   */
  async function init(){
    const serverUp = await pingServer();
    Store = serverUp ? ServerStore : LocalStore;

    if (Store.name==='server') {
      const s = await checkSession();
      if (!s.authenticated) { window.location.href='auth.html'; return; }
      const role = s.user?.role;
      if (role === 'mentor') { window.location.href='mentor.html'; return; }
      if (role === 'admin') { window.location.href='admin.html'; return; }
      const el = document.getElementById('userName');
      if (el && s.user) el.textContent = s.user.username;
      const lo = document.getElementById('btnLogout');
      if (lo) lo.addEventListener('click', logout);
    }

    bind(Store);
    await renderAll(Store);
    Reminders.start(Store);

 
    // Seed demo data on first launch so local mode is not empty.
    if (Store.name === 'local' && (await Store.all()).length === 0) {
      const now = Date.now();
      await Store.create({ title: 'Finish math assignment', category: 'Math',    priority: 'high',   dueAt: new Date(now+6*3600e3).toISOString(),  notify: true });
      await Store.create({ title: 'Read Chapter 4',         category: 'History', priority: 'medium', dueAt: new Date(now+30*3600e3).toISOString(), notify: false });
      await Store.create({ title: 'Group project sync',     category: 'CS',      priority: 'low',    dueAt: new Date(now-12*3600e3).toISOString(), notify: false, done: true });
      await renderAll(Store);
    }
  }

  return { init, setDueSoonBadge };
})();

document.addEventListener('DOMContentLoaded', () => UI.init());

