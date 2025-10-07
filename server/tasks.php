<?php
/**
 * Task CRUD and import/export endpoints gated by the PHP session.
 */

date_default_timezone_set('UTC');
require_once __DIR__ . '/db.php';
session_start();

if (isset($_GET['ping'])) {
  json_out(['ok' => true]);
}

$pdo = db();
ensure_user_columns($pdo);
ensure_task_columns($pdo);
ensure_activity_table($pdo);
ensure_mentor_students($pdo);

$user = require_active_user();
$role = $user['role'];
$userId = (int)$user['id'];

function task_row_to_response(array $row): array {
  return [
    'id' => $row['uid'],
    'title' => $row['title'],
    'description' => $row['description'],
    'category' => $row['category'],
    'priority' => $row['priority'],
    'dueAt' => gmdate('c', strtotime($row['due_at'])),
    'done' => (bool)$row['done'],
    'notify' => (bool)$row['notify'],
    'createdAt' => gmdate('c', strtotime($row['created_at'])),
    'updatedAt' => gmdate('c', strtotime($row['updated_at'])),
    'ownerId' => $row['user_id'] !== null ? (int)$row['user_id'] : null,
    'assignedById' => $row['assigned_by'] !== null ? (int)$row['assigned_by'] : null,
    'owner' => $row['owner_name'] ? [
      'id' => $row['user_id'] !== null ? (int)$row['user_id'] : null,
      'username' => $row['owner_name'],
      'email' => $row['owner_email']
    ] : null,
    'assignedBy' => $row['assigner_name'] ? [
      'id' => $row['assigned_by'] !== null ? (int)$row['assigned_by'] : null,
      'username' => $row['assigner_name'],
      'email' => $row['assigner_email']
    ] : null
  ];
}

function task_select_base(): string {
  return 'SELECT t.*, owner.username AS owner_name, owner.email AS owner_email, ' .
         'assigner.username AS assigner_name, assigner.email AS assigner_email ' .
         'FROM tasks t ' .
         'LEFT JOIN users owner ON owner.id = t.user_id ' .
         'LEFT JOIN users assigner ON assigner.id = t.assigned_by';
}

function guard_student_access(PDO $pdo, array $actor, int $studentId, bool $autoLink = false): void {
  if ($actor['role'] === 'student') {
    if ($studentId !== (int)$actor['id']) {
      json_out(['error' => 'Unauthorized'], 403);
    }
    return;
  }
  if ($actor['role'] === 'mentor') {
    if (mentor_has_student($pdo, (int)$actor['id'], $studentId)) {
      return;
    }
    if ($autoLink) {
      $student = fetch_user($studentId);
      if (!$student) {
        json_out(['error' => 'Student not found'], 404);
      }
      if (($student['role'] ?? 'student') !== 'student') {
        json_out(['error' => 'Target user is not a student'], 400);
      }
      ensure_mentor_link($pdo, (int)$actor['id'], $studentId);
      return;
    }
    json_out(['error' => 'Student is not linked to mentor'], 403);
  }
}

function fetch_task(PDO $pdo, array $actor, string $uid): array {
  $sql = task_select_base() . ' WHERE t.uid = ? LIMIT 1';
  $stmt = $pdo->prepare($sql);
  $stmt->execute([$uid]);
  $row = $stmt->fetch();
  if (!$row) {
    json_out(['error' => 'Not found'], 404);
  }
  $ownerId = $row['user_id'] !== null ? (int)$row['user_id'] : 0;
  $assignerId = $row['assigned_by'] !== null ? (int)$row['assigned_by'] : 0;
  $actorId = (int)$actor['id'];
  $role = $actor['role'];
  if ($role === 'student' && $ownerId !== $actorId) {
    json_out(['error' => 'Unauthorized'], 403);
  }
  if ($role === 'mentor') {
    if ($assignerId === $actorId || $ownerId === $actorId) {
      return $row;
    }
    if (!mentor_has_student($pdo, $actorId, $ownerId)) {
      json_out(['error' => 'Unauthorized'], 403);
    }
  }
  return $row;
}

function list_tasks(PDO $pdo, array $actor, array $query): array {
  $role = $actor['role'];
  $actorId = (int)$actor['id'];
  $base = task_select_base();
  $sql = $base;
  $params = [];
  if ($role === 'student') {
    $sql .= ' WHERE t.user_id = ? ORDER BY t.due_at ASC';
    $params[] = $actorId;
  } elseif ($role === 'mentor') {
    if (!empty($query['studentId']) || !empty($query['userId'])) {
      $studentId = (int)($query['studentId'] ?? $query['userId']);
      if ($studentId <= 0) {
        json_out(['error' => 'studentId is required'], 400);
      }
      guard_student_access($pdo, $actor, $studentId);
      $sql .= ' WHERE t.user_id = ? ORDER BY t.due_at ASC';
      $params[] = $studentId;
    } else {
      $sql .= ' WHERE t.assigned_by = ? ORDER BY t.due_at ASC';
      $params[] = $actorId;
    }
  } else { // admin
    if (!empty($query['studentId']) || !empty($query['userId'])) {
      $targetId = (int)($query['studentId'] ?? $query['userId']);
      if ($targetId > 0) {
        $sql .= ' WHERE t.user_id = ? ORDER BY t.due_at ASC';
        $params[] = $targetId;
      } else {
        $sql .= ' ORDER BY t.due_at ASC';
      }
    } else {
      $sql .= ' ORDER BY t.due_at ASC';
    }
  }
  $stmt = $pdo->prepare($sql);
  $stmt->execute($params);
  return array_map('task_row_to_response', $stmt->fetchAll());
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET' && isset($_GET['export'])) {
  $tasks = list_tasks($pdo, $user, $_GET);
  json_out($tasks);
}

if ($method === 'GET') {
  if (isset($_GET['id'])) {
    $row = fetch_task($pdo, $user, $_GET['id']);
    json_out(task_row_to_response($row));
  }
  $tasks = list_tasks($pdo, $user, $_GET);
  json_out($tasks);
}

if ($method === 'POST' && isset($_GET['import'])) {
  if ($role !== 'student') {
    json_out(['error' => 'Only students can import their task list'], 403);
  }
  $json = read_json_body();
  if (!is_array($json)) {
    json_out(['error' => 'Invalid payload'], 400);
  }
  $pdo->beginTransaction();
  try {
    $del = $pdo->prepare('DELETE FROM tasks WHERE user_id = ?');
    $del->execute([$userId]);
    $ins = $pdo->prepare('INSERT INTO tasks (user_id, assigned_by, uid, title, description, category, priority, due_at, done, notify, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    foreach ($json as $task) {
      $uid = $task['id'] ?? bin2hex(random_bytes(12));
      $now = gmdate('Y-m-d H:i:s');
      $ins->execute([
        $userId,
        null,
        $uid,
        $task['title'] ?? '',
        $task['description'] ?? null,
        $task['category'] ?? null,
        in_array($task['priority'] ?? 'medium', ['low','medium','high'], true) ? $task['priority'] : 'medium',
        gmdate('Y-m-d H:i:s', strtotime($task['dueAt'] ?? $now)),
        !empty($task['done']) ? 1 : 0,
        !empty($task['notify']) ? 1 : 0,
        $task['createdAt'] ? gmdate('Y-m-d H:i:s', strtotime($task['createdAt'])) : $now,
        $task['updatedAt'] ? gmdate('Y-m-d H:i:s', strtotime($task['updatedAt'])) : $now
      ]);
    }
    $pdo->commit();
    log_activity($user, 'task_import', 'Imported a full task list.', $userId);
  } catch (Throwable $e) {
    $pdo->rollBack();
    json_out(['error' => $e->getMessage()], 500);
  }
  json_out(['ok' => true]);
}

if ($method === 'POST') {
  $payload = read_json_body();
  $title = trim($payload['title'] ?? '');
  if ($title === '') {
    json_out(['error' => 'Title is required'], 400);
  }
  $now = gmdate('Y-m-d H:i:s');
  $uid = bin2hex(random_bytes(12));
  $targetUserId = $userId;
  $assignedById = $role === 'student' ? null : $userId;
  if ($role === 'mentor') {
    $studentId = (int)($payload['studentId'] ?? $payload['userId'] ?? 0);
    if ($studentId <= 0) {
      json_out(['error' => 'studentId is required for mentors'], 400);
    }
    guard_student_access($pdo, $user, $studentId, true);
    $targetUserId = $studentId;
    $assignedById = $userId;
  } elseif ($role === 'admin') {
    $targetUserId = (int)($payload['studentId'] ?? $payload['userId'] ?? 0);
    if ($targetUserId <= 0) {
      json_out(['error' => 'userId is required for admins'], 400);
    }
    $targetUser = fetch_user($targetUserId);
    if (!$targetUser) {
      json_out(['error' => 'Target user not found'], 404);
    }
    $assignedById = $userId;
  }
  $stmt = $pdo->prepare('INSERT INTO tasks (user_id, assigned_by, uid, title, description, category, priority, due_at, done, notify, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  $stmt->execute([
    $targetUserId,
    $assignedById,
    $uid,
    $title,
    $payload['description'] ?? null,
    $payload['category'] ?? null,
    in_array($payload['priority'] ?? 'medium', ['low','medium','high'], true) ? $payload['priority'] : 'medium',
    gmdate('Y-m-d H:i:s', strtotime($payload['dueAt'] ?? $now)),
    !empty($payload['done']) ? 1 : 0,
    !empty($payload['notify']) ? 1 : 0,
    $now,
    $now
  ]);
  $row = fetch_task($pdo, $user, $uid);
  log_activity($user, 'task_create', 'Created task "' . $title . '"', $row['user_id'] !== null ? (int)$row['user_id'] : null);
  json_out(task_row_to_response($row), 201);
}

if ($method === 'PATCH' || $method === 'PUT') {
  if (empty($_GET['id'])) {
    json_out(['error' => 'id is required'], 400);
  }
  $row = fetch_task($pdo, $user, $_GET['id']);
  $payload = read_json_body();
  $fields = [];
  $values = [];
  $map = [
    'title' => 'title',
    'description' => 'description',
    'category' => 'category',
    'priority' => 'priority',
    'done' => 'done',
    'notify' => 'notify',
    'dueAt' => 'due_at'
  ];
  foreach ($map as $key => $column) {
    if (!array_key_exists($key, $payload)) {
      continue;
    }
    if ($key === 'priority') {
      if (!in_array($payload[$key], ['low','medium','high'], true)) {
        continue;
      }
      $fields[] = "$column = ?";
      $values[] = $payload[$key];
      continue;
    }
    if ($key === 'done' || $key === 'notify') {
      $fields[] = "$column = ?";
      $values[] = $payload[$key] ? 1 : 0;
      continue;
    }
    if ($key === 'dueAt') {
      $fields[] = "$column = ?";
      $values[] = gmdate('Y-m-d H:i:s', strtotime($payload[$key]));
      continue;
    }
    $fields[] = "$column = ?";
    $values[] = $payload[$key];
  }
  if (!$fields) {
    json_out(['error' => 'Nothing to update'], 400);
  }
  $fields[] = 'updated_at = ?';
  $values[] = gmdate('Y-m-d H:i:s');
  $values[] = $_GET['id'];
  $stmt = $pdo->prepare('UPDATE tasks SET ' . implode(',', $fields) . ' WHERE uid = ?');
  $stmt->execute($values);
  $updated = fetch_task($pdo, $user, $_GET['id']);
  log_activity($user, 'task_update', 'Updated task "' . $updated['title'] . '"', $updated['user_id'] !== null ? (int)$updated['user_id'] : null);
  json_out(task_row_to_response($updated));
}

if ($method === 'DELETE') {
  if (empty($_GET['id'])) {
    json_out(['error' => 'id is required'], 400);
  }
  $row = fetch_task($pdo, $user, $_GET['id']);
  $stmt = $pdo->prepare('DELETE FROM tasks WHERE uid = ?');
  $stmt->execute([$_GET['id']]);
  log_activity($user, 'task_delete', 'Deleted task "' . $row['title'] . '"', $row['user_id'] !== null ? (int)$row['user_id'] : null);
  json_out(['ok' => true]);
}

json_out(['error' => 'Method not allowed'], 405);


