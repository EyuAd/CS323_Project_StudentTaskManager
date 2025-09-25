// assets/auth.js – handles login/register with relative server paths
async function j(res){ 
  if(!res.ok){ 
    const t=await res.text(); 
    throw new Error(t||('HTTP '+res.status)); 
  } 
  return res.json(); 
}

function show(view){
  const login = document.getElementById('formLogin');
  const reg = document.getElementById('formRegister');
  const tabLogin = document.getElementById('tabLogin');
  const tabRegister = document.getElementById('tabRegister');
  login.style.display = view==='login'?'block':'none';
  reg.style.display = view==='register'?'block':'none';
  tabLogin.classList.toggle('active', view==='login');
  tabRegister.classList.toggle('active', view==='register');
  document.getElementById('msgError').style.display='none';
  document.getElementById('msgSuccess').style.display='none';
}

async function trySession(){
  try{
    const r = await j(await fetch('server/auth.php?action=session', {credentials:'same-origin'}));
    if (r.authenticated) window.location.href = 'index.html';
  }catch{}
}
trySession();

document.getElementById('tabLogin').addEventListener('click',()=>show('login'));
document.getElementById('tabRegister').addEventListener('click',()=>show('register'));

document.getElementById('formLogin').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = Object.fromEntries(fd.entries());
  try{
    await j(await fetch('server/auth.php?action=login', {
      method:'POST', 
      headers:{'Content-Type':'application/json'}, 
      body: JSON.stringify(payload), 
      credentials:'same-origin'
    }));
    window.location.href = 'index.html';
  }catch(err){
    const msg = document.getElementById('msgError');
    msg.textContent = 'Invalid email or password';
    msg.style.display = 'block';
  }
});

document.getElementById('formRegister').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = Object.fromEntries(fd.entries());
  try{
    await j(await fetch('server/auth.php?action=register', {
      method:'POST', 
      headers:{'Content-Type':'application/json'}, 
      body: JSON.stringify(payload), 
      credentials:'same-origin'
    }));
    const ok = document.getElementById('msgSuccess');
    ok.textContent = 'Account created! Redirecting…';
    ok.style.display = 'block';
    setTimeout(()=>window.location.href='index.html', 600);
  }catch(err){
    const msg = document.getElementById('msgError');
    msg.textContent = 'Could not register (maybe email already used)';
    msg.style.display = 'block';
  }
});
