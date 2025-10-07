<?php
/**
 * Database helpers shared by the PHP endpoints.
 */
require_once __DIR__ . '/config.php';

// Lazily create and reuse a PDO connection.
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

// Emit a JSON response with the given HTTP status and terminate.
function json_out($data, int $code = 200) {
  http_response_code($code);
  header('Content-Type: application/json');
  echo json_encode($data);
  exit;
}

// Safely decode the JSON body, returning an empty array when absent.
function read_json_body() {
  $raw = file_get_contents('php://input');
  $data = json_decode($raw, true);
  if ($raw && $data === null) json_out(['error' => 'Invalid JSON'], 400);
  return $data ?: [];
}

// Ensure legacy databases gain the new role and status columns.
function ensure_user_columns(PDO $pdo): void {
  static $ensured = false;
  if ($ensured) return;
  $cols = $pdo->query("SHOW COLUMNS FROM users")->fetchAll(PDO::FETCH_COLUMN, 0);
  if (!in_array('role', $cols, true)) {
    $pdo->exec("ALTER TABLE users ADD COLUMN role ENUM('student','mentor','admin') NOT NULL DEFAULT 'student' AFTER password_hash");
  }
  if (!in_array('status', $cols, true)) {
    $pdo->exec("ALTER TABLE users ADD COLUMN status ENUM('active','suspended') NOT NULL DEFAULT 'active' AFTER role");
  }
  if (!in_array('last_login', $cols, true)) {
    $pdo->exec("ALTER TABLE users ADD COLUMN last_login DATETIME NULL AFTER status");
  }
  $ensured = true;
}

// Ensure mentor/student relationship table exists for multi-user flows.
function ensure_mentor_students(PDO $pdo): void {
  $pdo->exec("CREATE TABLE IF NOT EXISTS mentor_students (
    id INT AUTO_INCREMENT PRIMARY KEY,
    mentor_id INT NOT NULL,
    student_id INT NOT NULL,
    created_at DATETIME NOT NULL,
    UNIQUE KEY uniq_mentor_student (mentor_id, student_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;");
}

// Add new task ownership columns for older schemas.
function ensure_task_columns(PDO $pdo): void {
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
  $cols = $pdo->query("SHOW COLUMNS FROM tasks")->fetchAll(PDO::FETCH_COLUMN, 0);
  if (!in_array('user_id', $cols, true)) {
    $pdo->exec("ALTER TABLE tasks ADD COLUMN user_id INT NULL AFTER id, ADD INDEX idx_tasks_user (user_id)");
  }
  if (!in_array('assigned_by', $cols, true)) {
    $pdo->exec("ALTER TABLE tasks ADD COLUMN assigned_by INT NULL AFTER user_id, ADD INDEX idx_tasks_assigned (assigned_by)");
  }
}

// Ensure the activity log table is present.
function ensure_activity_table(PDO $pdo): void {
  $pdo->exec("CREATE TABLE IF NOT EXISTS activity_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NULL,
    actor_email VARCHAR(255) NULL,
    actor_role ENUM('student','mentor','admin') NOT NULL,
    action VARCHAR(100) NOT NULL,
    description TEXT NULL,
    created_at DATETIME NOT NULL,
    INDEX idx_activity_user (user_id),
    INDEX idx_activity_action (action)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;");
}

// Retrieve a user row by identifier with the new metadata columns ensured.
function fetch_user(int $id): ?array {
  $pdo = db();
  ensure_user_columns($pdo);
  $st = $pdo->prepare("SELECT * FROM users WHERE id = ? LIMIT 1");
  $st->execute([$id]);
  $user = $st->fetch();
  return $user ?: null;
}

// Shared helper to require an authenticated, active user record.
function require_active_user(): array {
  if (empty($_SESSION['uid'])) {
    json_out(['error' => 'Unauthorized'], 401);
  }
  $user = fetch_user((int)$_SESSION['uid']);
  if (!$user) {
    session_destroy();
    json_out(['error' => 'Unauthorized'], 401);
  }
  if (isset($user['status']) && $user['status'] !== 'active') {
    json_out(['error' => 'Account suspended'], 403);
  }
  return $user;
}

// Record an activity for auditing and the super admin dashboard.
function log_activity(array $actor, string $action, ?string $description = null, ?int $subjectUserId = null): void {
  $pdo = db();
  ensure_activity_table($pdo);
  $role = isset($actor['role']) ? strtolower((string)$actor['role']) : 'student';
  if (!in_array($role, ['student','mentor','admin'], true)) {
    $role = 'student';
  }
  $now = gmdate('Y-m-d H:i:s');
  $st = $pdo->prepare("INSERT INTO activity_logs (user_id, actor_email, actor_role, action, description, created_at) VALUES (?,?,?,?,?,?)");
  $st->execute([
    $subjectUserId ?? ($actor['id'] ?? null),
    $actor['email'] ?? null,
    $role,
    $action,
    $description,
    $now
  ]);
}
// Determine if a mentor is linked to a given student.
function mentor_has_student(PDO $pdo, int $mentorId, int $studentId): bool {
  ensure_mentor_students($pdo);
  $st = $pdo->prepare('SELECT 1 FROM mentor_students WHERE mentor_id = ? AND student_id = ? LIMIT 1');
  $st->execute([$mentorId, $studentId]);
  return (bool)$st->fetchColumn();
}

// Ensure the mentor/student link exists, creating it on demand.
function ensure_mentor_link(PDO $pdo, int $mentorId, int $studentId): void {
  if (mentor_has_student($pdo, $mentorId, $studentId)) {
    return;
  }
  $st = $pdo->prepare('INSERT INTO mentor_students (mentor_id, student_id, created_at) VALUES (?,?,?)');
  $st->execute([$mentorId, $studentId, gmdate('Y-m-d H:i:s')]);
}
