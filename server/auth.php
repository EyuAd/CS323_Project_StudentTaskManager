<?php
date_default_timezone_set('UTC');
require_once __DIR__ . '/db.php';
session_start();

$pdo = db();
$pdo->exec("CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  username VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;");

function current_user() {
  if (!empty($_SESSION['uid'])) {
    return ['email' => $_SESSION['email'], 'username' => $_SESSION['username']];
  }
  return null;
}

$action = $_GET['action'] ?? '';

if ($action === 'session') {
  $u = current_user();
  if ($u) json_out(['authenticated'=>true, 'user'=>$u]);
  json_out(['authenticated'=>false]);
}

if ($action === 'logout') {
  session_destroy();
  json_out(['ok'=>true]);
}

if ($action === 'register' && $_SERVER['REQUEST_METHOD'] === 'POST') {
  $data = read_json_body();
  $email = strtolower(trim($data['email'] ?? ''));
  $username = trim($data['username'] ?? '');
  $password = $data['password'] ?? '';
  if (!filter_var($email, FILTER_VALIDATE_EMAIL)) json_out(['error'=>'Invalid email'],400);
  if (strlen($username) < 2) json_out(['error'=>'Username too short'],400);
  if (strlen($password) < 6) json_out(['error'=>'Password too short'],400);

  $st = $pdo->prepare("SELECT id FROM users WHERE email = ?");
  $st->execute([$email]);
  if ($st->fetch()) json_out(['error'=>'Email already registered'],409);

  $hash = password_hash($password, PASSWORD_DEFAULT);
  $now = gmdate('Y-m-d H:i:s');
  $st = $pdo->prepare("INSERT INTO users(email, username, password_hash, created_at) VALUES (?,?,?,?)");
  $st->execute([$email, $username, $hash, $now]);

  $_SESSION['uid'] = $pdo->lastInsertId();
  $_SESSION['email'] = $email;
  $_SESSION['username'] = $username;
  json_out(['ok'=>true, 'user'=>current_user()], 201);
}

if ($action === 'login' && $_SERVER['REQUEST_METHOD'] === 'POST') {
  $data = read_json_body();
  $email = strtolower(trim($data['email'] ?? ''));
  $password = $data['password'] ?? '';
  $st = $pdo->prepare("SELECT * FROM users WHERE email = ?");
  $st->execute([$email]);
  $u = $st->fetch();
  if (!$u || !password_verify($password, $u['password_hash'])) {
    json_out(['error'=>'Invalid credentials'],401);
  }
  $_SESSION['uid'] = $u['id'];
  $_SESSION['email'] = $u['email'];
  $_SESSION['username'] = $u['username'];
  json_out(['ok'=>true, 'user'=>current_user()]);
}

json_out(['error'=>'Not found'],404);
