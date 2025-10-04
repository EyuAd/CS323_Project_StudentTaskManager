<?php
date_default_timezone_set('UTC');
require_once __DIR__ . '/db.php';
session_start();


if (isset($_GET['ping'])) { json_out(['ok' => true]); }

$pdo = db();

// require auth 
if (!isset($_SESSION['uid'])) { json_out(['error'=>'Unauthorized'], 401); }
$userId = intval($_SESSION['uid']);


function ensure_schema(PDO $pdo) {
  // create table if not exists 
  $pdo->exec("CREATE TABLE IF NOT EXISTS tasks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    uid VARCHAR(64) NOT NULL UNIQUE,
    title VARCHAR(255) NOT NULL,
    description TEXT NULL,
    category VARCHAR(100) NULL,
    priority ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
    due_at DATETIME NOT NULL,
    done TINYINT(1) NOT NULL DEFAULT 0,
    notify TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;");

  // add user_id column if missing
  $cols = $pdo->query("SHOW COLUMNS FROM tasks")->fetchAll(PDO::FETCH_COLUMN, 0);
  if (!in_array('user_id', $cols, true)) {
    $pdo->exec("ALTER TABLE tasks ADD COLUMN user_id INT NULL AFTER id, ADD INDEX (user_id)");
   
  }
}
ensure_schema($pdo);

function row_to_task($r){
  return [
    'id' => $r['uid'],
    'title' => $r['title'],
    'description' => $r['description'],
    'category' => $r['category'],
    'priority' => $r['priority'],
    'dueAt' => gmdate('c', strtotime($r['due_at'])),
    'done' => (bool)$r['done'],
    'notify' => (bool)$r['notify'],
    'createdAt' => gmdate('c', strtotime($r['created_at'])),
    'updatedAt' => gmdate('c', strtotime($r['updated_at']))
  ];
}

$method = $_SERVER['REQUEST_METHOD'];

// Export (current user's tasks only)
if ($method === 'GET' && isset($_GET['export'])) {
  $st = $pdo->prepare("SELECT * FROM tasks WHERE user_id = ? ORDER BY due_at ASC");
  $st->execute([$userId]);
  json_out(array_map('row_to_task', $st->fetchAll()));
}

// List or get by id 
if ($method === 'GET') {
  if (isset($_GET['id'])) {
    $st = $pdo->prepare("SELECT * FROM tasks WHERE uid = ? AND user_id = ?");
    $st->execute([$_GET['id'], $userId]);
    $r = $st->fetch();
    if (!$r) json_out(['error'=>'Not found'],404);
    json_out(row_to_task($r));
  } else {
    $st = $pdo->prepare("SELECT * FROM tasks WHERE user_id = ? ORDER BY due_at ASC");
    $st->execute([$userId]);
    json_out(array_map('row_to_task', $st->fetchAll()));
  }
}

// Import/replace (for current user only)
if ($method === 'POST' && isset($_GET['import'])) {
  $json = read_json_body();
  if (!is_array($json)) json_out(['error' => 'Invalid payload'], 400);
  $pdo->beginTransaction();
  try {
    $del = $pdo->prepare("DELETE FROM tasks WHERE user_id = ?");
    $del->execute([$userId]);

    $ins = $pdo->prepare("INSERT INTO tasks(user_id,uid,title,description,category,priority,due_at,done,notify,created_at,updated_at)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    foreach ($json as $t) {
      $uid = $t['id'] ?? bin2hex(random_bytes(12));
      $now = gmdate('Y-m-d H:i:s');
      $ins->execute([
        $userId,
        $uid,
        $t['title'] ?? '',
        $t['description'] ?? null,
        $t['category'] ?? null,
        in_array($t['priority']??'medium',['low','medium','high']) ? $t['priority'] : 'medium',
        gmdate('Y-m-d H:i:s', strtotime($t['dueAt'] ?? $now)),
        !empty($t['done']) ? 1 : 0,
        !empty($t['notify']) ? 1 : 0,
        $t['createdAt'] ? gmdate('Y-m-d H:i:s', strtotime($t['createdAt'])) : $now,
        $t['updatedAt'] ? gmdate('Y-m-d H:i:s', strtotime($t['updatedAt'])) : $now
      ]);
    }
    $pdo->commit();
  } catch (Throwable $e) { $pdo->rollBack(); json_out(['error'=>$e->getMessage()],500); }
  json_out(['ok'=>true]);
}

// Create 
if ($method === 'POST') {
  $in = read_json_body();
  $uid = bin2hex(random_bytes(12));
  $now = gmdate('Y-m-d H:i:s');
  $title = trim($in['title'] ?? '');
  if ($title === '') json_out(['error' => 'Title is required'], 400);
  $st = $pdo->prepare("INSERT INTO tasks(user_id,uid,title,description,category,priority,due_at,done,notify,created_at,updated_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  $st->execute([
    $userId,
    $uid,
    $title,
    $in['description'] ?? null,
    $in['category'] ?? null,
    in_array($in['priority']??'medium',['low','medium','high']) ? $in['priority'] : 'medium',
    gmdate('Y-m-d H:i:s', strtotime($in['dueAt'] ?? $now)),
    !empty($in['done']) ? 1 : 0,
    !empty($in['notify']) ? 1 : 0,
    $now, $now
  ]);
  $st = $pdo->prepare("SELECT * FROM tasks WHERE uid = ? AND user_id = ?");
  $st->execute([$uid, $userId]);
  json_out(row_to_task($st->fetch()), 201);
}

// Update 
if ($method === 'PATCH' || $method === 'PUT') {
  if (empty($_GET['id'])) json_out(['error'=>'id is required'],400);
  $id = $_GET['id'];
  $in = read_json_body();
  $fields = [];
  $vals = [];
  $map = [
    'title' => 'title',
    'description' => 'description',
    'category' => 'category',
    'priority' => 'priority',
    'done' => 'done',
    'notify' => 'notify',
    'dueAt' => 'due_at'
  ];
  foreach ($map as $k=>$col) {
    if (array_key_exists($k, $in)) {
      if ($k === 'priority' && !in_array($in[$k], ['low','medium','high'])) continue;
      if ($k === 'dueAt') { $fields[] = "$col = ?"; $vals[] = gmdate('Y-m-d H:i:s', strtotime($in[$k])); }
      else if (in_array($k, ['done','notify'])) { $fields[] = "$col = ?"; $vals[] = $in[$k] ? 1 : 0; }
      else { $fields[] = "$col = ?"; $vals[] = $in[$k]; }
    }
  }
  $fields[] = "updated_at = ?"; $vals[] = gmdate('Y-m-d H:i:s');
  if (!$fields) json_out(['error'=>'Nothing to update'],400);
  $sql = "UPDATE tasks SET ".implode(',', $fields)." WHERE uid = ? AND user_id = ?";
  $vals[] = $id; $vals[] = $userId;
  $st = $pdo->prepare($sql);
  $st->execute($vals);

  $st = $pdo->prepare("SELECT * FROM tasks WHERE uid = ? AND user_id = ?");
  $st->execute([$id, $userId]);
  $r = $st->fetch();
  if (!$r) json_out(['error'=>'Not found'],404);
  json_out(row_to_task($r));
}

// Delete 
if ($method === 'DELETE') {
  if (empty($_GET['id'])) json_out(['error'=>'id is required'],400);
  $st = $pdo->prepare("DELETE FROM tasks WHERE uid = ? AND user_id = ?");
  $st->execute([$_GET['id'], $userId]);
  json_out(['ok'=>true]);
}

json_out(['error'=>'Method not allowed'], 405);
