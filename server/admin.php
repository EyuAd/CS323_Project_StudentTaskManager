<?php
/**
 * Super admin utilities for managing users, mentor mappings, and activity logs.
 */

date_default_timezone_set('UTC');
require_once __DIR__ . '/db.php';
session_start();

$pdo = db();
ensure_user_columns($pdo);
ensure_activity_table($pdo);
ensure_mentor_students($pdo);

$current = require_active_user();
if (($current['role'] ?? 'student') !== 'admin') {
  json_out(['error' => 'Forbidden'], 403);
}

$action = $_GET['action'] ?? 'users';
$method = $_SERVER['REQUEST_METHOD'];

if ($action === 'users' && $method === 'GET') {
  $sql = "SELECT u.id, u.email, u.username, u.role, u.status, u.created_at, u.last_login,
                 (SELECT COUNT(*) FROM tasks t WHERE t.user_id = u.id) AS task_count,
                 (SELECT COUNT(*) FROM mentor_students ms WHERE ms.mentor_id = u.id) AS mentee_count,
                 (SELECT COUNT(*) FROM mentor_students ms WHERE ms.student_id = u.id) AS mentor_count
          FROM users u
          ORDER BY u.created_at DESC";
  $rows = $pdo->query($sql)->fetchAll();
  $data = array_map(function($row) {
    return [
      'id' => (int)$row['id'],
      'email' => $row['email'],
      'username' => $row['username'],
      'role' => $row['role'],
      'status' => $row['status'],
      'createdAt' => $row['created_at'],
      'lastLogin' => $row['last_login'],
      'taskCount' => (int)$row['task_count'],
      'menteeCount' => (int)$row['mentee_count'],
      'mentorCount' => (int)$row['mentor_count']
    ];
  }, $rows);
  json_out(['users' => $data]);
}

if ($action === 'activity' && $method === 'GET') {
  $limit = isset($_GET['limit']) ? max(1, min(250, (int)$_GET['limit'])) : 100;
  $sql = "SELECT a.id, a.user_id, a.actor_email, a.actor_role, a.action, a.description, a.created_at,
                 u.username AS user_name
          FROM activity_logs a
          LEFT JOIN users u ON u.id = a.user_id
          ORDER BY a.created_at DESC
          LIMIT $limit";
  $rows = $pdo->query($sql)->fetchAll();
  $logs = array_map(function($row) {
    return [
      'id' => (int)$row['id'],
      'userId' => $row['user_id'] !== null ? (int)$row['user_id'] : null,
      'userName' => $row['user_name'],
      'actorEmail' => $row['actor_email'],
      'actorRole' => $row['actor_role'],
      'action' => $row['action'],
      'description' => $row['description'],
      'createdAt' => $row['created_at']
    ];
  }, $rows);
  json_out(['logs' => $logs]);
}

if ($action === 'updateRole' && $method === 'POST') {
  $payload = read_json_body();
  $targetId = (int)($payload['userId'] ?? 0);
  $role = $payload['role'] ?? '';
  if ($targetId <= 0 || !in_array($role, ['student','mentor','admin'], true)) {
    json_out(['error' => 'Invalid payload'], 400);
  }
  if ($targetId === (int)$current['id']) {
    json_out(['error' => 'Cannot change your own role'], 400);
  }
  $target = fetch_user($targetId);
  if (!$target) {
    json_out(['error' => 'User not found'], 404);
  }
  $stmt = $pdo->prepare('UPDATE users SET role = ? WHERE id = ?');
  $stmt->execute([$role, $targetId]);
  log_activity($current, 'role_update', 'Changed role to ' . $role . ' for user #' . $targetId, $targetId);
  json_out(['ok' => true]);
}

if ($action === 'setStatus' && $method === 'POST') {
  $payload = read_json_body();
  $targetId = (int)($payload['userId'] ?? 0);
  $status = $payload['status'] ?? '';
  if ($targetId <= 0 || !in_array($status, ['active','suspended'], true)) {
    json_out(['error' => 'Invalid payload'], 400);
  }
  if ($targetId === (int)$current['id']) {
    json_out(['error' => 'Cannot change your own status'], 400);
  }
  $target = fetch_user($targetId);
  if (!$target) {
    json_out(['error' => 'User not found'], 404);
  }
  $stmt = $pdo->prepare('UPDATE users SET status = ? WHERE id = ?');
  $stmt->execute([$status, $targetId]);
  log_activity($current, 'status_update', 'Set status to ' . $status . ' for user #' . $targetId, $targetId);
  json_out(['ok' => true]);
}

if ($action === 'link' && $method === 'POST') {
  $payload = read_json_body();
  $mentorId = (int)($payload['mentorId'] ?? 0);
  $studentId = (int)($payload['studentId'] ?? 0);
  if ($mentorId <= 0 || $studentId <= 0) {
    json_out(['error' => 'Invalid payload'], 400);
  }
  $mentor = fetch_user($mentorId);
  $student = fetch_user($studentId);
  if (!$mentor || !$student) {
    json_out(['error' => 'User not found'], 404);
  }
  if (($mentor['role'] ?? '') !== 'mentor') {
    json_out(['error' => 'Mentor user must have mentor role'], 400);
  }
  if (($student['role'] ?? '') !== 'student') {
    json_out(['error' => 'Student user must have student role'], 400);
  }
  ensure_mentor_link($pdo, $mentorId, $studentId);
  log_activity($current, 'mentor_link', 'Linked mentor #' . $mentorId . ' with student #' . $studentId, $studentId);
  json_out(['ok' => true]);
}

if ($action === 'unlink' && $method === 'POST') {
  $payload = read_json_body();
  $mentorId = (int)($payload['mentorId'] ?? 0);
  $studentId = (int)($payload['studentId'] ?? 0);
  if ($mentorId <= 0 || $studentId <= 0) {
    json_out(['error' => 'Invalid payload'], 400);
  }
  $stmt = $pdo->prepare('DELETE FROM mentor_students WHERE mentor_id = ? AND student_id = ?');
  $stmt->execute([$mentorId, $studentId]);
  log_activity($current, 'mentor_unlink', 'Unlinked mentor #' . $mentorId . ' from student #' . $studentId, $studentId);
  json_out(['ok' => true]);
}

if ($action === 'mentorMap' && $method === 'GET') {
  $sql = "SELECT ms.mentor_id, ms.student_id, ms.created_at,
                 mentor.username AS mentor_name,
                 student.username AS student_name
          FROM mentor_students ms
          LEFT JOIN users mentor ON mentor.id = ms.mentor_id
          LEFT JOIN users student ON student.id = ms.student_id
          ORDER BY mentor.username, student.username";
  $rows = $pdo->query($sql)->fetchAll();
  $items = array_map(function($row) {
    return [
      'mentorId' => (int)$row['mentor_id'],
      'studentId' => (int)$row['student_id'],
      'mentorName' => $row['mentor_name'],
      'studentName' => $row['student_name'],
      'linkedAt' => $row['created_at']
    ];
  }, $rows);
  json_out(['links' => $items]);
}

json_out(['error' => 'Not found'], 404);
