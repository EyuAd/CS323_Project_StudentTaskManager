const state = {
  students: [],
  selectedId: null,
  session: null
};

async function request(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

async function ensureSession() {
  const session = await request('server/auth.php?action=session');
  if (!session.authenticated || !session.user) {
    window.location.href = 'auth.html';
    return null;
  }
  const role = session.user.role;
  if (role === 'student') {
    window.location.href = 'index.html';
    return null;
  }
  if (role === 'admin') {
    // Admins may prefer the admin dashboard.
    window.location.href = 'admin.html';
    return null;
  }
  state.session = session.user;
  return session.user;
}

function updateSummary(summary) {
  document.getElementById('summaryStudents').textContent = summary.students ?? 0;
  document.getElementById('summaryAssigned').textContent = summary.tasksAssigned ?? 0;
  document.getElementById('summaryOpen').textContent = summary.openTasks ?? 0;
  document.getElementById('summaryCompleted').textContent = summary.completedTasks ?? 0;
}

function renderStudents() {
  const list = document.getElementById('studentList');
  const empty = document.getElementById('studentEmpty');
  const select = document.getElementById('assignStudent');
  list.innerHTML = '';
  select.innerHTML = '';

  if (!state.students.length) {
    empty.classList.remove('hidden');
    document.getElementById('btnAssign').classList.add('hidden');
    document.getElementById('taskPanelTitle').textContent = 'Select a student';
    document.getElementById('taskPanelSub').textContent = 'Choose a student to review their assignments.';
    document.getElementById('taskTable').innerHTML = '';
    document.getElementById('taskEmpty').classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  for (const student of state.students) {
    const tpl = document.getElementById('studentCardTemplate');
    const card = tpl.content.cloneNode(true);
    card.querySelector('.student-name').textContent = student.username;
    card.querySelector('.student-email').textContent = student.email;
    card.querySelector('.open-count').textContent = `${student.openTasks} open`;
    card.querySelector('.total-count').textContent = `${student.totalTasks} total`;

    const viewBtn = card.querySelector('.view-btn');
    viewBtn.addEventListener('click', () => selectStudent(student.id));

    const assignBtn = card.querySelector('.assign-btn');
    assignBtn.addEventListener('click', () => openAssignModal(student.id));

    list.appendChild(card);

    const opt = document.createElement('option');
    opt.value = String(student.id);
    opt.textContent = `${student.username} (${student.email})`;
    select.appendChild(opt);
  }

  if (!state.selectedId && state.students.length) {
    selectStudent(state.students[0].id);
  } else if (state.selectedId) {
    select.value = String(state.selectedId);
  }
}

function selectStudent(studentId) {
  state.selectedId = studentId;
  const student = state.students.find((s) => s.id === studentId);
  if (!student) return;
  document.getElementById('btnAssign').classList.remove('hidden');
  document.getElementById('taskPanelTitle').textContent = student.username;
  document.getElementById('taskPanelSub').textContent = student.email;
  loadTasks(studentId);
}

async function loadTasks(studentId) {
  try {
    const tasks = await request(`server/tasks.php?userId=${encodeURIComponent(studentId)}`);
    const tbody = document.getElementById('taskTable');
    const empty = document.getElementById('taskEmpty');
    tbody.innerHTML = '';
    if (!tasks.length) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    for (const task of tasks) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="py-2 pr-4">
          <div class="font-semibold">${task.title}</div>
          <div class="text-xs text-slate-500">${task.description || ''}</div>
        </td>
        <td class="py-2 pr-4 text-slate-600">${new Date(task.dueAt).toLocaleString()}</td>
        <td class="py-2 pr-4">${task.priority}</td>
        <td class="py-2">${task.done ? 'Completed' : 'Open'}</td>`;
      tbody.appendChild(tr);
    }
  } catch (error) {
    console.error(error);
    alert('Could not load tasks for student.');
  }
}

function openAssignModal(studentId) {
  const modal = document.getElementById('assignModal');
  const select = document.getElementById('assignStudent');
  if (studentId) {
    select.value = String(studentId);
    state.selectedId = studentId;
  }
  const dueInput = document.querySelector('#assignForm input[name="dueAt"]');
  if (dueInput) {
    const future = new Date();
    future.setHours(future.getHours() + 24);
    dueInput.value = future.toISOString().slice(0, 16);
  }
  document.getElementById('assignMessage').textContent = '';
  if (typeof modal.showModal === 'function') {
    modal.showModal();
  } else {
    modal.classList.remove('hidden');
  }
}

function closeAssignModal() {
  const modal = document.getElementById('assignModal');
  if (typeof modal.close === 'function') {
    modal.close();
  } else {
    modal.classList.add('hidden');
  }
}

async function loadSummary() {
  try {
    const data = await request('server/mentor.php?action=summary');
    updateSummary(data.summary || {});
  } catch (error) {
    console.error(error);
  }
}

async function loadStudents() {
  try {
    const data = await request('server/mentor.php?action=students');
    state.students = (data.students || []).map((s) => ({
      id: Number(s.id),
      username: s.username,
      email: s.email,
      openTasks: Number(s.openTasks ?? 0),
      totalTasks: Number(s.totalTasks ?? 0)
    }));
    renderStudents();
    loadSummary();
  } catch (error) {
    console.error(error);
    alert('Failed to load mentor roster.');
  }
}

async function submitAssignment(event) {
  event.preventDefault();
  const form = event.target;
  const message = document.getElementById('assignMessage');
  message.textContent = '';
  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    await request('server/tasks.php', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    message.textContent = 'Task assigned successfully!';
    message.className = 'text-sm text-emerald-600';
    closeAssignModal();
    await loadStudents();
    if (payload.studentId) {
      selectStudent(Number(payload.studentId));
    }
    form.reset();
  } catch (error) {
    message.textContent = 'Unable to assign task.';
    message.className = 'text-sm text-rose-600';
  }
}

function initEvents() {
  document.getElementById('btnRefresh').addEventListener('click', loadStudents);
  document.getElementById('btnAssign').addEventListener('click', () => openAssignModal(state.selectedId));
  document.getElementById('assignCancel').addEventListener('click', (e) => {
    e.preventDefault();
    closeAssignModal();
  });
  document.getElementById('assignForm').addEventListener('submit', submitAssignment);
  document.getElementById('btnLogout').addEventListener('click', async () => {
    try { await fetch('server/auth.php?action=logout', { credentials: 'same-origin' }); } catch {}
    window.location.href = 'auth.html';
  });
}

async function init() {
  const user = await ensureSession();
  if (!user) return;
  const badge = document.getElementById('mentorName');
  if (badge) {
    badge.textContent = user.username;
    badge.classList.remove('hidden');
  }
  initEvents();
  loadStudents();
}

document.addEventListener('DOMContentLoaded', init);
