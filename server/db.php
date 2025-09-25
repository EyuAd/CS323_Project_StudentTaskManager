<?php
require_once __DIR__ . '/config.php';

function db() {
  static $pdo = null;
  if ($pdo) return $pdo;
  $dsn = 'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=' . DB_CHARSET;
  $opts = [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
  ];
  $pdo = new PDO($dsn, DB_USER, DB_PASS, $opts);
  return $pdo;
}

function json_out($data, int $code = 200) {
  http_response_code($code);
  header('Content-Type: application/json');
  echo json_encode($data);
  exit;
}

function read_json_body() {
  $raw = file_get_contents('php://input');
  $data = json_decode($raw, true);
  if ($raw && $data === null) json_out(['error' => 'Invalid JSON'], 400);
  return $data ?: [];
}
