CREATE TABLE IF NOT EXISTS msupply_requisition_lines (
    requisition_id text NOT NULL,
    line_id text NOT NULL,
    created_at timestamptz NOT NULL,
    requisition_number bigint NOT NULL,
    fields jsonb NOT NULL,
    imported_at timestamptz NOT NULL,
    PRIMARY KEY (requisition_id, line_id)
);
ALTER TABLE msupply_requisition_lines ADD COLUMN IF NOT EXISTS client_code text;
CREATE INDEX IF NOT EXISTS msupply_requisition_lines_period
    ON msupply_requisition_lines (created_at, requisition_number, line_id);
