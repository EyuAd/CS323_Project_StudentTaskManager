

const Store = (() => {
  const KEY = 'stm.tasks.v1';
  /** Generate a simple unique id */
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2));

  /** Read tasks */
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '[]');
    } catch {
      return [];
    }
  };
  /** Write tasks */
  const write = (tasks) => localStorage.setItem(KEY, JSON.stringify(tasks));

  return {
    all() { return read().sort((a,b) => new Date(a.dueAt) - new Date(b.dueAt)); },
    get(id) { return read().find(t => t.id === id) || null; },
    create(partial) {
      const now = new Date().toISOString();
      const task = { id: uid(), title: '', description: '', category: '', priority: 'medium', dueAt: now, done: false, notify: false, createdAt: now, updatedAt: now, ...partial };
      const tasks = read(); tasks.push(task); write(tasks); return task;
    },
    update(id, updates) {
      const tasks = read();
      const idx = tasks.findIndex(t => t.id === id);
      if (idx === -1) return null;
      tasks[idx] = { ...tasks[idx], ...updates, updatedAt: new Date().toISOString() };
      write(tasks); return tasks[idx];
    },
    remove(id) { write(read().filter(t => t.id !== id)); },
    import(json) { write(json); },
    export() { return read(); },
  };
})();

/************************************
 * Reminder Engine (in-app + Notification API)
 ************************************/
const Reminders = (() => {
  let timer = null;
  const REQUESTED = 'stm.notify.requested';

  async function ensurePermission() {
    try {
      if (!('Notification' in window)) return false;
      const alreadyAsked = localStorage.getItem(REQUESTED) === '1';
      if (Notification.permission === 'granted') return true;
      if (Notification.permission !== 'denied' && !alreadyAsked) {
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
      const body = `${new Date(task.dueAt).toLocaleString()} • ${task.category || 'No category'}`;
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body });
      }
    } catch {}
  }

  function checkDue() {
    const now = Date.now();
    const soonWindow = 24 * 60 * 60 * 1000; // 24h
    const tasks = Store.all().filter(t => !t.done);
    let dueSoon = 0, overdue = 0;
    for (const t of tasks) {
      const due = new Date(t.dueAt).getTime();
      if (due < now) overdue++;
      if (due - now <= soonWindow && due >= now) dueSoon++;
      if (t.notify && due <= now && due > now - 60 * 1000) {
        // fire once within the minute it's due
        notify(t);
      }
    }
    UI.setDueSoonBadge(dueSoon);
    UI.renderStats();
  }

  return {
    start() {
      checkDue();
      if (timer) clearInterval(timer);
      timer = setInterval(checkDue, 60 * 1000); // every minute
    },
    async requestPermissionIfNeeded() { await ensurePermission(); }
  }
})();

/************************************
 * UI Rendering & Event Handlers
 ************************************/
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
  };

  let currentFilter = 'all';
  let editingId = null;
  let weeklyChart = null;

  function fmtDate(dt) { return new Date(dt).toLocaleString(); }

  function chip(priority) {
    return `<span class="chip ${priority==='high'?'chip-high':priority==='low'?'chip-low':'chip-med'}">${priority}</span>`;
  }

  function startOfWeek(date) {
    const d = new Date(date); const day = d.getDay(); // 0=Sun
    const diff = (day === 0 ? -6 : 1) - day; // make Monday start
    d.setDate(d.getDate()+diff); d.setHours(0,0,0,0); return d;
  }
  function endOfWeek(date) { const d = startOfWeek(date); d.setDate(d.getDate()+6); d.setHours(23,59,59,999); return d; }

  function renderList() {
    const query = els.search.value.trim().toLowerCase();
    const cat = els.categoryFilter.value;
    const now = Date.now();
    const weekEnd = endOfWeek(new Date());
    const weekStart = startOfWeek(new Date());

    let tasks = Store.all();
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
    if (tasks.length === 0) {
      els.empty.classList.remove('hidden');
      els.listSummary.textContent = '0 items';
      return;
    }
    els.empty.classList.add('hidden');
    els.listSummary.textContent = `${tasks.length} ${tasks.length===1?'item':'items'}`;

    for (const t of tasks) {
      const due = new Date(t.dueAt);
      const overdue = !t.done && due.getTime() < Date.now();
      const row = document.createElement('div');
      row.className = 'flex flex-col md:flex-row md:items-center gap-3 p-3';
      row.innerHTML = `
        <div class="flex items-start gap-3 flex-1">
          <input type="checkbox" ${t.done?'checked':''} class="mt-1 size-5 rounded border-slate-300" aria-label="Mark complete" />
          <div class="flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <h3 class="font-semibold ${t.done?'line-through text-slate-400':''}">${t.title}</h3>
              ${chip(t.priority)}
              ${t.category ? `<span class="chip bg-slate-100 text-slate-700">${t.category}</span>` : ''}
            </div>
            <p class="text-sm text-slate-600 mt-1">${t.description || ''}</p>
            <div class="text-xs mt-2 ${overdue? 'text-red-600':'text-slate-500'}">Due: ${fmtDate(t.dueAt)}</div>
          </div>
        </div>
        <div class="flex items-center gap-2">
          ${t.notify?'<span class="chip" style="background:#e0f2fe;color:#0369a1">Reminder</span>':''}
          <button class="btn btn-secondary" data-action="edit"><span class="i-lucide-pencil"></span> Edit</button>
          <button class="btn btn-danger" data-action="delete"><span class="i-lucide-trash-2"></span></button>
        </div>`;

      const [chk, , , btnEdit, btnDel] = row.querySelectorAll('input,div,div,button[data-action="edit"],button[data-action="delete"]');
      chk.addEventListener('change', () => { Store.update(t.id, { done: chk.checked }); renderAll(); });
      btnEdit.addEventListener('click', () => openForm(t.id));
      btnDel.addEventListener('click', () => { if (confirm('Delete this task?')) { Store.remove(t.id); renderAll(); } });

      els.list.appendChild(row);
    }
  }

  function populateFilters() {
    const cats = [...new Set(Store.all().map(t => t.category).filter(Boolean))].sort();
    els.categoryFilter.innerHTML = '<option value="">All categories</option>' + cats.map(c => `<option value="${c}">${c}</option>`).join('');
    els.catDatalist.innerHTML = cats.map(c => `<option value="${c}"></option>`).join('');
  }

  function setDueSoonBadge(count) {
    els.dueSoonBadge.textContent = `${count} due soon`;
    if (count > 0) els.dueSoonBadge.classList.remove('hidden'); else els.dueSoonBadge.classList.add('hidden');
  }

  function toLocalDateTime(date) {
    const pad = (n) => String(n).padStart(2, '0');
    const y = date.getFullYear();
    const m = pad(date.getMonth()+1);
    const d = pad(date.getDate());
    const hh = pad(date.getHours());
    const mm = pad(date.getMinutes());
    return `${y}-${m}-${d}T${hh}:${mm}`;
  }

  function openForm(id=null) {
    editingId = id;
    els.form.reset();
    els.btnDelete.classList.add('hidden');
    const when = new Date(); when.setHours(when.getHours()+2); // default +2h
    els.form.elements['dueAt'].value = toLocalDateTime(when);
    els.formTitle.textContent = id ? 'Edit Task' : 'New Task';
    if (id) {
      const t = Store.get(id);
      if (!t) return;
      els.form.elements['title'].value = t.title;
      els.form.elements['description'].value = t.description || '';
      els.form.elements['category'].value = t.category || '';
      els.form.elements['priority'].value = t.priority;
      els.form.elements['dueAt'].value = toLocalDateTime(new Date(t.dueAt));
      els.form.elements['notify'].checked = !!t.notify;
      els.btnDelete.classList.remove('hidden');
    }
    els.modal.showModal();
    els.form.elements['title'].focus();
  }

  function closeForm() { els.modal.close(); }

  function handleSubmit(e) {
    e.preventDefault();
    const fd = new FormData(els.form);
    const data = Object.fromEntries(fd.entries());
    const payload = {
      title: data.title.trim(),
      description: (data.description||'').trim(),
      category: (data.category||'').trim(),
      priority: data.priority,
      dueAt: new Date(data.dueAt).toISOString(),
      notify: !!data.notify
    };
    if (!payload.title) return alert('Title is required');
    if (editingId) Store.update(editingId, payload); else Store.create(payload);
    closeForm();
    renderAll();
  }

  function handleDelete() {
    if (editingId && confirm('Delete this task?')) { Store.remove(editingId); closeForm(); renderAll(); }
  }

  function renderStats() {
    const tasks = Store.all();
    const now = Date.now();
    const soonWindow = 24*60*60*1000;
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

  function renderWeeklyChart() {
    const sw = startOfWeek(new Date());
    const days = [...Array(7)].map((_,i) => {
      const d = new Date(sw); d.setDate(d.getDate()+i); return d;
    });
    const dayKey = (d) => d.toISOString().slice(0,10);
    const doneByDay = Object.fromEntries(days.map(d => [dayKey(d), 0]));
    const totalByDay = Object.fromEntries(days.map(d => [dayKey(d), 0]));

    for (const t of Store.all()) {
      const k = dayKey(new Date(t.dueAt));
      if (k in totalByDay) totalByDay[k]++;
      if (t.done && k in doneByDay) doneByDay[k]++;
    }

    const labels = days.map(d => d.toLocaleDateString(undefined, { weekday:'short' }));
    const doneData = days.map(d => doneByDay[dayKey(d)]);
    const totalData = days.map(d => totalByDay[dayKey(d)]);

    const ctx = document.getElementById('weeklyChart');
    if (weeklyChart) weeklyChart.destroy();
    weeklyChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Completed', data: doneData },
          { label: 'Total Due', data: totalData }
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'bottom' } },
        scales: { y: { beginAtZero: true, precision: 0 } }
      }
    });

    const end = endOfWeek(new Date());
    els.weekRange.textContent = `${sw.toLocaleDateString()} – ${end.toLocaleDateString()}`;
  }

  function bind() {
    document.getElementById('btnNewTask').addEventListener('click', () => openForm());
    els.form.addEventListener('submit', handleSubmit);
    document.getElementById('btnDelete').addEventListener('click', handleDelete);

    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => { currentFilter = btn.dataset.filter; renderList(); });
    });
    els.search.addEventListener('input', renderList);
    els.categoryFilter.addEventListener('change', renderList);

    document.getElementById('btnExport').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(Store.export(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'tasks.json'; a.click(); URL.revokeObjectURL(url);
    });
    document.getElementById('importFile').addEventListener('change', async (e) => {
      const file = e.target.files?.[0]; if (!file) return;
      const text = await file.text();
      try { const json = JSON.parse(text); if (!Array.isArray(json)) throw new Error('Invalid file'); Store.import(json); renderAll(); }
      catch { alert('Invalid JSON file'); }
      e.target.value = '';
    });

    document.getElementById('notifyCheck').addEventListener('change', (e) => {
      if (e.target.checked) Reminders.requestPermissionIfNeeded();
    });
  }

  function renderAll() {
    populateFilters();
    renderList();
    renderStats();
    renderWeeklyChart();
  }

  return { renderAll, bind, openForm, closeForm, setDueSoonBadge };
})();

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
  UI.bind();
  UI.renderAll();
  Reminders.start();

  // Seed with a sample if empty
  if (Store.all().length === 0) {
    const now = new Date();
    Store.create({ title: 'Finish math assignment', category: 'Math', priority: 'high', dueAt: new Date(now.getTime()+6*60*60*1000).toISOString(), notify: true });
    Store.create({ title: 'Read Chapter 4', category: 'History', priority: 'medium', dueAt: new Date(now.getTime()+30*60*60*1000).toISOString(), notify: false });
    Store.create({ title: 'Group project sync', category: 'CS', priority: 'low', dueAt: new Date(now.getTime()-12*60*60*1000).toISOString(), notify: false, done: true });
    UI.renderAll();
  }
});
