<?php
/**
 * Mentor-facing utilities for student rosters and aggregated task metrics.
 */

date_default_timezone_set('UTC');
require_once __DIR__ . '/db.php';
session_start();

$pdo = db();
ensure_user_columns($pdo);
ensure_task_columns($pdo);
ensure_mentor_students($pdo);

$current = require_active_user();
$role = $current['role'];
if (!in_array($role, ['mentor','admin'], true)) {
  json_out(['error' => 'Forbidden'], 403);
}

$action = $_GET['action'] ?? 'students';
$method = $_SERVER['REQUEST_METHOD'];
$mentorId = $role === 'admin' && isset($_GET['mentorId']) ? (int)$_GET['mentorId'] : (int)$current['id'];

if ($action === 'students' && $method === 'GET') {
  if ($role !== 'admin' && $mentorId !== (int)$current['id']) {
    json_out(['error' => 'Forbidden'], 403);
  }
  $sql = "SELECT s.id, s.username, s.email, s.status,
                 SUM(CASE WHEN t.done = 0 THEN 1 ELSE 0 END) AS open_tasks,
                 COUNT(t.id) AS total_tasks
          FROM mentor_students ms
          JOIN users s ON s.id = ms.student_id
          LEFT JOIN tasks t ON t.user_id = s.id
          WHERE ms.mentor_id = ?
          GROUP BY s.id, s.username, s.email, s.status
          ORDER BY s.username";
  $stmt = $pdo->prepare($sql);
  $stmt->execute([$mentorId]);
  $rows = $stmt->fetchAll();
  $students = array_map(function($row) {
    return [
      'id' => (int)$row['id'],
      'username' => $row['username'],
      'email' => $row['email'],
      'status' => $row['status'],
      'openTasks' => (int)$row['open_tasks'],
      'totalTasks' => (int)$row['total_tasks']
    ];
  }, $rows);
  json_out(['students' => $students]);
}

if ($action === 'availableStudents' && $method === 'GET') {
  // Admin can fetch additional students to assign.
  if ($role !== 'admin') {
    json_out(['error' => 'Forbidden'], 403);
  }
  $sql = "SELECT id, username, email FROM users WHERE role = 'student' AND status = 'active' ORDER BY username";
  $rows = $pdo->query($sql)->fetchAll();
  $students = array_map(function($row) {
    return [
      'id' => (int)$row['id'],
      'username' => $row['username'],
      'email' => $row['email']
    ];
  }, $rows);
  json_out(['students' => $students]);
}

if ($action === 'summary' && $method === 'GET') {
  if ($role !== 'admin' && $mentorId !== (int)$current['id']) {
    json_out(['error' => 'Forbidden'], 403);
  }
  $sql = "SELECT
            COUNT(DISTINCT ms.student_id) AS student_count,
            COUNT(t.id) AS total_tasks,
            SUM(CASE WHEN t.done = 0 THEN 1 ELSE 0 END) AS open_tasks,
            SUM(CASE WHEN t.done = 1 THEN 1 ELSE 0 END) AS completed_tasks
          FROM mentor_students ms
          LEFT JOIN tasks t ON t.user_id = ms.student_id AND t.assigned_by = ms.mentor_id
          WHERE ms.mentor_id = ?";
  $stmt = $pdo->prepare($sql);
  $stmt->execute([$mentorId]);
  $row = $stmt->fetch();
  json_out([
    'summary' => [
      'students' => (int)($row['student_count'] ?? 0),
      'tasksAssigned' => (int)($row['total_tasks'] ?? 0),
      'openTasks' => (int)($row['open_tasks'] ?? 0),
      'completedTasks' => (int)($row['completed_tasks'] ?? 0)
    ]
  ]);
}

json_out(['error' => 'Not found'], 404);
