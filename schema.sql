-- Database schema for the Student Task Manager application.
CREATE DATABASE IF NOT EXISTS stm_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE stm_db;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  username VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tasks (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
