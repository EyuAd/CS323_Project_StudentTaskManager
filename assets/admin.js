const state = {
  users: [],
  links: [],
  logs: [],
  session: null,
  availableStudents: []
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
  if (role === 'mentor') {
    window.location.href = 'mentor.html';
    return null;
  }
  if (role === 'student') {
    window.location.href = 'index.html';
    return null;
  }
  state.session = session.user;
  const badge = document.getElementById('adminName');
  if (badge) {
    badge.textContent = session.user.username;
    badge.classList.remove('hidden');
  }
  return session.user;
}

function showMessage(text, tone = 'muted') {
  const el = document.getElementById('adminMessage');
  if (!el) return;
  el.textContent = text;
  el.className = `text-sm ${tone === 'error' ? 'text-rose-600' : 'text-slate-500'}`;
  if (text) {
    setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 4000);
  }
}

function computeStats() {
  const totalUsers = state.users.length;
  const mentors = state.users.filter((u) => u.role === 'mentor').length;
  const students = state.users.filter((u) => u.role === 'student').length;
  const tasks = state.users.reduce((sum, u) => sum + (u.taskCount || 0), 0);
  document.getElementById('statUsers').textContent = totalUsers;
  document.getElementById('statMentors').textContent = mentors;
  document.getElementById('statStudents').textContent = students;
  document.getElementById('statTasks').textContent = tasks;
}

function renderUsers() {
  const tbody = document.getElementById('userTable');
  tbody.innerHTML = '';
  const tpl = document.getElementById('userRowTemplate');
  for (const user of state.users) {
    const row = tpl.content.cloneNode(true);
    row.querySelector('.user-name').textContent = user.username;
    row.querySelector('.user-email').textContent = user.email;
    row.querySelector('.task-count').textContent = `${user.taskCount || 0}`;
    row.querySelector('.mentee-count').textContent = `${user.menteeCount || 0}`;
    const roleSelect = row.querySelector('.role-select');
    const statusSelect = row.querySelector('.status-select');
    roleSelect.value = user.role;
    statusSelect.value = user.status;

    row.querySelector('.btn-role').addEventListener('click', async () => {
      try {
        await request('server/admin.php?action=updateRole', {
          method: 'POST',
          body: JSON.stringify({ userId: user.id, role: roleSelect.value })
        });
        showMessage('Role updated');
        await loadUsers();
      } catch (error) {
        showMessage('Could not update role', 'error');
      }
    });

    row.querySelector('.btn-status').addEventListener('click', async () => {
      try {
        await request('server/admin.php?action=setStatus', {
          method: 'POST',
          body: JSON.stringify({ userId: user.id, status: statusSelect.value })
        });
        showMessage('Status updated');
        await loadUsers();
      } catch (error) {
        showMessage('Could not update status', 'error');
      }
    });

    tbody.appendChild(row);
  }
}

async function loadUsers() {
  try {
    const data = await request('server/admin.php?action=users');
    state.users = (data.users || []).map((u) => ({
      id: Number(u.id),
      email: u.email,
      username: u.username,
      role: u.role,
      status: u.status,
      taskCount: Number(u.taskCount || 0),
      menteeCount: Number(u.menteeCount || 0)
    }));
    renderUsers();
    computeStats();
    populateLinkSelectors();
  } catch (error) {
    console.error(error);
    showMessage('Failed to load users', 'error');
  }
}

async function loadLinks() {
  try {
    const data = await request('server/admin.php?action=mentorMap');
    state.links = data.links || [];
    renderLinks();
  } catch (error) {
    console.error(error);
  }
}

async function loadAvailableStudents() {
  try {
    const data = await request('server/mentor.php?action=availableStudents');
    state.availableStudents = data.students || [];
    populateLinkSelectors();
  } catch (error) {
    console.error(error);
  }
}

function populateLinkSelectors() {
  const mentorSelect = document.getElementById('linkMentor');
  const studentSelect = document.getElementById('linkStudent');
  mentorSelect.innerHTML = '';
  studentSelect.innerHTML = '';

  for (const mentor of state.users.filter((u) => u.role === 'mentor')) {
    const opt = document.createElement('option');
    opt.value = String(mentor.id);
    opt.textContent = `${mentor.username} (${mentor.email})`;
    mentorSelect.appendChild(opt);
  }
  for (const student of state.availableStudents) {
    const opt = document.createElement('option');
    opt.value = String(student.id);
    opt.textContent = `${student.username} (${student.email})`;
    studentSelect.appendChild(opt);
  }
}

function renderLinks() {
  const tbody = document.getElementById('linkTable');
  tbody.innerHTML = '';
  for (const link of state.links) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="py-2 pr-4">${link.mentorName || link.mentorId}</td>
      <td class="py-2 pr-4">${link.studentName || link.studentId}</td>
      <td class="py-2 pr-4 text-slate-500">${link.linkedAt || ''}</td>
      <td class="py-2">
        <button class="btn btn-secondary">Unlink</button>
      </td>`;
    tr.querySelector('button').addEventListener('click', async () => {
      try {
        await request('server/admin.php?action=unlink', {
          method: 'POST',
          body: JSON.stringify({ mentorId: link.mentorId, studentId: link.studentId })
        });
        showMessage('Mentor unlinked');
        await Promise.all([loadLinks(), loadUsers(), loadAvailableStudents()]);
      } catch (error) {
        showMessage('Could not unlink mentor', 'error');
      }
    });
    tbody.appendChild(tr);
  }
}

async function linkMentorStudent() {
  const mentorId = Number(document.getElementById('linkMentor').value);
  const studentId = Number(document.getElementById('linkStudent').value);
  if (!mentorId || !studentId) {
    showMessage('Select a mentor and student', 'error');
    return;
  }
  try {
    await request('server/admin.php?action=link', {
      method: 'POST',
      body: JSON.stringify({ mentorId, studentId })
    });
    showMessage('Mentor linked');
    await Promise.all([loadLinks(), loadUsers(), loadAvailableStudents()]);
  } catch (error) {
    showMessage('Could not link mentor', 'error');
  }
}

async function loadLogs() {
  try {
    const data = await request('server/admin.php?action=activity&limit=100');
    state.logs = data.logs || [];
    renderLogs();
  } catch (error) {
    console.error(error);
  }
}

function renderLogs() {
  const tbody = document.getElementById('logTable');
  tbody.innerHTML = '';
  for (const log of state.logs) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="py-2 pr-4 text-slate-500">${new Date(log.createdAt || '').toLocaleString()}</td>
      <td class="py-2 pr-4">${log.actorEmail || ''} (${log.actorRole})</td>
      <td class="py-2 pr-4">${log.action}</td>
      <td class="py-2 text-slate-600">${log.description || ''}</td>`;
    tbody.appendChild(tr);
  }
}

function initEvents() {
  document.getElementById('btnRefresh').addEventListener('click', () => {
    loadUsers();
    loadLinks();
    loadAvailableStudents();
  });
  document.getElementById('btnLogs').addEventListener('click', loadLogs);
  document.getElementById('btnLink').addEventListener('click', linkMentorStudent);
  document.getElementById('btnLogout').addEventListener('click', async () => {
    try { await fetch('server/auth.php?action=logout', { credentials: 'same-origin' }); } catch {}
    window.location.href = 'auth.html';
  });
}

async function init() {
  const user = await ensureSession();
  if (!user) return;
  initEvents();
  await Promise.all([loadUsers(), loadLinks(), loadAvailableStudents(), loadLogs()]);
}

document.addEventListener('DOMContentLoaded', init);
