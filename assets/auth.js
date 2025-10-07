
 // Authentication page logic: toggles login/register views and calls the PHP endpoints.
  //All requests include same-origin credentials so existing sessions are reused.
 
const ROLE_ROUTES = {
  student: 'index.html',
  mentor: 'mentor.html',
  admin: 'admin.html'
};

function redirectForRole(role) {
  const target = ROLE_ROUTES[role] || ROLE_ROUTES.student;
  window.location.href = target;
}

async function j(res) {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || ('HTTP ' + res.status));
  }
  return res.json();
}

// Show the requested form and keep the tab styles in sync.
function show(view) {
  const login = document.getElementById('formLogin');
  const register = document.getElementById('formRegister');
  const tabLogin = document.getElementById('tabLogin');
  const tabRegister = document.getElementById('tabRegister');

  login.style.display = view === 'login' ? 'block' : 'none';
  register.style.display = view === 'register' ? 'block' : 'none';
  tabLogin.classList.toggle('active', view === 'login');
  tabRegister.classList.toggle('active', view === 'register');
  document.getElementById('msgError').style.display = 'none';
  document.getElementById('msgSuccess').style.display = 'none';
}


async function trySession() {
  try {
    const session = await j(await fetch('server/auth.php?action=session', { credentials: 'same-origin' }));
    if (session.authenticated && session.user) {
      redirectForRole(session.user.role);
    }
  } catch {}
}
trySession();

document.getElementById('tabLogin').addEventListener('click', () => show('login'));
document.getElementById('tabRegister').addEventListener('click', () => show('register'));

document.getElementById('formLogin').addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.target).entries());
  try {
    const response = await j(await fetch('server/auth.php?action=login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'same-origin'
    }));
    redirectForRole(response.user?.role);
  } catch (error) {
    const message = document.getElementById('msgError');
    message.textContent = 'Invalid email or password';
    message.style.display = 'block';
  }
});

document.getElementById('formRegister').addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.target).entries());
  try {
    const response = await j(await fetch('server/auth.php?action=register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'same-origin'
    }));
    const ok = document.getElementById('msgSuccess');
    ok.textContent = 'Account created! Redirecting...';
    ok.style.display = 'block';
    setTimeout(() => redirectForRole(response.user?.role), 600);
  } catch (error) {
    const message = document.getElementById('msgError');
    message.textContent = 'Could not register (maybe email already used)';
    message.style.display = 'block';
  }
});
