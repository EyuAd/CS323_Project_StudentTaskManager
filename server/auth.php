<?php
/**
 * Authentication endpoints for login, registration, session status, and logout.
 */

date_default_timezone_set('UTC');
require_once __DIR__ . '/db.php';
session_start();

$pdo = db();
ensure_user_columns($pdo);
ensure_activity_table($pdo);
ensure_task_columns($pdo);
ensure_mentor_students($pdo);

// Seed a default super admin if none exists so the dashboard is always accessible.
function ensure_super_admin(PDO $pdo): void {
  $count = (int)$pdo->query("SELECT COUNT(*) FROM users WHERE role = 'admin'")->fetchColumn();
  if ($count > 0) {
    return;
  }
  $email = getenv('STM_ADMIN_EMAIL') ?: 'admin@gmail.com';
  $username = 'Super Admin';
  $password = getenv('STM_ADMIN_PASS') ?: 'password123';
  $existing = $pdo->prepare('SELECT id, role FROM users WHERE email = ? LIMIT 1');
  $existing->execute([$email]);
  $found = $existing->fetch();
  if ($found) {
    $pdo->prepare('UPDATE users SET role = ?, status = ? WHERE id = ?')->execute(['admin', 'active', $found['id']]);
    return;
  }
  $hash = password_hash($password, PASSWORD_DEFAULT);
  $now = gmdate('Y-m-d H:i:s');
  $stmt = $pdo->prepare("INSERT INTO users (email, username, password_hash, role, status, created_at) VALUES (?,?,?,?,?,?)");
  $stmt->execute([$email, $username, $hash, 'admin', 'active', $now]);
}
ensure_super_admin($pdo);

// Synchronize the session payload with the latest database record.
function load_session_user(PDO $pdo): ?array {
  if (empty($_SESSION['uid'])) {
    return null;
  }
  $user = fetch_user((int)$_SESSION['uid']);
  if (!$user) {
    return null;
  }
  $_SESSION['uid'] = $user['id'];
  $_SESSION['email'] = $user['email'];
  $_SESSION['username'] = $user['username'];
  $_SESSION['role'] = $user['role'];
  return $user;
}

function session_payload(?array $user): array {
  if (!$user) {
    return ['authenticated' => false];
  }
  return [
    'authenticated' => true,
    'user' => [
      'id' => (int)$user['id'],
      'email' => $user['email'],
      'username' => $user['username'],
      'role' => $user['role'],
      'status' => $user['status'] ?? 'active'
    ]
  ];
}

function set_session_user(array $user): void {
  $_SESSION['uid'] = $user['id'];
  $_SESSION['email'] = $user['email'];
  $_SESSION['username'] = $user['username'];
  $_SESSION['role'] = $user['role'];
}

function ensure_active(array $user): void {
  if (($user['status'] ?? 'active') !== 'active') {
    json_out(['error' => 'Account suspended'], 403);
  }
}

$action = $_GET['action'] ?? '';

if ($action === 'session') {
  $user = load_session_user($pdo);
  json_out(session_payload($user));
}

if ($action === 'logout') {
  $user = load_session_user($pdo);
  if ($user) {
    log_activity($user, 'logout', 'User signed out.');
  }
  session_destroy();
  json_out(['ok' => true]);
}

if ($action === 'register' && $_SERVER['REQUEST_METHOD'] === 'POST') {
  $data = read_json_body();
  $email = strtolower(trim($data['email'] ?? ''));
  $username = trim($data['username'] ?? '');
  $password = $data['password'] ?? '';
  if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    json_out(['error' => 'Invalid email'], 400);
  }
  if (strlen($username) < 2) {
    json_out(['error' => 'Username too short'], 400);
  }
  if (strlen($password) < 6) {
    json_out(['error' => 'Password too short'], 400);
  }

  $st = $pdo->prepare("SELECT id FROM users WHERE email = ?");
  $st->execute([$email]);
  if ($st->fetch()) {
    json_out(['error' => 'Email already registered'], 409);
  }

  $hash = password_hash($password, PASSWORD_DEFAULT);
  $now = gmdate('Y-m-d H:i:s');
  $role = 'student';
  $stmt = $pdo->prepare("INSERT INTO users (email, username, password_hash, role, status, created_at) VALUES (?,?,?,?,?,?)");
  $stmt->execute([$email, $username, $hash, $role, 'active', $now]);
  $user = fetch_user((int)$pdo->lastInsertId());
  set_session_user($user);
  log_activity($user, 'register', 'New account registered.');
  json_out(['ok' => true, 'user' => session_payload($user)['user']], 201);
}

if ($action === 'login' && $_SERVER['REQUEST_METHOD'] === 'POST') {
  $data = read_json_body();
  $email = strtolower(trim($data['email'] ?? ''));
  $password = $data['password'] ?? '';
  $st = $pdo->prepare("SELECT * FROM users WHERE email = ? LIMIT 1");
  $st->execute([$email]);
  $u = $st->fetch();
  if (!$u || !password_verify($password, $u['password_hash'])) {
    json_out(['error' => 'Invalid credentials'], 401);
  }
  ensure_active($u);
  $now = gmdate('Y-m-d H:i:s');
  $pdo->prepare("UPDATE users SET last_login = ? WHERE id = ?")->execute([$now, $u['id']]);
  set_session_user($u);
  log_activity($u, 'login', 'User signed in.');
  json_out(['ok' => true, 'user' => session_payload($u)['user']]);
}

json_out(['error' => 'Not found'], 404);

