<?php
// Database connection configuration with environment overrides.

define('DB_HOST', getenv('STM_DB_HOST') ?: 'localhost');
define('DB_NAME', getenv('STM_DB_NAME') ?: 'stm_db');
define('DB_USER', getenv('STM_DB_USER') ?: 'root');
define('DB_PASS', getenv('STM_DB_PASS') ?: '');
define('DB_CHARSET', 'utf8mb4');
