-- ═══════════════════════════════════════════════════
-- Battericentralen Service System — Database Schema
-- PostgreSQL (Supabase / Render / Neon)
-- ═══════════════════════════════════════════════════

-- Admin users (hashed passwords)
CREATE TABLE IF NOT EXISTS admin_users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name          VARCHAR(200),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Customers (minimum data per GDPR)
CREATE TABLE IF NOT EXISTS customers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(200) NOT NULL,
  phone       VARCHAR(30),
  email       VARCHAR(200),
  address     VARCHAR(300),
  zip         VARCHAR(10),
  city        VARCHAR(100),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ  -- Soft delete for GDPR
);

CREATE INDEX idx_customers_email ON customers(email) WHERE deleted_at IS NULL;
CREATE INDEX idx_customers_phone ON customers(phone) WHERE deleted_at IS NULL;

-- Machines
CREATE TABLE IF NOT EXISTS machines (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  brand       VARCHAR(100) NOT NULL DEFAULT 'Gaggia',
  model       VARCHAR(200) NOT NULL,
  model_code  VARCHAR(50),
  serial      VARCHAR(100),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_machines_customer ON machines(customer_id);
CREATE INDEX idx_machines_serial ON machines(serial) WHERE serial IS NOT NULL;

-- Service orders
CREATE TABLE IF NOT EXISTS orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_nr      VARCHAR(20) UNIQUE NOT NULL,
  customer_id     UUID NOT NULL REFERENCES customers(id),
  machine_id      UUID NOT NULL REFERENCES machines(id),
  status          VARCHAR(30) NOT NULL DEFAULT 'registered',
  description     TEXT,
  delivery_method VARCHAR(20), -- post, dropoff, partner
  fault_codes     TEXT[] DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_service_nr ON orders(service_nr);

-- Status history
CREATE TABLE IF NOT EXISTS status_history (
  id        SERIAL PRIMARY KEY,
  order_id  UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status    VARCHAR(30) NOT NULL,
  note      TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_status_history_order ON status_history(order_id);

-- Used parts per order
CREATE TABLE IF NOT EXISTS used_parts (
  id         SERIAL PRIMARY KEY,
  order_id   UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  part_nr    VARCHAR(50) NOT NULL,
  name       VARCHAR(200) NOT NULL,
  price      DECIMAL(10,2) DEFAULT 0,
  qty        INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_used_parts_order ON used_parts(order_id);

-- Work logs
CREATE TABLE IF NOT EXISTS work_logs (
  id          SERIAL PRIMARY KEY,
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  parts       TEXT,
  minutes     INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_work_logs_order ON work_logs(order_id);

-- Notifications (audit trail)
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID REFERENCES orders(id),
  customer_id UUID REFERENCES customers(id),
  type        VARCHAR(10) NOT NULL, -- sms, email
  recipient   VARCHAR(200) NOT NULL,
  subject     VARCHAR(500),
  message     TEXT NOT NULL,
  status      VARCHAR(30),
  sent_at     TIMESTAMPTZ DEFAULT NOW(),
  delivered   BOOLEAN DEFAULT FALSE,
  error       TEXT
);

CREATE INDEX idx_notifications_order ON notifications(order_id);

-- Stock levels (keyed by part number)
CREATE TABLE IF NOT EXISTS stock (
  part_nr   VARCHAR(50) PRIMARY KEY,
  qty       INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- GDPR audit log
CREATE TABLE IF NOT EXISTS gdpr_log (
  id         SERIAL PRIMARY KEY,
  action     VARCHAR(50) NOT NULL, -- data_export, data_delete, consent_given, consent_withdrawn
  subject_id UUID, -- customer id
  admin_id   INTEGER REFERENCES admin_users(id),
  details    TEXT,
  ip_address VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════
-- Initial admin user: admin / battericentralen2025
-- Hash generated with bcrypt (10 rounds)
-- Endre passord via API etter første innlogging!
-- ═══════════════════════════════════════════════════
-- INSERT will be done by server on first startup
